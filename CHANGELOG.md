# Changelog

All notable changes to `@zakkster/lite-i18n` are documented here.

## 1.0.0 -- initial release

The full core surface. Compile-at-defineMessages, closure-over-token-array
runtime, zero-GC after warm-up. Peer dep on `@zakkster/lite-signal ^1.4.0`.

### Core (`@zakkster/lite-i18n`)

- **Translation**: `t(key, params?)` and `plural(key, count, params?)` --
  both reactive, both subscribe to the current locale and the messages
  epoch, both call the compiled entry via a monomorphic `(params, locale,
  getPluralRules) => string` interface.
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
