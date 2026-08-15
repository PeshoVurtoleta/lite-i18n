# 0001 -- which instrument answers which allocation question

Status: accepted (session I0, v1.1.3)
Machine: node v26.3.1, v8 14.6.202.34-node.20, darwin arm64, Apple M4 Pro.
All numbers below were reproduced against the working tree with the probes
described in each section. Run everything under `node --expose-gc`.

## Why this file exists

The package law is: *compile at defineMessages, allocate nothing on read
except the returned string.* That is a claim about TRANSIENT allocation.
Every instrument the incoming roadmap prescribed measures RETENTION. The
sentence that forced this whole decision, from lite-gc-profiler's own
`llms.txt` (v1.15.0), verbatim:

> `measureAllocs` ... measures per-call RETAINED bytes (allocation surviving
> a forced collection) ... Distinct from `measureOps`, which reports an
> allocation RATE (`maxBytesPerOp`) and sees transient garbage that
> `measureAllocs` settles away.

The tool was never wrong. The brief picked the wrong lane. So each question
is settled against a control that MUST fail it, and a number is written down
only after the control breaks.

## The calibration case (the session's falsifier)

`plural()` allocates one object per call, by design, at `I18n.js:650`:

```js
const p = params ? { ...params, [varName]: count } : { [varName]: count };
```

That object escapes into `entry(p, loc, getRules)`, so it is a real, live,
per-call allocation of ~24-48 B. If the instrument chosen for Q2 cannot see
it, the instrument is rejected. This is the pass/fail condition for Q2, not
one assertion among many.

## Q1 -- does a read RETAIN? -- SETTLED, shipped

Instrument: `measureAllocs(fn, { iterations, warmup, batches })`, gated with
`checkAllocs(r, { maxBytesPerCall: 0 })`.

Config shipped: `{ iterations: 40000, warmup: 20000, batches: 64 }`, with a
warm-up `measureAllocs` window run first (to absorb process/JIT warm-up
retention that the first window otherwise attributes to the read) and a
NUMERIC accumulator sink (`acc += t(...).length`) so the harness never roots
the last returned string across a batch settle.

Why not the brief's `{ iterations: 200000, warmup: 10000 }` with default
batches? Measured: at 8-16 batches the string-returning shapes (slot / plural
/ select / selectordinal) flake to a sub-byte floor (worst 0.00044-0.09 B/call)
roughly 4-7% of runs, because the returned string is a by-design allocation
that occasionally survives the double-forced settle in EVERY batch, so the
MIN-over-batches estimator never observes the true 0. `bytesPerCall` is the
MIN across batches and "ambient noise only ever adds bytes" (Recipe 3b), so
more, smaller batches give the estimator more chances to catch a clean-0
batch. At `iterations:40000, batches:64` all five shapes read exactly 0 over
30 consecutive runs (0 flakes). The budget did not move -- it is still
`maxBytesPerCall: 0`; only the estimator was given enough batches to see the
floor it is measuring.

Controls (measured):

| shape / control | bytesPerCall | verdict |
| --- | --- | --- |
| `t('Hi')` static | 0 | pass |
| `t('Hi {name}', {name:'a'})` slot | 0 | pass |
| `t('{n, plural, ...}', {n:2})` | 0 | pass |
| `t('{g, select, ...}', {g:'male'})` | 0 | pass |
| `t('{n, selectordinal, ...}', {n:3})` | 0 | pass |
| **control: `keep.push({a:1})`** | **32** | **fail (correct)** |

The retained control reports 32 B/call and fails. Q1 is a real gate: it
catches a per-call retained object. Committed to `baseline.json`.

## Q2 -- does a read allocate TRANSIENTLY? -- GATEABLE, minor-GC count, shipped

Instrument: **minor GC (scavenge) count over an isolated `GcProfiler` window,
normalised to scavenges per 1,000,000 ops, measured under a PINNED new-space
(`--min-semi-space-size=1 --max-semi-space-size=1`).** The window is
`gc.start()` -> tight loop -> `await gc.settle()` -> read `summary.gc.minor`;
it forces no collections, so it observes the workload's own scavenges rather
than settling them away. `test/torture.mjs` re-execs itself with the pin so the
mandated `node --expose-gc test/torture.mjs` still applies it.

### Why the new-space is PINNED (the primary rationale, corrected)

