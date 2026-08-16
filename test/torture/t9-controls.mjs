/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * Six deliberately-broken scenarios, each fed to the REAL gate it targets.
 * A control passes only if the gate FLAGS the broken input AND accepts the
 * matching good input (so no gate is vacuously always-failing). If any gate is
 * blind, T9 fails the whole run -- a gate that cannot fail is decorative.
 *
 *   1.  Q1 retention  -- a retaining loop must fail maxBytesPerCall:0; a clean
 *                        loop must pass it.
 *   2.  Q2 transient  -- a LARGE regression (per-call params object + varying
 *                        output) on the slot read must exceed slot's ceiling;
 *                        the hoisted-params read stays under it.
 *   2b. Q2 minimal    -- the MINIMAL regression (one small object per call,
 *                        constant output, ~+8/1M) must ALSO exceed the ceiling,
 *                        proving the tight margin catches the likely accident,
 *                        not only the large one.
 *   3.  Q3 pause      -- a forced-major loop must fail maxMajor:0; a clean loop
 *                        must pass it.
 *   4.  conservation  -- a second live locale must read as violated; one locale
 *                        must read as conserved.
 *   5.  fail-loud     -- a plural missing 'other' must throw at define; a valid
 *                        template must not.
 *   6.  selector-guard-- reverting ONE of the three I-01 hasOwn guards (the
 *                        type-3 select read, I18n.js:367) must make T2's identity
 *                        property fail: an inherited Object.prototype.gender then
 *                        changes the rendered variant. The shipped guarded read
 *                        must keep the property (inherited -> `other`).
 *
 * `node --expose-gc test/torture.mjs` runs all seven every time, so a plain
 * torture run already proves the gates bite (7/7 -> tier passes silently).
 * `I18N_TORTURE_BREAK=1 ...` requires 7/7 and then exits non-zero to signal the
 * control run -- the "exits non-zero on each control" contract (a second Q2
 * control and the I1 selector-guard control were added on review, so the count
 * is 7, not the brief's original 5).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createI18n } from "../../I18n.js";
import {
    die, BREAK, conserved,
    measureAllocs, checkAllocs, Q1_CFG,
    q2Scavenges, Q2_OPS, Q2_WARM,
    q3Gate,
} from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(HERE, "baseline.json"), "utf8"));

const keep = [];
let acc = 0;
let sink;

// Control 1 -- Q1 retention gate discriminates a retaining loop from a clean one.
function control1() {
    const bad = measureAllocs((i) => { keep.push({ a: i }); }, Q1_CFG);
    const badFail = checkAllocs(bad, { maxBytesPerCall: 0 }).verdict === "fail";
    keep.length = 0;
    const good = measureAllocs(() => { acc += 1; }, Q1_CFG);
    const goodPass = checkAllocs(good, { maxBytesPerCall: 0 }).verdict === "pass";
    return badFail && goodPass;
}

// Control 2 -- Q2 scavenge gate flags a LARGE regression: a per-call params
// object AND varying output on the slot read. Routes through the real read.
// Under the pinned semi-space this is bit-identical within a fingerprint:
// bad ~55/1M > 27, good (hoisted params) ~23/1M <= 27.
async function control2() {
    const inst = createI18n({ locale: "en" });
    inst.defineMessages("en", { slot: "Hi {name}" });
    const ceiling = BASELINE.ceilings.slot.ceiling; // 27
    const names = ["a", "b", "c", "d"];
    const bad = await q2Scavenges((i) => { sink = inst.t("slot", { name: names[i & 3] }); }, Q2_OPS, Q2_WARM);
    const P = { name: "a" };
    const good = await q2Scavenges(() => { sink = inst.t("slot", P); }, Q2_OPS, Q2_WARM);
    return bad > ceiling && good <= ceiling;
}

// Control 2b -- Q2 scavenge gate flags the MINIMAL realistic regression: one
// small object per call, consumed by the slot read, with CONSTANT output (the
// object has no 'name', so the string stays "Hi "). This isolates the params
// object alone -- the +8/1M an accidentally un-hoisted object costs. If the
// tightened ceiling (measured+4 = 27) does not fail this, the ceiling is too
// loose: bad ~31/1M > 27, good ~23/1M <= 27. Large (control2) and minimal
// regressions are different cases; both must be caught.
async function control2b() {
    const inst = createI18n({ locale: "en" });
    inst.defineMessages("en", { slot: "Hi {name}" });
    const ceiling = BASELINE.ceilings.slot.ceiling; // 27
    const bad = await q2Scavenges(() => { const o = { x: 1 }; sink = inst.t("slot", o); }, Q2_OPS, Q2_WARM);
    const P = { name: "a" };
    const good = await q2Scavenges(() => { sink = inst.t("slot", P); }, Q2_OPS, Q2_WARM);
    return bad > ceiling && good <= ceiling;
}

