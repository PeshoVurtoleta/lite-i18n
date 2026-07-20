# bench

Comparison harness for `@zakkster/lite-i18n` vs `i18next` and
`intl-messageformat` (aka formatjs).

## Run

```
cd bench
npm install
npm run bench
```

Node 18+.  Output includes both a human-readable per-workload breakdown
and a Markdown table paste-ready for the main README.

## Methodology

* **4 workloads**: simple interpolation, plural, select, select+plural
  composition.
* **1 million iterations** each (500k for composition, since it's the
  heaviest per-op cost).
* **100k warm-up iterations** per workload before timing, so V8's inline
  caches and TurboFan compilation are settled.
* Wall-clock via `process.hrtime.bigint()`; per-op cost derived as
  `nsTotal / iterations`.
* Each library uses its native template syntax:
  - **lite-i18n** and **formatjs** use ICU MessageFormat.
  - **i18next** uses `{{var}}` interpolation + suffix-based plural/context
    resources (its documented native form).
* Correctness is asserted before timing. If outputs diverge across
  libraries for the same input, the harness aborts. No point comparing
  wrong-and-fast to right-and-slow.

## Fairness caveats

* We compare **rendering** cost only. Compilation (which lite-i18n and
  formatjs both pay at define time) is out of scope — that cost is paid
  once at app startup and doesn't recur.
* i18next's `t()` is a fuller API than the others (interpolation +
  namespace resolution + suffix-based plural + context selection), so its
  slower numbers reflect its broader work per call, not just template
  render cost.
* Single-machine, single-run numbers can vary ±10% between invocations.
  Re-run 2-3 times to sanity-check trends. The relative ordering has held
  across many runs on Apple Silicon and x86_64 Node 20+.

## What we're NOT measuring

* Bundle size (see main README).
* Compile-time competitors (paraglide-js compiles messages to JS at build
  time, so runtime cost is a raw property access — a different game
  entirely).
* Memory retention (see `test/06-zero-gc.test.mjs` under `--expose-gc`).
* Time-to-first-render (i18next's initialization is heavier than either
  ICU library, but we exclude init from the timed loop).

## Sample results

Node 22.22.2, warm-up 100k, measured 1M (500k composition):

| Workload | lite-i18n | i18next | formatjs |
|----------|-----------|---------|----------|
| simple interpolation | 7.90 Mops/s | 0.14 Mops/s | 2.90 Mops/s |
| plural (en, count=5) | 2.30 Mops/s | 0.18 Mops/s | 0.37 Mops/s |
| select (gender=male) | 17.40 Mops/s | 0.34 Mops/s | 4.80 Mops/s |
| select+plural composition | 2.10 Mops/s | 0.18 Mops/s | 0.34 Mops/s |

Speedup vs formatjs (the fair ICU comparison):
* simple ~2.7×, plural ~6.2×, select ~3.6×, composition ~6.2×.

Speedup vs i18next:
* simple ~56×, plural ~13×, select ~50×, composition ~12×.

## Why lite-i18n is fast

* **Compile once, iterate over stable tokens.** No per-call regex, no
  per-call parse. The runtime lookup is one `Map.get` and one function
  call.
* **Monomorphic call site.** Every compiled entry has the same
  `(params, locale, getRules) => string` shape, so V8's inline cache
  stays hot.
* **No microtask scheduler.** No `queueMicrotask`, no Promise chain per
  render.
* **Cached `Intl.PluralRules` per locale.** One construction per unique
  locale, then reused forever.
* **Select is cheaper than plural.** No PluralRules call — string-keyed
  `Map.get`. That's why select is 8× faster than plural on the same
  input shape.

The size-vs-speed story is complementary, not opposed: the token model
that makes the runtime fast is also the token model that keeps the
bundle at ~3 KB min+gz.