Scavenge count = bytes-allocated / new-space-capacity. V8 sizes new-space
adaptively between a min and a max and GROWS it as a run allocates, so the same
workload scavenges fewer times later in a long tier sequence than in a fresh
process -- an absolute count is position-dependent. `--max-semi-space-size`
alone does NOT fix this (it caps the max but new-space still grows up to the
cap; measured: a control that read 27 scavenges/1M fresh read 1 late in the
sequence under a max-only cap). Setting **min == max** pins new-space at a
constant size, and then:

- The count is **bit-identical across reps on one machine** -- zero
  within-fingerprint variance, not merely "stable to +/-0.5". Verified: 3
  consecutive reps each read clean 0/0/0, slot 23/23/23, plural 46/46/46,
  selectordinal 46/46/46, plural() 100/100/100. (ACROSS machines/observers
  there is a real ~+/-1 jitter -- e.g. plural() reads 99 on a different
  observer, the minimal regression +7 vs +8 -- which the `captureFingerprint`
  stamp guards: a 1-unit drift on a matching fingerprint is noise, not a
  regression.)
- The count is **position-independent** through a full T6/T7-scale churn
  (measureAllocs storms + 4096 define cycles): EARLY == LATE, exactly.

Zero within-fingerprint variance is what makes tight ceilings defensible: there
is no statistical spread to buy tolerance for, so a multiplicative headroom
would be pure slack.
An earlier draft of this file recorded the DEFAULT-flag form (and claimed the
pin "was not required"). That was wrong: at default flags the numbers are ~half
these (new-space is larger) AND position-dependent, so a default baseline
compared against pinned measurements -- or vice versa -- silently mis-gates.
The shipped gate is pinned; these numbers are the pinned numbers.

### The correction to the causal story (kept, because the next reader needs it)

An even earlier draft claimed V8 escape analysis "eliminates the transient
object entirely." FALSE, and falsified by re-measuring: the object is genuinely
allocated. Candidate 2's sampler reported 0 bytes for it only through
probabilistic under-sampling of a small quickly-dead object; Candidate 3's
first pass read ~4 scavenges only because that loop ran adjacent to a
forced-collection window (which masks scavenges). Isolated and pinned, the
allocation is plainly visible and dead-stable.

Measured, isolated window, 2M ops, **pinned new-space (min==max==1 MB)**,
scavenges per 1M ops (bit-identical across 3 reps on this machine; ~+/-1
cross-observer):

| body | minorGC / 1M ops |
| --- | --- |
| clean `sink = i\|0` | 0 |
| `t static` (interned literal) | **0** |
| `t select` (interned variant, no substitution) | **0** |
| `t slot` | 23 |
| `t plural` | 46 |
| `t selectordinal` | 46 |
| **`plural()` API (calibration)** | **100** |

The calibration case is MET: the instrument sees the known-allocating function,
and `plural()` at 100 is ~2.2x `t plural` at 46 -- exactly the extra
`{...params, count}` object at `I18n.js:650` riding on top of the same returned
string. And it reproduces the package law: `static` and `select` read as
EXACTLY 0 (both return a pre-existing interned literal with no substitution);
the non-zero rows are the returned string, which the law explicitly permits
("allocate nothing on read except the returned string"). (`plural()` reads 100
under the harness's 50000-iteration warmup; a shorter warmup reads 99 -- a
warmup difference, not variance. The gate uses 50000, so 100 is the committed
number.)

### Candidate 1 -- `measureOps` allocation-rate, `stabilize:'deep'`, `maxBytesPerOp:0` -- REJECTED

`stabilize:'deep'` forces GC at every phase boundary, so `bytesPerOp` is a
RETAINED delta, not a transient rate. Measured (200000 ops, 10000 warmup):
clean `sink=i|0` -> 0.053 (fail, noise); transient -> 0.024 (fail, noise);
`plural()` -> 0.000 (**pass**). Noise-dominated: `maxBytesPerOp:0` sits below
the floor for everything so verdicts are coin-flips, and the calibration case
PASSES. (Candidate 1b, no stabilize, inverts it -- transient passes at 0.000,
clean fails at 0.049.) Rejected.

### Candidate 2 -- `startExplainSampling` (node:inspector heap sampling) -- REJECTED

