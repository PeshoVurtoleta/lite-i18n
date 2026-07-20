# Changelog

All notable changes to `@zakkster/lite-i18n` are documented here.

## 1.1.1 -- 2026-07-19 (review fixes)

### Fixed

- **`plural(key, count, params)` on inline templates whose plural variable
  is not named `count` now merges under the correct name.** Previously,
  `plural("files", 1)` on `"{n, plural, one {# file} other {# files}}"`
  returned `" files"` (wrong count, wrong form, no error). Fix: compiler
  scans top-level tokens for the outermost plural / selectordinal and
  tags the entry with `.pluralVar`; `plural()` merges under that name.
  Plural-object entries stay tagged with `"count"` per the implicit
  convention. Ambiguous templates (multiple different plural variables
  at top level) fall back to `"count"` and should use `t()` with explicit
  params.
- **Non-string dict values are no longer silently dropped.**
  `defineMessages` now `console.warn`s when a value is neither a string
  nor a plain object (numbers, arrays, null, undefined, functions,
  symbols, bigints). Typos that used to lose keys with zero feedback now
  surface at define time.
- **Improved plural selector error surface.** `{n, plural, many2 {...}}`
  and similar typos previously hit
  `Expected '{' after plural selector "many"` because the accumulator
  stopped at the digit. Now the accumulator reads letters + digits +
  underscore after the first letter, so `many2` reaches the intended
  `Unknown plural selector "many2" ... Valid selectors: zero, one, two,
  few, many, other, or =N.` error.
- **`Format.js` guards against partial Intl.** Environments missing
  `Intl.ListFormat` or `Intl.RelativeTimeFormat` used to fail with
  `"IntlCtor is not a constructor"` at first call. Now the getter throws
  a named error at first use naming the missing constructor and
  suggesting `@formatjs/intl-listformat` /
  `@formatjs/intl-relativetimeformat` as polyfills.

### Documented

- **All-string namespaces with CLDR-shaped keys are treated as plural
  entries.** A dict entry like `{ one: "Single", other: "Multiplayer" }`
  is shape-indistinguishable from a plural; the ambiguity is inherent
  and now called out in the README's Pluralization section with a
  disambiguation recipe. Torture test (`08-torture.test.mjs`) pins the
  current behavior so any future change to `isPluralObj` breaks visibly.
- **Literal dotted keys collide with nested paths under insertion order
  wins.** `{ "a.b": "LITERAL", a: { b: "NESTED" } }` -> `"NESTED"`.
  Documented in `flattenInto`'s header.
- **Per-locale Intl caches in factory-form formatters grow unbounded.**
  Fine for a bounded locale set; per-request contexts should use
  `createI18n()`-scoped instances so caches die with the request.
  Documented in `Format.js`'s `makeCache` header.

### Infrastructure

- `.gitignore` added (excludes `node_modules/`, `bench/node_modules/`,
  coverage, editor/OS crud).
- `.github/workflows/ci.yml` runs behavior + zero-GC stress suites on
  Node 18/20/22 with an Intl-coverage probe.
- `package.json` aligned with the `@zakkster/lite-*` convention:
  `author` and `bugs.email` carry `shinikchiev@yahoo.com`, `funding`
  points to the GitHub sponsors page, `devDependencies` mirrors the peer.

## 1.1.0 -- 2026-07-19

### Added

- **`select`**: ICU-style non-plural branching on any string param.
  ```
  {gender, select, male {He} female {She} other {They}}
  ```
  Cheaper than plural at runtime (no `Intl.PluralRules` dispatch -- pure
  `Map.get(key)` with `other` fallback). Missing `other` throws
  `SyntaxError` at define time. Selectors are unrestricted bare identifiers.

- **`selectordinal`**: ordinal-category plural rules for "1st, 2nd, 3rd, ...".
  Same shape as `plural`, uses
  `Intl.PluralRules(locale, { type: "ordinal" })` under the hood. Cached
  separately from cardinal rules, reported via `stats().ordinalRulesCached`.

- **Arbitrary nesting in sub-templates**. The unsupported-shape guard is
  preserved (`{n, number}` still throws), but `select`, `selectordinal`,
  and `plural` compose freely inside each other. Enables the canonical
  multi-axis message pattern:
  ```
  {gender, select, male {He has {n, plural, one {# apple} other {# apples}}} ...}
  ```

- **`bench/`**: comparison harness against `i18next` and
  `intl-messageformat`. 4 workloads × 3 libraries × 1M iterations,
  correctness-asserted before timing.

