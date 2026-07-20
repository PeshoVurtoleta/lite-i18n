# @zakkster/lite-i18n

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-i18n.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-i18n)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-i18n?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-i18n)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-i18n?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-i18n)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-i18n?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-i18n)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=flat-square)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-i18n/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://github.com/PeshoVurtoleta/lite-signal)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE.txt)

> Zero-GC reactive internationalization built on `@zakkster/lite-signal`.
> Templates pre-compile to closures over stable token arrays; the hot path
> allocates nothing but the returned string. ~3.5 KB min+gz core, ~0.76 KB for
> the Intl formatter entry.

## The numbers

`t()` throughput vs the two most common runtime i18n libraries. Same
input, same output (correctness asserted before timing), same machine.
Node 22, 1M iterations after 100k warm-up.

| workload | **lite-i18n** | i18next | formatjs |
|---|---:|---:|---:|
| simple `{name}` interpolation | **7.9 Mops/s** | 0.14 Mops/s | 2.9 Mops/s |
| plural `{n, plural, one {…} other {…}}` | **2.3 Mops/s** | 0.18 Mops/s | 0.37 Mops/s |
| select `{g, select, male {…} other {…}}` | **17.4 Mops/s** | 0.34 Mops/s | 4.8 Mops/s |
| select + plural composition | **2.1 Mops/s** | 0.18 Mops/s | 0.34 Mops/s |

**3× to 6× faster than formatjs. 12× to 56× faster than i18next.**
Full methodology, re-runnable harness, and fairness caveats in
[`bench/`](./bench).

```
npm install @zakkster/lite-i18n
```

```js
import { defineMessages, locale, t, plural } from "@zakkster/lite-i18n";
import { effect } from "@zakkster/lite-signal";

defineMessages("en", {
    hello: "Hello, {name}!",
    items: { one: "{count} item", other: "{count} items" },
});

defineMessages("bg", {
    hello: "Здравей, {name}!",
    items: { one: "{count} артикул", other: "{count} артикула" },
});

effect(() => {
    console.log(t("hello", { name: "Zahary" }));
    console.log(plural("items", 3));
});
// -> Hello, Zahary!
// -> 3 items

locale.set("bg");
// -> Здравей, Zahary!
// -> 3 артикула
```

