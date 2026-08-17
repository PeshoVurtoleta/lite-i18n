# Changelog

All notable changes to `@zakkster/lite-i18n` are documented here.

## 1.2.0 -- 2026-08-16 (bounded caches + eviction)

Every per-locale structure was unbounded and nothing ever released one. The
three fail in OPPOSITE directions, so they take DIFFERENT policies -- see
`decisions/0003-locale-bounds.md` for the full argument and the
eviction-equivalence proof that licenses the split.

### Fixed

- **I-03 (process-fatal): `ready()` exhausted lite-signal's process-wide node
  pool.** Each distinct locale string lazily minted and permanently cached one
  lite-signal; at ~1020 distinct strings the shared 1024-node pool threw
  `CapacityError`, and then `createI18n()` itself threw -- every signal in every
  lite-* package in the process, dead. Locale strings ARE untrusted input.
  Fixed: the readiness cache fails **closed** at `LOCALE_CACHE_MAX` (256) with a
  NAMED `LocaleCapacityError` (naming the locale and the ceiling) whose blast
  radius is the INSTANCE, not the process. A signal carries subscriber identity,
  so it is never silently evicted; the rejected shared-singleton and LRU designs
  both break the documented ready-before-load idiom (measured; four identity
  tests pin the contract). The call-site fix is `resolveLocale` (below) -- the
  ceiling is a backstop, because a per-instance bound alone does not stop four
  tenants at 256 from oversubscribing the pool (arithmetic in 0003).
- **I-04 (silent): `_pluralRules` / `_ordinalRules` grew without bound** keyed on
  the raw untrusted locale, but ONLY when a fallback chain is configured -- the
  correction that changes the test. Measured on 1.1.4: 3000 distinct locales with
  `fallback:"en"` cached 3000 ICU-backed `Intl.PluralRules` forever; the SAME
  3000 with NO fallback cached 0 (the key misses before `getRules` runs). A test
  written from the no-fallback row passes against a fully broken cache, so both
  rows are asserted by name. Fixed: FIFO eviction at `LOCALE_CACHE_MAX`, NO throw
  -- the entries are pure `(locale, type)` memos, so a reconstructed entry renders
  byte-identically (proven by an eviction-equivalence test) and a throw would
  convert a leak into an SSR outage. FIFO, not LRU: LRU needs recency bookkeeping
  on every cache HIT, which is the hot path.
- **I-12 (no eviction API): a compiled dict, once defined, lived for the life of
  the instance.** Added `unloadLocale(loc)` -- drops the dict, both rules memos
  and the readiness signal (dropped from the map and then set false, so a
  subscriber holding the reference sees the transition while a re-entrant
  `ready()` re-mints a fresh signal); unloading the active/fallback locale is
  permitted and bumps the
  epoch so every observer re-renders through the fallback chain. Added `clear()`
  -- releases every dict, compiled entry, cached rule, readiness signal and
  in-flight load and zeroes the counters, keeping the locale/fallback/policy
  configuration. `stats()` gains `readySignalsCached`, `retiredLocales`,
  `warningsSuppressed`. **Limitation, stated rather than discovered:** releasing
  a readiness signal drops it from the cache but does NOT return its node to
  lite-signal's pool -- reclamation there needs an explicit `dispose`, which is
  unsafe while a subscriber may hold the signal. A `clear()`-then-repopulate
  loop burns fresh pool nodes per cycle (bounded per cycle, not cycle-stable).
  `decisions/0003-locale-bounds.md` records why, and a future session needing
  cycle-stable reclamation must settle safe disposal in lite-signal first.
- **I-19 (log-flood): warn-once-per-tag was not rate limiting when the tag is
  untrusted.** 500 distinct invalid `Accept-Language` tags produced 500
  `console.warn` calls. Fixed: a per-instance `WARN_BUDGET` (32) caps the
  warnings and counts the rest in `stats().warningsSuppressed` -- rate-limit on a
  fixed budget, not on the varied input.