- **Torture test suite** (`test/08-torture.test.mjs`, 40 tests): unicode
  edge cases (ZWJ family emoji, RTL, combining marks, surrogate pairs,
  ZWSP); regex-eating templates (slot named `plural`/`select`, literal
  `plural,` in text, empty `{}`); parser corners (100-level nested dict,
  1000-slot template, `=0..=50` exacts, malformed `=-1`); runtime numeric
  edges (negative counts using `|n|`, `Infinity`/`NaN`, `1e20`, BigInt
  spec-throw); degenerate params (null-prototype, frozen, throwing getter,
  Symbol keys, `__proto__` hasOwn-guarded, prototype pollution safety);
  reactive edges (locale.set inside effect, nested effects, onMissingKey
  non-recursion, fallback self-reference); async torture (10 parallel
  loads, mid-flight switch, reentrant loader); three-argument composition
  (`select > selectordinal > plural`).

- **Stress tests** (`test/06-zero-gc.test.mjs`, 7 tests, `--expose-gc`):
  1M `t()` simple, 1M inline-plural, 1M select, 500k composition,
  100k `numberFormat` factory, 1000 redefine cycles, 100k locale-switch
  cycles. All under conservative retained-heap ceilings.

- **Demo scene 5**: interactive select + selectordinal + composed
  three-axis renderer with a live `stats()` readout showing the two
  cache maps stay independent.

### Changed

- Argument-detection regex widened to accept `plural`, `selectordinal`,
  and `select` in one alternation.
- Internal `getPluralRules` renamed to `getRules(locale, ordinal)`;
  instance handle `_getRules` routes between cardinal and ordinal caches.
- `stats()` now reports `ordinalRulesCached` alongside `pluralRulesCached`.
- Both tokenizers route through a shared `parseArgument(inner)`, so
  nested argument blocks parse identically at any depth.

### Size

- Core `I18n.js`: 3.3 KB min+gz (v1.0.0 was 3.1 KB). +~300 B for select
  + selectordinal + shared `parseArgument`. Under the 4 KB roadmap budget.
- Format entry unchanged at ~0.6 KB.

### Non-breaking

Every template that compiled in v1.0.0 compiles the same in v1.1.0 with
identical output. Templates that threw `SyntaxError` for `{g, select, ...}`
now compile. No output shape changed.

## 1.0.0 -- initial release

The full core surface. Compile-at-defineMessages, closure-over-token-array
runtime, zero-GC after warm-up. Peer dep on `@zakkster/lite-signal ^1.4.0`.

### Core (`@zakkster/lite-i18n`)

- **Translation**: `t(key, params?)` and `plural(key, count, params?)` --
  both reactive, both subscribe to the current locale and the messages
  epoch, both call the compiled entry via a monomorphic `(params, locale,
  getRules) => string` interface.

### Message DSL

- **Static strings**, `{slot}` **interpolation**, **nested dicts** (dot-path
  flattened at define time), **plural-object entries** (`{ one, other, =0,
  ... }`), **inline ICU-lite plurals** (`{n, plural, one {# item} other {#
  items}}`), and mixed literals + slots + plural blocks in the same template.
  Missing `other` variant -> `SyntaxError` at define time.
- **ICU quoted-string escapes**: an apostrophe before `{`, `}`, or `#` (in
  sub-templates) opens a quoted section; the next unpaired apostrophe closes
  it. `''` produces a literal apostrophe everywhere. Bare apostrophes are
  literal. `'{name}'` produces literal `{name}` (whole-slot escape), `'{'`
  produces literal `{`, `'#'` (sub-template only) produces literal `#`.
- **Nullish slot coalesce**: `undefined` and `null` param values render as
  `""` instead of the string `"undefined"`. One well-predicted branch per
  slot on the hot path.

### Reactive signals

- `locale` (current locale, ESM live binding at top-level), `ready(locale)`
  (readiness of a locale dict), and an internal `_epoch` that bumps on
  `defineMessages` (for active or fallback locales) and `setFallback`.

### Runtime behaviors

- **Fallback chain**: array of locales, walked in order on miss; active locale
  skipped if listed; defining messages for a locale NOT in `[active,
  ...chain]` does NOT bump the epoch (avoids spurious re-fires for lazy
  chunks belonging to other locales).
- **Async loading**: `loadLocale(locale, loaderFn)` with in-flight dedup
  (same locale in flight -> same Promise), already-loaded resolve-immediate,
  and error retry (failed loads clear the in-flight slot).