`t` and `plural` subscribe to the current locale AND the messages epoch. Any
effect or computed calling them re-runs synchronously when either changes --
no microtask queue, no scheduler, no allocation after warm-up.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [Architecture in one diagram](#architecture-in-one-diagram)
- [Message templates](#message-templates)
- [Pluralization](#pluralization)
- [Fallback chain](#fallback-chain)
- [Async loading](#async-loading)
- [Missing keys](#missing-keys)
- [Intl formatters](#intl-formatters)
- [Isolated instances](#isolated-instances)
- [Integration recipes](#integration-recipes)
- [Zero-GC discipline](#zero-gc-discipline)
- [FAQ](#faq)
- [npm scripts](#npm-scripts)

---

## Why this exists

Almost every reactive i18n library on npm does two things that break the
`@zakkster` frame budget:

1. **Parses templates on every read.** `i18next` and `formatjs` both walk the
   template string every time you call `t(...)`. At 60 fps across a HUD with
   50 translated strings, that is 3,000 parses per second, all of which
   produce transient garbage.
2. **Ships a microtask scheduler.** Signals-first libraries that layer i18n
   on top typically flush translations via `queueMicrotask`, so a `t(...)`
   call in a canvas render loop can't be reasoned about synchronously.

`lite-i18n` compiles every message once at `defineMessages` time into a
closure over a stable token array. The runtime lookup is:

1. `_locale()` -- one signal read, subscribes.
2. `_epoch()` -- one signal read, subscribes to defineMessages/setFallback changes.
3. `Map.get(locale).get(key)` -- one Map lookup, or a fallback walk.
4. Call the compiled fn.

Zero allocation except the produced string. And because it's built on
`lite-signal`, the reactivity flushes synchronously in the same call stack as
`locale.set(...)`.

---

## What you get

- **`t(key, params?)`** -- reactive translation lookup.
- **`plural(key, count, params?)`** -- sugar over `t` for plural-object dict entries.
- **`locale`** -- the current-locale signal. Read with `locale()`, mutate with `locale.set(...)`.
- **`defineMessages(locale, dict)`** -- register or extend a locale's dictionary.
- **`loadLocale(locale, loaderFn)`** -- async loader with in-flight dedup + error retry.
- **`ready(locale)`** -- reactive readiness signal for a locale.
- **`setFallback(chain)`** -- replace the fallback chain.
- **`setMissingKeyPolicy(policy)`** / **`onMissingKey(fn)`** -- missing-key behavior.
- **`createI18n(config)`** / **`setDefaultI18n(inst)`** -- isolated instances.
- **`stats()`** -- live snapshot for debugging.
- **`MissingKeyError`** -- thrown by the `'throw'` policy.

From `@zakkster/lite-i18n/format`:

- **`formatNumber`**, **`formatDate`**, **`formatList`**, **`formatRelativeTime`** -- convenience forms.
- **`numberFormat`**, **`dateFormat`**, **`listFormat`**, **`relativeTimeFormat`** -- factory forms (zero-alloc steady state).
- **`createFormatters(i18n)`** -- returns all eight bound to a specific instance.

Full type definitions ship in [`I18n.d.ts`](./I18n.d.ts) and [`Format.d.ts`](./Format.d.ts).

---

## Architecture in one diagram

Every message goes through `defineMessages` once and produces a compiled
entry -- a function `(params, locale, getPluralRules) => string` closed over
a stable token array. All entries have the same shape, so the call site is
monomorphic.

```
                       defineMessages(locale, dict)
                                  |
                                  v
                +-----------------------------------+
                |  flattenInto: dot-path expansion  |
                |  isPluralObj / tokenize / compile |
                +-----------------------------------+
                                  |
                                  v
              Map<locale, Map<key, (params, loc, getRules) => string>>

                                  ^
                                  |
                        t(key, params)  (reactive)
                                  |
       +----- _locale()   subscribes to current locale --------+
       +----- _epoch()    subscribes to defineMessages/setFallback +
                                  |
                                  v
                          lookup(key, locale)
                                  |
                                  v
                           entry(params, locale, getRules)
                                  |
                                  v
                              "Hello, Zahary!"
```

Compiled entries produce three token shapes:

- **Type 0 (literal)** -- `{ str: "Hello, " }`.
- **Type 1 (slot)** -- `{ key: "name" }`. Splices `params[key]` at runtime.
- **Type 2 (plural)** -- `{ variable, exact: Map<number, tokens>, variants: Map<selector, tokens> }`.

The `#` shortcut in plural sub-templates compiles to a type-1 slot pointing
at the plural variable. Sub-templates never contain nested plurals -- if you
need multi-axis plurals, split the message.

---

## Message templates

### Static

```js
defineMessages("en", { greet: "Welcome" });
t("greet"); // -> "Welcome"
```

Detected at compile time -- the compiled entry is a fn that returns the string
directly, no token loop.

### Interpolation

```js
defineMessages("en", { greet: "Hi, {name}! You have {count} tabs open." });
t("greet", { name: "Zahary", count: 42 });
// -> "Hi, Zahary! You have 42 tabs open."
```

`{name}` slots splice `params[name]` directly. Order in the template is
preserved. Numeric params are stringified via JS's `+` operator (fast). If
you forget to pass params, missing slots splice `undefined` -- there is no
strict-check mode by design.

### Nested dicts

Dicts can nest arbitrarily; keys flatten to dot-paths at define time so
runtime lookup is a single `Map.get`.

```js
defineMessages("en", {
    header: {
        title: "Welcome",
        subtitle: "Sign in below",
    },
    footer: { copyright: "(c) 2026" },
});
t("header.title");     // -> "Welcome"
t("footer.copyright"); // -> "(c) 2026"
```

A dict value is treated as a plural-object entry (see below) if it has an
`other` key and every other own-property key is either a CLDR selector
(`zero`, `one`, `two`, `few`, `many`, `other`) or an exact-match pattern
(`=0`, `=1`, ...). Otherwise it's a nested namespace.

### Escapes

Full ICU quoted-string mode. An apostrophe (`'`) followed by `{`, `}`, or
`#` opens a quoted section; the next unpaired apostrophe closes it. Inside a
quoted section `''` produces a literal apostrophe. Anywhere else `''` also
produces a literal apostrophe. Any other apostrophe is literal.

```js
defineMessages("en", {
    a: "Use '{name}' as a slot",     // -> "Use {name} as a slot"   (whole slot escaped)
    b: "'{' {name} '}'",              // -> "{ Zahary }"             (individual braces)
    c: "It''s fine",                  // -> "It's fine"              (doubled apostrophe)
    d: "It's fine",                   // -> "It's fine"              (bare apostrophe, literal)
});
```

Inside plural sub-templates the same rules apply, plus `'#'` produces a
literal `#` (since bare `#` is the count shortcut):

```js
defineMessages("en", {
    m: "{n, plural, one {'#' # item} other {'#' # items}}",
});
t("m", { n: 5 });   // -> "# 5 items"
```

### Missing params

Nullish slot values (`undefined`, `null`) render as an empty string. Both:

```js
i.t("greet");                        // params.name is undefined
i.t("greet", { name: null });        // explicit null (common from JSON)
```

produce the same output as `i.t("greet", { name: "" })`. This costs one
well-predicted branch per slot and prevents `"undefined"` from bleeding into
the DOM. Numeric zero (`0`) and empty string (`""`) render normally --
they're not nullish.

Slot reads use `Object.hasOwn`, so `{constructor}` won't leak the native
`Object` function and `{__proto__}` won't leak the prototype object -- they
just render as empty string like any other unpassed slot.

If you need strict-check behavior (throw or warn on missing slot), do it in
a validation pass at define time; the render loop stays cheap.

### Unsupported constructs fail loudly

lite-i18n implements `{slot}` and `{var, plural, ...}`. Every other ICU
argument shape is a compile-time `SyntaxError` at `defineMessages`:

```
{n, number}                    -> SyntaxError
{d, date, short}               -> SyntaxError
{gender, select, male {He} ...} -> SyntaxError
{n, plural, mnay {...} ...}     -> SyntaxError  (typo in selector)
```

Silent empty-string rendering was the worst kind of translator footgun --
no signal that the template was wrong. Now bad templates fail at define
time. For number/date/list/relative-time, reach for the Format entry
(`formatNumber`, `formatDate`, ...) instead of inline ICU.

---

## Pluralization

Two forms, both compile to the same token structure and share `Intl.PluralRules`
instances (one per locale, cached).

### Form 1 -- plural-object dict entries

```js
defineMessages("en", {
    items: {
        "=0": "no items",
        one: "{count} item",
        other: "{count} items",
    },
});
plural("items", 0);   // -> "no items"
plural("items", 1);   // -> "1 item"
plural("items", 42);  // -> "42 items"
```

`#` is a shortcut for `{count}`:

```js
defineMessages("en", { items: { one: "# item", other: "# items" } });
```

`plural(key, count, params?)` merges `count` into `params` (one small alloc
for the merged object per call) and calls the compiled entry. For hot loops,
prefer `t(key, params)` with `count` in `params` directly.

The plural-object form always uses `count` as the variable name. This is
deliberate -- it matches how translation-management systems (Crowdin,
Lokalise, Phrase) export plural entries and how `plural(key, count, params?)`
passes the count. If you need a custom variable name (`{apples, plural, ...}`
etc.), use the inline form below; the two are otherwise interchangeable.

### Form 2 -- inline ICU-lite

```js
defineMessages("en", {
    cart: "Cart: {count, plural, =0 {empty} one {# item} other {# items}}",
    activity: "{name} added {count, plural, one {# comment} other {# comments}}",
});
t("cart", { count: 0 });       // -> "Cart: empty"
t("cart", { count: 1 });       // -> "Cart: 1 item"
t("activity", { name: "Z", count: 7 });
// -> "Z added 7 comments"
```

The variable is named explicitly (`count` above -- could be `apples`, `n`,
whatever). Inline plural blocks compose with literal text and simple `{slot}`
interpolation in the same template.

### Locale-aware selection

Both forms consult `Intl.PluralRules` for the current locale, so:

- English: `one` / `other`
- Bulgarian: `one` / `other`
- Polish: `one` / `few` / `many` / `other`
- Arabic: `zero` / `one` / `two` / `few` / `many` / `other`

Provide the variants your target locales actually use. `other` is required in
every plural block -- a missing `other` throws `SyntaxError` at define time.

### Ambiguity: all-string namespaces with CLDR-shaped keys

A dict entry whose value is an object with only CLDR keys (`zero one two few
many other`) or exact patterns (`=N`), all pointing to strings, is
indistinguishable from a plural entry by shape alone. `defineMessages` treats
it as a plural.

```js
// This is treated as a plural entry, NOT a nested namespace.
defineMessages("en", {
    menu: { one: "Single player", other: "Multiplayer" },
});
t("menu.one");             // -> "menu.one" (key literal; menu.one doesn't exist)
plural("menu", 1);         // -> "Single player"
```

If you want two separate menu entries and their labels happen to collide with
CLDR selector names, disambiguate by giving the namespace a non-CLDR key, or
by naming the entries explicitly (`menu.solo`, `menu.multi`) rather than
`menu.one` / `menu.other`.

### Ordinal (`selectordinal`)

For "1st, 2nd, 3rd, 4th…" — same shape as `plural`, different rule set
under the hood (`Intl.PluralRules(locale, { type: "ordinal" })`, cached
separately from cardinal):

```js
defineMessages("en", {
    place: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} place",
});
t("place", { n: 1 });   // -> "1st place"
t("place", { n: 22 });  // -> "22nd place"
t("place", { n: 11 });  // -> "11th place"  (teens exception)
```

## Select

Non-plural branching on any string value — gender, role, tier, status,
whatever your template needs to switch on. Cheaper than plural at runtime
because there's no `Intl.PluralRules` dispatch; it's a `Map.get(key)` with
`other` fallback.

```js
defineMessages("en", {
    greet: "{gender, select, male {sir} female {ma'am} other {friend}}",
    role:  "{role, select, admin {A} owner {O} other {?}}",
});
t("greet", { gender: "female" });  // -> "ma'am"
t("role",  { role: "owner" });     // -> "O"
```

`other` is required (missing it throws `SyntaxError`). Selectors are bare
identifiers — no numeric `=N` form (that's plural-specific).

### Multi-axis composition

The canonical ICU pattern for messages that vary along more than one axis
(gender × count, tier × status, etc.):

```js
defineMessages("en", {
    m: "{gender, select, "
        + "male {He has {n, plural, one {# apple} other {# apples}}} "
        + "female {She has {n, plural, one {# apple} other {# apples}}} "
        + "other {They have {n, plural, one {# apple} other {# apples}}}}",
});
t("m", { gender: "male", n: 1 });   // -> "He has 1 apple"
t("m", { gender: "female", n: 5 }); // -> "She has 5 apples"
```

Arbitrary nesting of `plural` / `select` / `selectordinal` inside
sub-templates is supported. The comma-slot guard still rejects unsupported
ICU shapes (`{n, number}`, `{d, date, short}`, etc.) at compile time.

---

## Fallback chain

```js
const i = createI18n({
    locale: "bg",
    fallback: ["en"],  // string or array
});

i.defineMessages("en", { hi: "Hi", bye: "Bye" });
i.defineMessages("bg", { hi: "Здравей" });

i.t("hi");   // -> "Здравей"  (primary hit)
i.t("bye");  // -> "Bye"       (fallback hit)
```

Fallback walks the chain in order. If the active locale appears in the chain
it's silently skipped (no double-walk). Changing the chain via `setFallback`
bumps the reactivity epoch, so effects re-fire.

Defining messages for a locale that is *neither* active *nor* in the fallback
chain does NOT bump the epoch -- a common optimisation for lazy chunks that
belong to other locales.

---

## Async loading

```js
const i = createI18n({ locale: "en" });

// Load-once, cached, race-safe, retry-safe.
await i.loadLocale("bg", () =>
    fetch("/locales/bg.json").then(r => r.json())
);

i.locale.set("bg");
```

- Repeat calls for an in-flight locale share the same Promise.
- Already-loaded locales resolve immediately without invoking the loader.
- Loader errors clear the in-flight slot so callers can retry.
- On success, `defineMessages` runs (bumping the epoch if relevant) and the
  `ready(locale)` signal flips to `true`.

The readiness signal is the composable primitive:

```js
effect(() => {
    if (i.ready("bg")()) mountBgUI();
});
```

For repeated remote fetches with generation-guarded races (search-as-you-type
shape), reach for `@zakkster/lite-resource` instead -- `loadLocale` is
one-shot-per-locale by design.

Calling `ready(locale)` lazily creates a signal keyed by the locale string
and caches it for future reads. If your code produces an unbounded stream of
distinct locale strings (dynamic tenant IDs, unfiltered user input), the
map grows. In practice locale sets are small and stable; this only bites if
you feed `ready()` untrusted keys.

---

## Missing keys

Three policies, plus a hook:

| Policy   | Behavior                                                   |
| -------- | ---------------------------------------------------------- |
| `"key"`  | Return the missing key literal. **Default.**               |
| `"warn"` | `console.warn(...)` then return the key.                   |
| `"throw"`| Throw `MissingKeyError` (has `.key` and `.locale`).        |

```js
const i = createI18n({ missingKeyPolicy: "throw" });
i.t("nonexistent");  // throws MissingKeyError
```

The fallback chain is walked *before* the policy fires -- if any locale in
the chain has the key, that value wins.

`onMissingKey(fn)` runs before the policy. Returning a string short-circuits
and becomes the result. Returning `void` falls through to the policy.

```js
i.onMissingKey((key, locale) => {
    telemetry.send("i18n.missing", { key, locale });
    return `[${key}]`;   // sentinel visible in the UI
});
```

---

## Intl formatters

Live in a separate entry point so they tree-shake independently:

```js
import { formatNumber, formatDate, dateFormat } from "@zakkster/lite-i18n/format";
```

Each formatter reads the current locale from the default instance (or a
passed-in instance), so calling them inside an effect makes that effect
re-run on `locale.set(...)`.

### Convenience form

Hoist your opts to a module-level `const` for zero-alloc reuse:

```js
const EUR = { style: "currency", currency: "EUR" };

effect(() => {
    priceEl.textContent = formatNumber(price(), EUR);
});
```

The convenience form keys its Intl-instance cache on the opts object
identity via a `WeakMap`. Hoisted opts hit the same cached bucket; inline
opts (`formatNumber(v, { style: "currency" })`) rebuild the bucket on every
call -- fine for occasional use, bad in a 60 fps loop.

### Factory form -- true zero-alloc

For hot loops, use the factory:

```js
const priceFmt = numberFormat({ style: "currency", currency: "EUR" });

effect(() => {
    priceEl.textContent = priceFmt(price());
});
```

The factory closes over a `Map<locale, Intl.NumberFormat>` local to the
returned fn. No WeakMap lookup, no per-call alloc after the first call per
locale. The locale read still subscribes correctly.

**Instance capture:** the factory binds the i18n instance at *creation*
time -- not per call. If you hoist a factory at module scope and later swap
the default via `setDefaultI18n`, the factory keeps reading the ORIGINAL
instance's locale. For per-tenant / SSR flows, either build the factory
after the swap or pass the instance explicitly:

```js
const priceFmt = numberFormat(EUR, tenantI18n);   // bound to tenant
```

The convenience form (`formatNumber(v, opts)`) resolves the default each
call and does follow swaps.

### Full surface

| Convenience              | Factory                 | Backed by                  |
| ------------------------ | ----------------------- | -------------------------- |
| `formatNumber`           | `numberFormat`          | `Intl.NumberFormat`        |
| `formatDate`             | `dateFormat`            | `Intl.DateTimeFormat`      |
| `formatList`             | `listFormat`            | `Intl.ListFormat`          |
| `formatRelativeTime`     | `relativeTimeFormat`    | `Intl.RelativeTimeFormat`  |

All four accept an optional trailing `i18n` argument to bind against a
non-default instance. `createFormatters(i18n)` returns an object of all eight
already bound.

---

## Isolated instances

`createI18n(config?)` is the unit of isolation. Two instances share no state
-- separate locale signals, separate dicts, separate epoch counters, separate
`Intl.PluralRules` caches. Useful for tests, plugins, multi-tenant SDKs, and
SSR (one instance per request).

```js
const i = createI18n({
    locale: "en",
    fallback: "en",
    missingKeyPolicy: "warn",
    messages: {
        en: { hi: "Hi" },
        bg: { hi: "Здравей" },
    },
});
```

`setDefaultI18n(inst)` swaps the instance the top-level helpers (`t`,
`plural`, `locale`, etc.) route to. `locale` is exported as a live ESM
binding so importers see the new signal on their next reference; consumers
who destructure at import time capture the old one -- swap default first.

---

## Integration recipes

### Twitch Extension config sync

Config broadcasts trigger a locale change; every translated element in the
overlay re-renders synchronously:

```js
import { locale, defineMessages } from "@zakkster/lite-i18n";
import { batch } from "@zakkster/lite-signal";

defineMessages("en", { title: "Now Playing" });
defineMessages("bg", { title: "Сега свири" });

Twitch.ext.configuration.onChanged(() => {
    const cfg = JSON.parse(Twitch.ext.configuration.broadcaster?.content || "{}");
    if (cfg.locale) locale.set(cfg.locale);
});
```

### Reactive game HUD with rAF batching

```js
import { effect } from "@zakkster/lite-signal";
import { numberFormat } from "@zakkster/lite-i18n/format";

const scoreFmt = numberFormat({ notation: "compact" });

let frameQueued = false;
const raf = (run) => {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => { frameQueued = false; run(); });
};

effect(() => hud.draw(scoreFmt(score())), { scheduler: raf });
```

`scoreFmt` is a per-locale-cached fn -- zero alloc after the first frame per
locale. The effect re-fires on locale change AND score change; the scheduler
coalesces to one paint per frame.

### Per-tenant sandbox

```js
import { createI18n } from "@zakkster/lite-i18n";
import { createFormatters } from "@zakkster/lite-i18n/format";

function spawnTenant(cfg) {
    const i18n = createI18n({ locale: cfg.locale, messages: cfg.messages });
    // createFormatters binds each formatter to this specific instance,
    // avoiding the "factory captured the wrong default" footgun.
    const F = createFormatters(i18n);
    return { i18n, ...F };
}
```

Each tenant has its own locale signal, dicts, formatters, and PluralRules
cache. No cross-tenant re-render.

### Async chunk loading

```js
import { locale, loadLocale, ready } from "@zakkster/lite-i18n";
import { effect } from "@zakkster/lite-signal";

const localeChunks = {
    en: () => import("./locales/en.js"),
    bg: () => import("./locales/bg.js"),
    de: () => import("./locales/de.js"),
};

// Preload the initial one synchronously via ready() gating.
async function switchTo(loc) {
    await loadLocale(loc, async () => (await localeChunks[loc]()).default);
    locale.set(loc);
}

effect(() => {
    document.body.classList.toggle("i18n-loading", !ready(locale())());
});
```

---

## Zero-GC discipline

The library has three allocation checkpoints:

- **`defineMessages`** -- compilation is allocation-heavy by design (Map
  entries, token arrays, closures). Runs once per locale-key pair; not on the
  hot path.
- **`Intl.PluralRules(locale)`** -- one construction per unique locale used
  with a plural, cached forever. Amortises to zero.
- **`Intl` formatter construction** -- one per (opts identity, locale) pair
  for the convenience form; one per locale for the factory form. Amortises
  to zero if you hoist opts (convenience) or the factory (recommended).

The verified hot-path invariants -- from `test/06-zero-gc.test.mjs` under
`--expose-gc`:

| Workload                                                   | Retained heap |
| ---------------------------------------------------------- | ------------- |
| 100k `t()` calls with simple interpolation                 | < 200 KB      |
| 100k inline-plural `t()` calls                             | < 300 KB      |
| 100k `numberFormat` factory calls (steady-state)           | < 100 KB      |
| 1000 redefine-then-read cycles (recompilation churn)       | < 500 KB      |

The only unavoidable per-call allocation is the returned string itself.

---

## FAQ

**Why compile at `defineMessages` and not lazily on first read?**
The frame budget. A canvas render loop reads the same 50 keys 60 times per
second; parsing the template every call would inflate GC pressure by 60x.
Compilation at define time moves the cost off the hot path once and forever.

**Why isn't there a strict "params must include all slot keys" check?**
Because it would require a set intersection or a params-key walk on every
call. Splicing `undefined` at the miss site is the fastest correct behavior;
warnings belong in a lint step, not the render loop.

**Why the two-layer plural surface (`plural()` helper + inline ICU)?**
Ergonomics vs authoring. `plural()` with a `{one, other}` object shape is
what most translation-management systems export from Crowdin/Lokalise.
Inline ICU is what humans write when they want the count in the middle of a
sentence. Both compile to the same token structure, so the runtime cost is
identical.

**Can I use this with SSR?**
Yes -- create one instance per request via `createI18n(config)` and don't
touch `setDefaultI18n`. Since the library has no globals other than the
default instance and formatter caches, per-request instances are safe. The
formatter caches are keyed on WeakMap(opts), so they can share safely across
requests too.

**Why no ICU `select`/`selectordinal`?**
Scope. `select` is straightforward to add later without breaking the token
model (it's another type-2-shape node with a string-keyed variants map
instead of PluralRules dispatch). Ordinal plurals are one config change on
the `PluralRules` constructor. Both are candidates for v1.1 if the demand
shows up -- for now `plural`, exact matches, and inline ICU-lite cover 95%
of real-world message shapes at a fraction of the surface.

**Does `t()` allocate any garbage?**
The returned string, and only the returned string. Every intermediate --
token array, per-locale dict Map, PluralRules instance, compiled fn -- is
allocated once at define time and reused.

---

## npm scripts

```
npm test          # behavior suite, 95 tests
npm run test:gc   # heap-retention checks, requires --expose-gc, 4 tests
npm run verify    # test + test:gc
```

---

## License

MIT (c) Zahary Shinikchiev

---

> Part of the **@zakkster** zero-GC stack:
> [`lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal)
> * [`lite-store`](https://www.npmjs.com/package/@zakkster/lite-store)
> * [`lite-form`](https://www.npmjs.com/package/@zakkster/lite-form)
> * [`lite-router`](https://www.npmjs.com/package/@zakkster/lite-router)
> * [`lite-resource`](https://www.npmjs.com/package/@zakkster/lite-resource)
> * [`lite-persist`](https://www.npmjs.com/package/@zakkster/lite-persist)
> * [`lite-channel`](https://www.npmjs.com/package/@zakkster/lite-channel)
> * [`lite-element`](https://www.npmjs.com/package/@zakkster/lite-element)
> * [`lite-virtual`](https://www.npmjs.com/package/@zakkster/lite-virtual)
> * [`lite-scene`](https://www.npmjs.com/package/@zakkster/lite-scene)
> * [`lite-raf`](https://www.npmjs.com/package/@zakkster/lite-raf)
> * [`lite-time`](https://www.npmjs.com/package/@zakkster/lite-time)