### Added

- **`resolveLocale(requested, supported)`** -- BCP 47 prefix matching (exact ->
  request truncation -> reverse prefix, case-insensitive; no RFC 4647 lookup
  tables), returning the matching supported entry or `undefined`. This is the fix
  AT THE CALL SITE: it bounds an untrusted stream of locale strings to the app's
  own list, so the per-locale caches only ever see vouched-for values.
- **`LocaleCapacityError`** (with `.locale` and `.ceiling`) and the
  **`LOCALE_CACHE_MAX`** constant, both exported and declared in `I18n.d.ts`.

### Hot path

`t()` and `plural()` take ZERO new instructions -- every bound is checked in a
cache-MISS branch (`getRules`' miss already builds an Intl object) or in
`ready()` (not hot). Re-measured under the pinned semi-space: the six Q2 ceilings
are **bit-identical** to `baseline.json` -- static 0/4, slot 23/27, plural 46/50,
select 0/4, selectordinal 46/50, `plural()` 100/104. Q1 (`maxBytesPerCall:0`) and
Q3 (`maxMajor:0`) unchanged.

### Tests (prove-both-directions)

Every new assertion in `test/11-locale-bounds.test.mjs` (26 tests) was run against
the pre-fix code (`git show 5d271ef:I18n.js`) and shown to FAIL. Recorded output:

```
FAIL export resolveLocale exists            -- typeof = undefined
FAIL export LocaleCapacityError exists      -- typeof = undefined
FAIL export LOCALE_CACHE_MAX exists         -- typeof = undefined
FAIL I-04 row2 pluralRulesCached <= 256     -- actual = 1000
FAIL stats().readySignalsCached exists      -- value = undefined
FAIL ready() throws LocaleCapacityError     -- grew unbounded past 256, no named error
FAIL I-19 warnings capped <= 32             -- actual warns = 300
FAIL I-19 warningsSuppressed counted        -- warningsSuppressed = undefined
FAIL unloadLocale exists                    -- typeof = undefined
FAIL clear exists                           -- typeof = undefined
```

The pre-fix cache measurements that motivate the fix (same tree): I-04 with a
fallback cached **3000** rules and rendered `"2 items"`; the SAME run with NO
fallback cached **0** and rendered the literal `"p"`; a `selectordinal` template
doubled the surface (**1000 cardinal + 1000 ordinal**); the warn flood produced
**500** `console.warn` calls. Post-fix: 256 / 0 / 256+256 / 32-warns-plus-468-
suppressed. The `ready()` identity contract passes pre-fix too (by design -- it
fences the rejected shared-singleton OUT, it does not prove a bug fixed).

### Torture

- T4 (lifecycle) and T8 (cross-surface + lite-signal pool budget) filled; T7
  (soak) extended with an `unloadLocale` churn and the new `stats()` fields; T9
  gains controls **7** (defeat `_pluralRules` eviction via a `Map.prototype.delete`
  stub -> T4/T7 conservation goes red) and **8** (defeat the `_readySignals`
  ceiling via a `Map.prototype.size` stub -> T8 pool budget goes red). Both break
  REAL library code in the shipped path, never a replica. `I18N_TORTURE_BREAK=1`
  now trips 9/9 controls (was 7/7).

### Size budget (moved deliberately)

The `I18n.js` gzipped-SOURCE budget moved **10240 -> 13312 B** (`test/size.mjs`).
Measured with the gate's own method (`zlib` level 9), so the numbers are
re-derivable:

| | gzipped source | code only (comments stripped) |
| --- | --- | --- |
| `5d271ef` (v1.1.4) | 8943 B | 4637 B |
| v1.2.0 | 11718 B | 5410 B |
| growth | **+2775 B** | **+773 B** |

"Comments stripped" = remove `/* */` blocks, drop whole-line `//` comments,
collapse the resulting blank-line runs; a different stripper gives different
absolute numbers, so the method travels with the figure. (The first draft of
this note read 8974/11653 -- it was measured at gzip's default level rather than
level 9, and qa caught the drift.)

The gate measures SOURCE, not min+gz, and only **+773 B of the growth is code**
-- proportionate for `resolveLocale` + `unloadLocale` + `clear` +
`LocaleCapacityError` + bounded caches + eviction + the warn budget + three
`stats()` fields. **72% of the gzipped growth is docstrings**, which suite law
mandates and which minify to zero shipped bytes. Shrinking comments to fit a
source-bytes proxy would optimize the measurement, not the artifact (the I-10
pathology), so the budget moved instead: 13312 B is the measured 11718 + ~14%
headroom, matching the proportional margin the old 10240 held over its
measurement. The metric's blind spot (it taxes comment density and cannot verify
the README's ~3.5 KB min+gz claim) is filed as **I-20** (roadmap S3, assigned
I7). A trivial dedup landed alongside:
`internalDefine` now reuses `localeAffectsResolution` instead of re-inlining the
active/fallback scan.