- **Missing-key policy**: `"key"` (default, return literal), `"warn"`
  (`console.warn` + return literal), `"throw"` (throw `MissingKeyError`).
  `onMissingKey(fn)` hook runs first; returning a string short-circuits.
- **Invalid PluralRules locale**: caught and logged via `console.warn` once
  per bad locale (cached), then falls back to the environment default.
  Uncoupled from the missing-key policy -- these are different failure modes.
- **Instance isolation**: `createI18n(config)` for isolated worlds; multiple
  instances share nothing (separate signals, dicts, PluralRules caches).
  `setDefaultI18n(inst)` swaps the instance used by top-level helpers.
- **Diagnostics**: `stats()` snapshot -- `locales`, `keys`, `currentLocale`,
  `fallback`, `pluralRulesCached`, `loadsInFlight`.
- **Errors**: `MissingKeyError` (has `.key` and `.locale`).

### Format entry (`@zakkster/lite-i18n/format`)

- **Convenience form**: `formatNumber`, `formatDate`, `formatList`,
  `formatRelativeTime`. WeakMap(opts) -> Map<locale, Intl.Formatter> cache
  -- zero-alloc when opts is hoisted, per-call Intl construction when opts
  is inlined (correctness preserved, no memory leak).
- **Factory form**: `numberFormat`, `dateFormat`, `listFormat`,
  `relativeTimeFormat`. Returns a `(value) => string` closure over a
  per-locale Map<locale, Intl.Formatter> cache. Zero-alloc unconditionally
  after the first call per locale. Recommended for hot loops.
- **`createFormatters(i18n)`**: bulk binder returning all 8 formatters
  bound to a specific instance.

### Tests

99 total: **95 behavior** (`npm test`) + **4 zero-GC** (`npm run test:gc`,
`--expose-gc`). Coverage by file:

- `01-core.test.mjs` -- 43 tests: static/interpolation/nested dicts,
  ICU quoted-string escapes (`'{'`, `'}'`, `''`, whole-slot `'{name}'`,
  bare apostrophes stay literal, top-level `'#'` dequotes to match
  sub-templates), nullish-coalesce on slots (undefined, null, empty string,
  numeric zero), missing-key policies, `onMissingKey` hook,
  invalid-PluralRules-locale warn (fires once, cached), instance isolation,
  `config.messages` preload, `setDefaultI18n`, `MissingKeyError`,
  unmatched-brace `SyntaxError`, unsupported-ICU-argument `SyntaxError`
  (`{n, number}`, `{d, date, short}`, `{g, select, ...}`),
  unknown-plural-selector `SyntaxError` (typos), atomic `defineMessages`
  (bad template mid-batch rolls back), prototype-chain param safety
  (`{constructor}` renders `""`), nested-namespace-named-`other` no longer
  misclassified as plural.
- `02-plural.test.mjs` -- 21 tests: plural-object entries (one/other, `#`
  shortcut, exact matches, missing-other fallback to nested dict, `'#'`
  escape), inline ICU (basic, mixed, exact-wins, nested slot references,
  custom variable names, `'{'` and `'#'` escapes inside sub-templates),
  locale-aware selection across en/bg/pl/ar.
- `03-fallback.test.mjs` -- 8 tests: chain walk order, active-locale skip,
  `setFallback` epoch bump, effect re-fires, non-fallback locale doesn't
  re-fire.
- `04-async.test.mjs` -- 13 tests: `loadLocale`, `ready` signal, in-flight
  dedup, already-loaded fast path, error retry (inflight slot cleared),
  non-object loader return -> `TypeError`, reactive readiness effect,
  synchronous-throw-in-loader retry (defers via `Promise.resolve().then`),
  synchronous `JSON.parse` throw retry, `_loadPromises` cleared on success
  (`stats().loadsInFlight` is 0 after settled loads).
- `05-format.test.mjs` -- 12 tests: all 4 formatters, locale-switch
  reactivity, factory form, explicit-instance arg, `createFormatters` bulk
  binder.
- `06-zero-gc.test.mjs` -- 4 tests: retained heap ceilings verified via
  `--expose-gc`.

### Verified zero-GC properties

Under `--expose-gc`, warmed to 10k iterations then measured over 100k:

- 100k `t()` calls with `{name}` + `{count}` interpolation: < 200 KB retained.
- 100k inline-plural `t()` calls: < 300 KB retained.
- 100k `numberFormat` factory calls (currency, steady-state): < 100 KB retained.
- 1000 redefine-then-read cycles: < 500 KB retained.

The only unavoidable per-call allocation is the returned string itself.
