/**
 * @zakkster/lite-i18n -- torture harness.
 *
 * Shared scratch, zero-alloc assertions, a seeded PRNG, and the
 * lite-gc-profiler gate wrappers. Every tier imports from here so the
 * discipline lives in one place (mirrors ../../../LiteBvh/test/torture/harness.mjs):
 *
 *   - All scratch (params, dicts, instances) is allocated ONCE by the tier,
 *     outside every loop. This module hands out helpers, never per-call
 *     allocations on a hot path.
 *   - `check(cond, msgThunk)` builds its message string ONLY on failure -- a
 *     template literal per iteration is an allocation and would fail T6.
 *   - The PRNG is a seeded xorshift32. On any failure a tier prints the seed
 *     so the case replays with `TORTURE_SEED=... npm run torture`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run STRICTLY
 *     sequentially, never nested. Each gate wrapper opens and closes one
 *     window per call.
 *
 * Decision record: decisions/0001-measurement.md settles which instrument
 * answers which question. All three ship as gates: Q1 (retention, measureAllocs
 * maxBytesPerCall:0), Q2 (transient, minor-GC scavenge count under a pinned
 * new-space), Q3 (pause, checkNoGc maxMajor:0).
 *
 * @license MIT
 */

import {
    measureAllocs, checkAllocs,
    GcProfiler, checkNoGc,
    captureFingerprint,
} from "@zakkster/lite-gc-profiler";

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Control mode: drives the T9 controls and asserts every gate can fail. */
export const BREAK = process.env.I18N_TORTURE_BREAK === "1";

/**
 * Q1 measurement config (decisions/0001-measurement.md). Enough small batches
 * that the MIN-over-batches estimator reliably observes the true 0 floor for
 * a string-returning read; the budget stays maxBytesPerCall:0.
 */
export const Q1_CFG = { iterations: 40000, warmup: 20000, batches: 64 };

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write("torture: FAIL -- " + msg +
        "\n  replay: TORTURE_SEED=" + SEED + " node --expose-gc test/torture.mjs\n");
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a
 * string, so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

export { measureAllocs, checkAllocs, GcProfiler, checkNoGc, captureFingerprint };

/**
 * Q1 retention gate. Returns the checkAllocs report for `fn`. The caller
 * decides pass/fail; the wrapper only opens one measurement window.
 * @param {(i:number)=>void} fn  Sync, hot body consuming into a numeric sink.
 */
export function q1Gate(fn) {
    const r = measureAllocs(fn, Q1_CFG);
    return { report: checkAllocs(r, { maxBytesPerCall: 0 }), bytesPerCall: r.bytesPerCall };
}

/**
 * Q3 pause gate. Runs `fn(i)` over `ops` iterations under one GcProfiler
 * window, sampling heap on a power-of-2 mask, and gates on `maxMajor: 0` ONLY.
 * `settle` is awaited so GC entries are delivered before summary() -- a window
 * read too early is a false PASS.
 *
 * WHY NOT maxPauseMs: pause time is TIME-determined, so on a contended CI
 * runner the OS descheduling the process shows up as a multi-ms `maxMs` with
 * `major=0` -- noise, not a fault in the read path. It caused a 25-40% false
 * fail rate under 4/8-way load. The stall Q3 exists to catch is a GC pause
 * CAUSED by the read path allocating, and that is ALLOCATION-determined: a
 * major collection (the only multi-ms GC stall) is caught completely by
 * `maxMajor:0`, and scavenge frequency is already bounded per-shape by Q2.
 * Their union covers every GC-caused stall. `maxMs` is kept as a REPORTED
 * diagnostic on the returned summary, never a fail condition.
 * @param {(i:number)=>void} fn
 * @param {number} ops
 * @param {boolean} [forceMajor]  Control: force a major collection in-loop.
 */
export async function q3Gate(fn, ops, forceMajor) {
    const gc = new GcProfiler().start();
    for (let i = 0; i < ops; i++) {
        fn(i);
        if ((i & 8191) === 0) {
            gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
            if (forceMajor) globalThis.gc();
        }
    }
    await gc.settle();
    const summary = gc.summary();
    const report = checkNoGc(summary, { maxMajor: 0 });
    gc.stop();
    return { report, summary };
}

/**
 * Q2 transient gate (decisions/0001-measurement.md, Candidate 3 corrected).
 * Runs `fn(i)` over `ops` iterations in an ISOLATED GcProfiler window under the
 * PINNED new-space torture.mjs re-execs with -- no forced collections, so it
 * observes the workload's own scavenges instead of settling them away -- and
 * returns minor GC (scavenge) count normalised to per-1,000,000-ops. MUST NOT
 * be nested inside a measureOps / measureAllocs window (a forced-collection
 * window masks the signal). The loop wrapper allocates nothing; only `fn` does.
 * @param {(i:number)=>void} fn
 * @param {number} ops
 * @param {number} warm  JIT warm-up iterations before the measured window.
 */
export async function q2Scavenges(fn, ops, warm) {
    // Position-independence comes from the pinned semi-space (torture.mjs
    // re-execs with --min-semi-space-size == --max-semi-space-size so new-space
    // is a constant size and cannot grow across the sequence); this gc() just
    // starts each window from a compacted heap so the warm-up phase is not
    // measuring the previous tier's tail.
    globalThis.gc();
    for (let i = 0; i < warm; i++) fn(i);
    const gc = new GcProfiler().start();
    for (let i = 0; i < ops; i++) fn(i);
    await gc.settle();
    const minor = gc.summary().gc.minor;
    gc.stop();
    return minor / (ops / 1e6);
}

/** Ops and warm-up shared by every Q2 measurement so ceilings are comparable. */
export const Q2_OPS = 2000000;
export const Q2_WARM = 50000;

/**
 * The conservation invariant (roadmap section 2), the structural half T7
 * asserts. Every per-locale structure must stay bounded and match the live
 * locale set. Returns true iff the instance's caches are conserved against
 * `expectLocales`.
 */
export function conserved(inst, expectLocales) {
    const s = inst.stats();
    return s.locales === expectLocales &&
        s.pluralRulesCached <= expectLocales &&
        s.ordinalRulesCached <= expectLocales;
}