### Known issues / deferrals

- **I-14: the lite-leak retention witness is STILL deferred.** Re-checked at I2:
  `npm i -D @zakkster/lite-leak` fails ERESOLVE -- `@zakkster/lite-leak@1.8.1`
  peer-requires `@zakkster/lite-signal >=1.5.0-beta.3 <2.0.0`; the registry's
  latest lite-signal is 1.4.3 (installed 1.4.0) and no 1.5.x exists, so the peer
  cannot be satisfied. lite-leak is NOT in `devDependencies`. T7 ships the
  structural-conservation half plus the T4/T8 pool-budget assertions; the second
  (retention) witness waits on a compatible lite-signal.
- **I-05** (async load overwrites a later synchronous define) remains open, owned
  by I3. `clear()`-with-a-load-in-flight documents the same write-race honestly
  rather than papering over it.

## 1.1.4 -- 2026-08-15 (security fix)

### Fixed

- **I-01 (security-relevant): `Object.prototype` could choose which variant
  rendered.** The type-1 slot read was guarded by `Object.hasOwn`, but the three
  SELECTOR reads were bare `params[key]`: the `{var, plural, ...}` /
  `{var, selectordinal, ...}` variable, the `{var, select, ...}` variable, and
  the plural-object `count`. So a single assignment to `Object.prototype` changed
  the SENTENCE that rendered, not a value inside it -- `Object.prototype.gender =
  "male"` turned `"They"` into `"He"`; `.count = 1` turned `" items"` into
  `" item"` (with no number, since `#` is a guarded slot, making the corruption
  harder to spot). **Plural-object entries -- the TMS-export shape -- were
  affected too.** This shipped in 1.1.2 and 1.1.3. Fixed with one `Object.hasOwn`
  per selector read (the same well-predicted branch a slot already pays); an
  absent selector resolves to the `other` variant, unchanged from before -- a fix
  with no new policy. Every own-property call renders byte-identically to before.
  The Q2 allocation ceilings are unmoved (the guard reads an own property and
  allocates nothing; `select` stayed at 0 scavenges/1M). See
  `decisions/0002-selector-reads.md`.
- **I-02: the prototype-pollution tests that named the hazard now exercise it.**
  `test/08-torture.test.mjs`'s two pollution tests tested only type-1 slots and
  stayed green across two minor versions while I-01 shipped. They now cross every
  read site (slot, select, plural, selectordinal, plural-object, and a nested
  composition). Both failed on 1.1.3 and pass on 1.1.4; the pre-fix failure
  output is recorded in the session notes. The full 6x4 identity matrix (six read
  sites x own / inherited / null-proto / Proxy) is pinned in
  `test/torture/t2-identity.mjs` (T2), and T9 gains a control (control 6) that
  reverts one guard and asserts T2 catches it.

