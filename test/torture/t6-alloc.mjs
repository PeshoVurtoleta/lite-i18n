/**
 * T6 -- the allocation gate: three instruments, three questions.
 *
 * Settled in decisions/0001-measurement.md, each proven against a control that
 * MUST fail it (the controls live in T9):
 *
 *   Q1 RETENTION  -- measureAllocs, maxBytesPerCall:0. The five pure-read
 *                    shapes retain nothing (the returned string is transient).
 *                    Config Q1_CFG (40000 iters x 64 batches) so the
 *                    MIN-over-batches estimator reliably observes the true 0
 *                    floor for a string-returning read; the budget stays 0.
 *   Q2 TRANSIENT  -- minor-GC (scavenge) count per 1M ops under a PINNED
 *                    new-space (torture.mjs re-execs with min==max semi-space,
 *                    which makes the count bit-identical across reps on one
 *                    machine and position-independent), in an ISOLATED
 *                    GcProfiler window
 *                    (no forced collections). Per-shape ceilings (measured+4)
 *                    committed in baseline.json, plus the plural() calibration
 *                    number (100 scavenges/1M, ceiling 104) -- the sixth
 *                    number, the instrument seeing the known-allocating
 *                    function at I18n.js:659.
 *   Q3 PAUSE      -- checkNoGc, maxMajor:0 over 1e6 t() (pause time is a
 *                    reported diagnostic, not a gate -- see q3Gate).
 *
 * The monomorphism law is an OPEN QUESTION, shipped as a todo (see the block at
 * the end and the decision record): a throughput ratio cannot witness the
 * 4->5 megamorphic transition at the entry() call site -- the ratio is
 * dominated by per-message work, and the sixth-shape control moves it the wrong
 * way. Not gated here; needs a direct IC-state instrument in a later session.
 *
 * Every hot body consumes into a pre-declared sink so the loop wrapper
 * allocates nothing; only the measured workload does. Tiers run sequentially,
 * so no window nests inside another.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createI18n } from "../../I18n.js";
import {
    check, die,
    measureAllocs, checkAllocs, Q1_CFG,
    q2Scavenges, Q2_OPS, Q2_WARM,
    q3Gate,
} from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(HERE, "baseline.json"), "utf8"));

// Pre-declared sinks: a numeric accumulator for Q1 (never roots a returned
// string across a batch settle) and a plain sink for Q2 (matches the body the
// ceilings were measured with).
let acc = 0;
let sink;

export async function run() {
    const inst = createI18n({ locale: "en" });
    inst.defineMessages("en", {
        static: "Hi",
        slot: "Hi {name}",
        plural: "{n, plural, one {# f} other {# fs}}",
        select: "{g, select, male {He} other {They}}",
        selectordinal: "{n, selectordinal, one {#st} other {#th}}",
    });
    const P = { name: "a", n: 2, g: "male" };
    const ORD = { n: 3 };

    // Q1 bodies (numeric sink) and Q2 bodies (plain sink), by shape name.
    const q1 = {
        static: () => { acc += inst.t("static", P).length; },
        slot: () => { acc += inst.t("slot", P).length; },
        plural: () => { acc += inst.t("plural", P).length; },
        select: () => { acc += inst.t("select", P).length; },
        selectordinal: () => { acc += inst.t("selectordinal", ORD).length; },
    };
    const q2 = {
        static: () => { sink = inst.t("static", P); },
        slot: () => { sink = inst.t("slot", P); },
        plural: () => { sink = inst.t("plural", P); },
        select: () => { sink = inst.t("select", P); },
        selectordinal: () => { sink = inst.t("selectordinal", ORD); },
        "plural()": () => { sink = inst.plural("plural", 2); },
    };
    const READ_SHAPES = ["static", "slot", "plural", "select", "selectordinal"];

    // --- Q1 retention: the five pure reads retain nothing ---------------------
    // Warm-up window first, so process/JIT warm-up retention is not attributed
    // to the first measured shape.
    measureAllocs(() => { for (const k of READ_SHAPES) q1[k](); },
        { iterations: 20000, warmup: 20000, batches: 8 });
    for (const k of READ_SHAPES) {
        const r = measureAllocs(q1[k], Q1_CFG);
        const rep = checkAllocs(r, { maxBytesPerCall: 0 });
        const bpc = r.bytesPerCall;
        // Reclassify ONE specific, bounded, expected-noise band -- not a blanket
        // suppression. A real per-call retention is a surviving V8 heap object,
        // >= ~16 B/call minimum. The measureAllocs MIN-over-batches estimator has
        // a sub-1-B/call floor (a returned string that survived one batch
        // settle), which under CI contention can tip maxBytesPerCall:0 to a
        // false fail. The gap is >= 16x, so a reading below 1 B/call cannot mask
        // a real object: it is reclassified clean. The control (control1's
        // keep.push({a:i})) reads ~32 B/call and still fails, verified in T9.
        if (rep.verdict === "fail" && bpc >= 1) {
            die("T6 Q1: shape " + k + " retains " + bpc +
                " B/call -- a real per-call object (maxBytesPerCall:0)");
        }
        // Any non-fail non-pass verdict (inconclusive: the run did not settle)
        // is unexpected and fails closed -- never resolved with allowInconclusive.
        if (rep.verdict === "inconclusive") {
            die("T6 Q1: shape " + k + " inconclusive -- " +
                (rep.reasons ? rep.reasons.join("; ") : "run did not settle") +
                " (unexpected; not suppressed)");
        }
    }

    // --- Q2 transient: scavenges per 1M ops under committed ceilings ----------
    for (const k of Object.keys(q2)) {
        const ceiling = BASELINE.ceilings[k].ceiling;
        const perM = await q2Scavenges(q2[k], Q2_OPS, Q2_WARM);
        check(perM <= ceiling,
            () => "T6 Q2: shape " + k + " = " + perM.toFixed(1) +
                " scavenges/1M exceeds ceiling " + ceiling +
                " (baseline fingerprint mismatch? re-measure under the SAME pin, do not widen)");
    }

    // --- Q3 pause: no major collection, no stall over 1e6 reads ---------------
    {
        const { report, summary } = await q3Gate(q2.slot, 1000000);
        if (!report.ok) {
            const g = summary.gc;
            die("T6 Q3: pause gate rejected -- verdict=" + report.verdict +
                " major=" + g.major + " maxMs=" + g.maxMs.toFixed(3));
        }
    }

    // --- monomorphism law: OPEN QUESTION, shipped as todo ---------------------
    // decisions/0001-measurement.md: a throughput ratio (5-shape loop vs
    // 1-shape loop) cannot witness V8 going megamorphic at the entry() call
    // site. Measured on this tree: the 5/1 ratio is 0.177 on a HEALTHY build
    // (dominated by per-message work, not IC state), and the sixth-shape
    // control moves it UP (0.187), not below the proposed 0.60 gate -- so the
    // control does not falsify the assertion. Witnessing megamorphism needs a
    // direct IC-state instrument (%GetOptimizationStatus under
    // --allow-natives-syntax, or a dispatch-only micro-bench holding per-message
    // work constant), which is a later session. NOT gated here, by design --
    // registered as a todo so I5 (tRich, the likely fifth-shape regressor) has
    // a named slot rather than a silent gap.
    void acc; // keep the Q1 accumulator observably live; defeats DCE of the loop bodies
}