Allocation-stack sampler. It DOES see the object (transient control samples
3-24 KB depending on interval), but the readings are probabilistic and noisy
for small, quickly-dead objects -- 0 to tens of KB across runs at the same
interval -- so it cannot produce a stable, reproducible per-op number, and
cannot be gated at a fixed threshold without flaking. Useful for attribution
(it names `I18n.js:403`, the compiled entry), not as a gate. Rejected as a
gate; retained as a diagnostic.

### Candidate 3 -- minor-GC (scavenge) count -- ACCEPTED (pinned form)

Accepted under the PINNED new-space (min==max), as scavenges per 1M ops,
measured in an isolated `GcProfiler` window. The gate is per shape: each
shape's scavenges/1M must stay under a committed ceiling in `baseline.json`.

**Sensitivity and the resolution floor, in the instrument's own units (pinned):**

- **It is a COUNT, not bytes.** Ceilings are scavenges per 1M ops. No B/op
  conversion is fabricated. `plural()` at 100 scavenges/1M is the committed
  sixth calibration number.
- **Smallest catchable regression, measured.** One small object per call,
  consumed by a string-returning read with CONSTANT output (`{x:1}` -> slot,
  which never reads `x`), moves the count from 23 to 31 -- **+8 scavenges/1M**.
  That is the likely real accident (a hoisted params object stops being
  hoisted). Ceilings are `measured + 4`, so any per-call regression of +5 or
  more is caught. T9 control2b injects exactly this minimal +8 and the gate
  fails it; control2 injects a larger +32 (per-call object AND varying output).
- **True floor.** An allocation too small to move the count at all -- below the
  ~+8/1M a single small object costs -- is invisible to this gate. Q1
  (retention) backstops anything that survives a collection.
- **Why `measured + 4`, not a multiple.** Zero variance (above) means there is
  no spread to cover; the only thing a wider margin would buy is portability to
  a different machine, and that is what the `captureFingerprint` stamp is for --
  a fingerprint mismatch is the signal to re-measure under the SAME pin, never
  to widen a ceiling. The tier MUST run in isolation and MUST NOT nest inside a
  `measureOps` / `measureAllocs` window (a forced-collection window masks the
  signal). The harness loop itself allocates nothing; only the workload does.

Committed ceilings (scavenges per 1M ops, pinned), `test/torture/baseline.json`:

| shape | measured | ceiling (measured+4) | headroom |
| --- | --- | --- | --- |
| static | 0 | 4 | 4 |
| select | 0 | 4 | 4 |
| slot | 23 | 27 | 4 |
| plural | 46 | 50 | 4 |
| selectordinal | 46 | 50 | 4 |
| `plural()` (calibration) | 100 | 104 | 4 |

Controls (T9), both routing through the real slot read:

- **control2b (minimal):** `const o = { x: 1 }; t('slot', o)` -> 31/1M > slot
  ceiling 27, while the hoisted-params read stays at 23 <= 27. This is the +8
  regression the tight margin exists to catch.
- **control2 (large):** `t('slot', { name: names[i&3] })` (per-call object AND
  varying output) -> 55/1M > 27. A larger, composite regression.

Both fail the gate; the good (hoisted-params) case passes it. The gate bites,
and it bites for the small regression, not only the large one.

## Q3 -- does a read STALL? -- SETTLED, shipped, gated on maxMajor:0 ONLY

Instrument: `GcProfiler` window over 1e6 `t()` calls, gated with
`checkNoGc(summary, { maxMajor: 0 })`. Pause time (`summary.gc.maxMs`) is a
REPORTED diagnostic, not a fail condition.

| workload | major | minor | maxMs | verdict |
| --- | --- | --- | --- | --- |
| 1e6 `t('Hi {name}', {name:'a'})` | 0 | 0 | 0.000 | pass |
| **control: force a major in the loop** | **25** | -- | -- | **fail (correct)** |

The forced-major control fails. Q3 is a real gate.