### Changed

- **I-17: the published `MessageParams` type drops `bigint`.** A bigint renders
  in a `{slot}` (`10n -> "10"`) but throws `TypeError: Cannot convert a BigInt
  value to a number` out of `Intl.PluralRules.select` when it reaches a plural
  variable. The declaration and the runtime disagreed. The type was narrowed
  (`Record<string, string | number | boolean>`) rather than coercing at the
  selector, because coercion is entangled with the out-of-scope I-08
  `=N`-vs-category string-count asymmetry and would be a hot-body change. Runtime
  behaviour is unchanged (bigint count still throws, pinned by test); only the
  type moved. Reasoning in `decisions/0002-selector-reads.md`.
- **I-09: the read-path throw surface is pinned.** One named test per row in
  `test/08-torture.test.mjs`: own Symbol value (slot `TypeError`, select `other`,
  plural `TypeError`), throwing getter (propagates at every site), throwing
  `toString` (propagates, slot only), own BigInt (slot renders, plural throws),
  string `count: "1"` (matches `one`, I-08 territory pinned as-is),
  `undefined`/`null`/string/number/array params (slot `""`, selectors `other`),
  and null-prototype own property (honoured everywhere).

### Added

- **I-16: `VERSION` is declared in `I18n.d.ts`.** I0 exported `VERSION` from the
  runtime but the declaration file never had it, so `tsc` consumers could not see
  it and the three-place version sync was two places for anyone on types. Added
  `export const VERSION: string;` and a version-sync test
  (`test/10-version-sync.test.mjs`, run under `npm test` / `npm run verify`) that
  asserts the runtime `VERSION` equals `package.json`, the `.d.ts` declares the
  symbol, and `llms.txt` carries the string -- so the gap cannot reopen at the
  next bump.

## 1.1.3 -- 2026-08-15 (instrumentation)

Instrumentation-only. No change to the read, compile, or dispatch paths; the
sole source edit to `I18n.js` is the added `VERSION` export.

### Added

- **`VERSION` export** from `I18n.js` (I-11). Three-place version sync now
  holds: `package.json`, the `VERSION` const, and `llms.txt` move together.
- **Torture suite** (`test/torture.mjs`, `npm run torture`): ten tiers on the
  lite-bvh shape. This session wires T0 (metamorphic laws), T1 (degenerate
  params + counts, with the I-08/I-09 answers pinned), T3 (compile storm +
  fail-loud corpus + define-atomicity), T6 (the allocation gate), T7 (soak +
  cache conservation), and T9 (controls). T2/T4/T5/T8 are registered empty for
  later sessions. `node --expose-gc test/torture.mjs` prints exactly `ok`.
- **The allocation gate settled** (`decisions/0001-measurement.md`). Which
  instrument answers which question, each proven against a control that must
  fail it:
  - **Q1 retention** -- `measureAllocs`, `maxBytesPerCall: 0`. The five pure
    reads retain nothing; a `keep.push({a:1})` control reports 32 B/call and
    fails.
  - **Q2 transient** -- minor-GC (scavenge) count per 1M ops under a PINNED
    new-space (`torture.mjs` re-execs with `--min-semi-space-size` ==
    `--max-semi-space-size`, which makes the count bit-identical across reps on
    one machine -- zero within-fingerprint variance, ~+/-1 cross-observer -- and
    position-independent through the tier sequence), in an isolated `GcProfiler`
    window. Committed per-shape ceilings in `test/torture/baseline.json`
    (measured: static/select 0, slot 23, plural/selectordinal 46; ceilings are
    measured+4) plus the `plural()` calibration number (100 scavenges/1M,
    ceiling 104) -- the instrument seeing the known-allocating params-merge in
    the `plural()` body. The gate resolves the smallest realistic regression (one
    un-hoisted per-call object) as +8 scavenges/1M and fails it. Two earlier
    drafts were wrong -- one concluded Q2 was ungateable "by escape analysis"
    (the object is genuinely allocated; the sampler was under-sampling), the
    other recorded the numbers at default flags (~half these, and
    position-dependent). The corrected story is in the decision record.
  - **Q3 pause** -- `checkNoGc`, `maxMajor: 0`, `maxPauseMs: 4` over 1e6 `t()`.