// Control 3 -- Q3 gate rejects a forced-major loop, accepts a clean one. Both
// sides compare on the LOAD-INDEPENDENT maxMajor:0 signal (q3Gate no longer
// gates pause time), so the clean run reads major=0 -> ok even on a contended
// runner, where the previous maxPauseMs:4 gate false-failed it (OS descheduling
// is not a GC stall). The forced-major run reads major>0 -> not ok.
async function control3() {
    const inst = createI18n({ locale: "en" });
    inst.defineMessages("en", { s: "Hi {name}" });
    const P = { name: "a" };
    const bad = await q3Gate(() => { sink = inst.t("s", P); }, 300000, true);
    const good = await q3Gate(() => { sink = inst.t("s", P); }, 300000, false);
    return bad.report.ok === false && good.report.ok === true;
}

// Control 4 -- the conservation checker is not always-false.
function control4() {
    const inst = createI18n({ locale: "en" });
    inst.defineMessages("en", { k: "EN" });
    const oneOk = conserved(inst, 1) === true;
    inst.defineMessages("de", { k: "DE" });  // a second live locale
    const twoViolated = conserved(inst, 1) === false; // checker catches locales=2 vs expected 1
    return oneOk && twoViolated;
}

// Control 5 -- the fail-loud define gate throws on a broken template, not a good one.
function control5() {
    const inst = createI18n({ locale: "en" });
    let badThrew = false;
    try { inst.defineMessages("en", { p: "{n, plural, one {x}}" }); } catch { badThrew = true; }
    let goodThrew = false;
    try { inst.defineMessages("en", { q: "{n, plural, one {x} other {y}}" }); } catch { goodThrew = true; }
    return badThrew && !goodThrew;
}

// Control 6 -- reverting the I-01 hasOwn guards must make T2's identity property
// fail. T2 asserts that rendering under an inherited Object.prototype property is
// byte-identical to the unpolluted render.
//
// Direction B reverts the guards in the REAL library code, not in a replica.
// All three guarded selector reads (I18n.js:354 type-2, :367 type-3, :462
// plural-object) funnel through the same primitive, so stubbing Object.hasOwn to
// `() => true` restores the exact 1.1.3 fail-open behaviour at all three sites at
// once, inside the shipped renderTokens -- no hand-rolled stand-in that could
// drift from the code it claims to model. An earlier draft of this control
// compared against a local Map replica; that version could have passed with the
// library fully broken, which is the I-02 pathology this session exists to kill.
// Do not reintroduce it.
function control6() {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        sel: "{gender, select, male {He} female {She} other {They}}",
        plr: "{count, plural, one {# item} other {# items}}",
        obj: { one: "# thing", other: "# things" },
    });
    const shot = () => i.t("sel", {}) + "|" + i.t("plr", {}) + "|" + i.t("obj", {});
    const clean = shot(); // "They| items| things" -- no own properties anywhere
    const pollute = () => {
        Object.prototype.gender = "male";
        Object.prototype.count = 1;
    };
    const unpollute = () => {
        delete Object.prototype.gender;
        delete Object.prototype.count;
    };
    // Direction A: the shipped GUARDED reads hold the identity property.
    let guardedHeld;
    try {
        pollute();
        guardedHeld = shot() === clean; // identity holds at all three sites
    } finally {
        unpollute();
    }
    // Direction B: the guards REVERTED in real library code -- the identity gate
    // must catch the break at every site.
    const realHasOwn = Object.hasOwn;
    let brokenCaught;
    try {
        pollute();
        Object.hasOwn = () => true; // fail open, exactly as 1.1.3 did
        brokenCaught = shot() !== clean; // "He|1 item|1 thing" !== clean
    } finally {
        Object.hasOwn = realHasOwn;
        unpollute();
    }
    return guardedHeld && brokenCaught;
}

export async function run() {
    const labels = ["1 Q1-retention", "2 Q2-large", "2b Q2-minimal", "3 Q3-pause", "4 conservation", "5 fail-loud", "6 selector-guard"];
    const results = [
        control1(),
        await control2(),
        await control2b(),
        await control3(),
        control4(),
        control5(),
        control6(),
    ];
    const N = results.length;
    let caught = 0;
    for (let i = 0; i < N; i++) if (results[i]) caught++;

    if (caught !== N) {
        // A blind gate fails torture on EVERY run, break mode or not.
        let blind = "";
        for (let i = 0; i < N; i++) if (!results[i]) blind += (blind ? "," : "") + "control" + labels[i];
        die("T9: only " + caught + "/" + N + " gates caught their break -- decorative: " + blind);
    }

    if (BREAK) {
        // Control run: all gates proven to bite; exit non-zero as required.
        die("T9: I18N_TORTURE_BREAK -- " + caught + "/" + N + " controls tripped as required");
    }
    void acc;
}