**Why pause time is not gated (corrected on review).** An earlier draft gated
`maxPauseMs: 4`. Pause time is TIME-determined: on a contended CI runner the OS
descheduling the process registers as a multi-ms `maxMs` with `major=0` -- OS
noise, not a fault in the read path. It produced a 25-40% false-fail rate at
4/8-way concurrency. The stall Q3 exists to catch is a GC pause CAUSED by the
read allocating, which is ALLOCATION-determined: a major collection (the only
multi-ms GC stall) is caught completely by `maxMajor:0`, and scavenge frequency
is already bounded per shape by Q2. Their union covers every GC-caused stall,
so dropping the time-based rule loses no real-defect detection while removing
the machine-noise false positives. A later session must not re-add `maxPauseMs`
to this gate by reflex -- it gates the scheduler, not the library.

Note likewise on Q1 (T6): the `measureAllocs` MIN-over-batches estimator has a
sub-1-B/call noise floor (a returned string surviving one batch settle) that
can tip `maxBytesPerCall:0` to a false fail under contention. A real per-call
retention is a surviving V8 heap object (>= ~16 B/call), a >= 16x gap, so
readings below 1 B/call are reclassified clean -- narrowly, not via
`allowInconclusive`. The 32-B/call retained control still fails.

## The monomorphism assertion -- OPEN QUESTION, shipped as todo

Law 2 of the roadmap: `entry(params, loc, getRules)` in `t()` is one call
site; four distinct compiled closure shapes reach it and V8 goes megamorphic
at five. The brief proposed witnessing this with a throughput ratio:
five-shape loop vs same-shape loop, asserting the ratio stays >= 0.60, with a
sixth-shape control driving it below 0.60.

Measured (3,000,000 iterations per bench, twice):

| loop | Mops/s | ratio vs 1-shape |
| --- | --- | --- |
| 1-shape (slot only) | 45.6 / 48.3 | 1.00 |
| 5-shape (static,slot,plural,select,ordinal) | 8.1 / 8.4 | **0.177 / 0.174** |
| 6-shape (+plural-obj,collapsed-literal) | 8.5 / 8.8 | **0.187 / 0.182** |

The ratio is DECORATION, for two measured reasons:

1. The 5/1 ratio is 0.177, far below 0.60, on a HEALTHY build -- because the
   ratio is dominated by per-message WORK, not IC state. `slot` does one
   `hasOwn` + concat; `plural`/`select`/`selectordinal` do Map dispatch,
   `Intl.PluralRules.select()`, and recursive `renderTokens`. A monomorphic
   site running heavier messages is 5.6x slower regardless of the call site's
   IC state. A >= 0.60 gate fails a correct build.
2. The sixth-shape control moves the ratio UP (0.187 > 0.177), not down --
   adding the cheaper plural-object and collapsed-literal messages raises the
   average throughput. The control does not falsify the assertion.

A direct synthetic probe (one call site `e(a,b,c)` reached by N distinct
`SharedFunctionInfo`s) confirms V8's megamorphic penalty is small and
noise-swamped: 4-SFI ratio 0.94-0.97, 6-SFI ratio 0.76-1.02 -- never below
0.60. Throughput cannot witness the 4->5 megamorphic transition here.

Per the brief's explicit instruction ("if its control does not move the
metric, record it as an open question and ship the tier as todo -- do not
fudge the threshold"), the monomorphism tier ships as a recorded `todo` in
T6. Witnessing megamorphism needs a direct instrument (`%GetOptimizationStatus`
/ IC-state inspection under `--allow-natives-syntax`, or a dispatch-only
micro-bench that holds per-message work constant), which is a later session.

## The size gate -- measures gzipped SOURCE, min+gz UNVERIFIED (I7 inherits)

`test/size.mjs` (`npm run size`, I-13) gates the GZIPPED SOURCE bytes of
`I18n.js` and `Format.js` (zlib level 9): I18n.js 8777 B (budget 10240),
Format.js 2128 B (budget 2560). Budgets are today's measurement plus headroom
sized to catch a material regression.

This is NOT the `~3.5 KB min+gz core + ~0.76 KB Format` figure the README,
`llms.txt` and `package.json` advertise -- gzipped source is ~2.5x min+gz
because nothing minifies first. The package ships no minifier and this session
added none (a devDep minifier is permitted by suite law but out of I0's scope).
So the gate is a RELATIVE drift sentinel on source bytes, not a check of the
documented claim. **The documented min+gz numbers remain unverified in-repo.**
I7 (docs reconciliation) inherits this open item: either add a devDep minifier
and gate the real min+gz, or re-measure and restamp the claim with the version
and machine it came from.