- **Size gate** (`test/size.mjs`, `npm run size`, I-13): fails if the gzipped
  source of `I18n.js` or `Format.js` exceeds its budget.
- **Known-issue reproductions** as `todo` tests (`test/09-known-issues.test.mjs`)
  for I-01, I-03, I-05. Each asserts the post-fix expectation and flips green
  when the owning session fixes it.

### Known issues (recorded, not fixed this release)

- **I-01 (S1): prototype pollution can select a plural/select variant.** The
  `select` selector and the plural/selectordinal variable are bare
  `params[t.variable]` reads with no `Object.hasOwn` guard, so
  `Object.prototype.gender = 'male'` flips `"They"` to `"He"`. Fixed in I1
  (v1.1.4).
- **I-03 (S1): `ready()` exhausts the lite-signal node pool.** Each distinct
  locale string caches a signal permanently; on the installed lite-signal 1.4.0
  the shared pool (capacity 1024) throws `CapacityError` at ~1018 distinct
  strings, after which `createI18n()` itself throws, process-wide. Locale
  strings are untrusted input. Fixed in I2 (v1.2.0).
- **I-05 (S2): `loadLocale` silently overwrites a later `defineMessages`.** An
  in-flight load resolving after an explicit synchronous define wins the write,
  across the await boundary, with no signal. Fixed in I3 (v1.2.1).
- **I-15 (S2): `plural()` silently drops the count on a nested template.**
  `compileString` scans top-level tokens only for the plural variable
  (the pluralVar scan); when the outer token is a `select`, the scan misses the
  inner plural, so `plural('nest', 3, {g:'male'})` merges the count under
  `"count"` instead of the real variable and renders `"He has  apples"` instead
  of `"He has 3 apples"`. **The torture suite caught this on its very first run**
  -- the harness earning its keep before it had a single green pass. Same
  compile-time-scan family as I-08; fixed in I3 (v1.2.1). Pinned as a scoped
  known-failing case in torture T0 so the gate stays green and the regression is
  named, not deleted.
- **I-14 (S3): the lite-leak retention tier is deferred to I2.** Every
  published `@zakkster/lite-leak` (>=1.5.0) peer-requires
  `@zakkster/lite-signal >=1.5.0-beta.3`; lite-signal's latest is 1.4.3 (installed
  1.4.0), so no installable lite-leak exists today. T7 ships the
  structural-conservation half only; the second witness (`tracker.size() === 0`)
  lands in I2 alongside the `unloadLocale` / `clear()` eviction API it is meant
  to observe. The deferral is visible in `test/torture/t7-soak.mjs`, not silent.
- **Q2 instrument limits.** The scavenge-count gate reports a COUNT, not bytes;
  its true floor is an allocation too small to move the count at all (below the
  +8 scavenges/1M a single small per-call object costs -- Q1 backstops anything
  that survives a collection); and the count is new-space-size-dependent, so
  `torture.mjs` pins new-space (`--min-semi-space-size == --max-semi-space-size`)
  for within-fingerprint bit-identical, position-independent numbers and `baseline.json` is
  fingerprint-stamped -- a mismatch means re-measure under the SAME pin, never
  widen a ceiling.
- **Monomorphism law is an open question.** The `entry()` call site takes four
  compiled closure shapes today; V8 goes megamorphic at five. A throughput
  ratio cannot witness the transition (it is dominated by per-message work, and
  the sixth-shape control moves it the wrong way), so the T6 monomorphism check
  ships as a recorded `todo` pending a direct IC-state instrument.

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
