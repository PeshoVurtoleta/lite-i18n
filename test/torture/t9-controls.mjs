/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * Nine deliberately-broken scenarios, each fed to the REAL gate it targets.
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
 *                        type-3 select read in renderTokens) must make T2's
 *                        identity property fail: an inherited Object.prototype.
 *                        gender then changes the rendered variant. The shipped
 *                        guarded read must keep the property (inherited -> other).
 *   7.  rules-bound   -- (I2) defeating _pluralRules/_ordinalRules eviction in
 *                        the SHIPPED getRules (stub Map.prototype.delete, the
 *                        primitive its FIFO victim removal calls) must make the
 *                        T4/T7 conservation bound go red past LOCALE_CACHE_MAX;
 *                        the shipped eviction keeps it bounded.
 *   8.  pool-budget   -- (I2) defeating the _readySignals ceiling in the SHIPPED
 *                        ready() (stub Map.prototype.size -> 0, the value the
 *                        guard reads) lets it mint one pool node per distinct
 *                        locale, so T8's pool-budget gate goes red as
 *                        consumption scales with input; the shipped fail-closed
 *                        ceiling caps consumption regardless of input.
 *
 * `node --expose-gc test/torture.mjs` runs all nine every time, so a plain
 * torture run already proves the gates bite (9/9 -> tier passes silently).
 * `I18N_TORTURE_BREAK=1 ...` requires 9/9 and then exits non-zero to signal the
 * control run. The count grew from I1's 7 to 9: controls 7 and 8 were added in
 * I2 for the two new cache-bound gates, each breaking REAL library code in the
 * shipped path (Map.prototype.delete / .size), never a local replica.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stats as signalStats, dispose } from "@zakkster/lite-signal";
import { createI18n, LOCALE_CACHE_MAX, LocaleCapacityError } from "../../I18n.js";
import {
    die, BREAK, conserved, withinLocaleBounds,
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
// All three guarded selector reads (renderTokens type-2 and type-3, and
// compilePluralObj) funnel through the same primitive, so stubbing Object.hasOwn to
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

// Control 7 (I2) -- the _pluralRules/_ordinalRules FIFO eviction bound. The
// shipped getRules evicts its oldest entry with `cache.delete(cache.keys().
// next().value)` before growing past LOCALE_CACHE_MAX. Stubbing Map.prototype.
// delete to a no-op disables that removal INSIDE the shipped getRules -- no
// replica -- so distinct locales cache without bound and the T4/T7 conservation
// gate (withinLocaleBounds) goes red. The good run, with real delete, stays
// bounded. Same discipline as control6: break a global the shipped path calls.
function control7() {
    const realDelete = Map.prototype.delete;
    const w = console.warn;
    console.warn = () => {};
    // Good: real eviction keeps the cache bounded past the ceiling.
    const good = createI18n({ locale: "en", fallback: "en" });
    good.defineMessages("en", { p: "{n, plural, one {# a} other {# b}}" });
    for (let n = 0; n < LOCALE_CACHE_MAX + 60; n++) { good.locale.set("g7-" + n); good.t("p", { n: 2 }); }
    const goodBounded = withinLocaleBounds(good, LOCALE_CACHE_MAX);
    // Broken: eviction defeated in the shipped getRules -> unbounded.
    const bad = createI18n({ locale: "en", fallback: "en" });
    bad.defineMessages("en", { p: "{n, plural, one {# a} other {# b}}" });
    let brokenRed;
    try {
        Map.prototype.delete = function () { return false; };
        for (let n = 0; n < LOCALE_CACHE_MAX + 60; n++) { bad.locale.set("b7-" + n); bad.t("p", { n: 2 }); }
        brokenRed = !withinLocaleBounds(bad, LOCALE_CACHE_MAX);
    } finally {
        Map.prototype.delete = realDelete;
        console.warn = w;
    }
    return goodBounded && brokenRed;
}

// Control 8 (I2) -- the _readySignals ceiling / T8 pool budget. The shipped
// ready() fails closed when `_readySignals.size >= LOCALE_CACHE_MAX`. Stubbing
// Map.prototype.size to 0 makes that guard read 0 INSIDE the shipped ready() --
// no replica -- so it mints one lite-signal pool node per distinct locale and
// pool consumption SCALES with observed locales, which is exactly what T8's
// budget gate forbids. With the real guard, consumption caps at the ceiling no
// matter how many distinct locales stream through. Measured against lite-signal's
// own activeNodes gauge; every minted signal is disposed so the control does not
// draw down the shared pool for the rest of the run.
function control8() {
    const sizeDesc = Object.getOwnPropertyDescriptor(Map.prototype, "size");
    function poolDelta(distinct, defeat) {
        const base = signalStats().activeNodes;
        const inst = createI18n({ locale: "en" });
        const sigs = [];
        if (defeat) Object.defineProperty(Map.prototype, "size", { configurable: true, get() { return 0; } });
        try {
            for (let n = 0; n < distinct; n++) {
                try { sigs.push(inst.ready("p8-" + defeat + "-" + n)); }
                catch (e) { if (!(e instanceof LocaleCapacityError)) throw e; }
            }
        } finally {
            if (defeat) Object.defineProperty(Map.prototype, "size", sizeDesc);
        }
        const delta = signalStats().activeNodes - base;
        for (let k = 0; k < sigs.length; k++) dispose(sigs[k]);
        return delta;
    }
    const budget = LOCALE_CACHE_MAX + 8;             // ceiling + instance signals + slack (mirrors T8)
    const goodBounded = poolDelta(700, false) <= budget;   // real ceiling caps ~256 despite 700 distinct
    const brokenRed = poolDelta(700, true) > budget;       // ceiling defeated -> ~700 pool nodes -> T8 red
    return goodBounded && brokenRed;
}

export async function run() {
    const labels = ["1 Q1-retention", "2 Q2-large", "2b Q2-minimal", "3 Q3-pause", "4 conservation", "5 fail-loud", "6 selector-guard", "7 rules-bound", "8 pool-budget"];
    const results = [
        control1(),
        await control2(),
        await control2b(),
        await control3(),
        control4(),
        control5(),
        control6(),
        control7(),
        control8(),
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
