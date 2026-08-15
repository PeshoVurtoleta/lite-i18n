/**
 * T7 -- soak and cache conservation (structural half).
 *
 * `leak_cycles` (4096) define/read/switch cycles. Each cycle redefines the
 * active locale with fresh content under fixed keys (so the compiled closures
 * from the prior cycle become garbage and are replaced -- the retention churn
 * we sample ACROSS cycles), reads every shape, and re-sets the locale. After
 * EACH cycle the conservation invariant (roadmap section 2) must hold:
 * stats().locales === 1 and pluralRulesCached / ordinalRulesCached each <= 1.
 * Heap is sampled at cycle boundaries only, never within a cycle.
 *
 * TWO independent witnesses are meant to run here so a cache leak and a
 * JS-object leak cannot hide behind each other: structural conservation (this
 * tier) AND lite-leak's tracker.size()===0. The second is DEFERRED to I2 --
 * see the block below. This is recorded, not silently skipped.
 */

import { createI18n } from "../../I18n.js";
import { check, conserved } from "./harness.mjs";

const CYCLES = 4096;

// ---------------------------------------------------------------------------
// I-14: the lite-leak retention witness is DEFERRED to I2, on purpose.
//
// @zakkster/lite-leak >=1.5.0 peer-requires @zakkster/lite-signal >=1.5.0-beta.3;
// lite-signal's latest is 1.4.3 and the installed version is 1.4.0, so no
// lite-leak that this package can install exists today. It is NOT in
// devDependencies and NOT imported here. I2 (v1.2.0) lands unloadLocale /
// clear() -- the eviction API lite-leak is meant to witness -- by which point
// a compatible lite-signal is expected. Until then T7 ships the
// structural-conservation half only, and the gap is this comment plus the
// CHANGELOG known-issues entry, not a missing import that reads as an oversight.
// ---------------------------------------------------------------------------

export async function run() {
    const inst = createI18n({ locale: "en" });
    let sink;

    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let c = 0; c < CYCLES; c++) {
        // Define: fixed keys, cycle-varying content. Merges into the one 'en'
        // bucket -- overwriting the same keys, so the bucket size is stable and
        // locales stays 1 (no eviction API exists yet -- I-12).
        inst.defineMessages("en", {
            a: "cycle " + c + " {v}",
            n: "{n, plural, one {# item c" + c + "} other {# items c" + c + "}}",
            g: "{g, select, male {He c" + c + "} other {They c" + c + "}}",
        });

        // Read every shape so the compiled entries are exercised, not just held.
        sink = inst.t("a", { v: c });
        sink = inst.plural("n", (c & 3));
        sink = inst.t("g", { g: (c & 1) ? "male" : "x" });
        void sink;

        // Switch: re-set the active locale (idempotent here; the point is that
        // the read/define/switch loop leaves the caches conserved).
        inst.locale.set("en");

        // Conservation after EVERY cycle: one locale, one cardinal rules entry,
        // no ordinal rules (no selectordinal read), nothing unbounded.
        check(conserved(inst, 1),
            () => "T7: cycle " + c + " conservation violated -- " +
                JSON.stringify(inst.stats()));
    }

    // Final structural assertions, spelled out so a regression names itself.
    const s = inst.stats();
    check(s.locales === 1, () => "T7: locales " + s.locales + " != 1 after " + CYCLES + " cycles");
    check(s.pluralRulesCached === 1,
        () => "T7: pluralRulesCached " + s.pluralRulesCached + " != 1 after " + CYCLES + " cycles");
    check(s.ordinalRulesCached === 0,
        () => "T7: ordinalRulesCached " + s.ordinalRulesCached + " != 0 (no selectordinal was read)");

    // Across-cycle heap growth: redefining fixed keys must not accumulate. The
    // old compiled closures are unreferenced each cycle; a bound proves they
    // are actually collectable, not merely overwritten in the Map.
    globalThis.gc();
    const grewKB = (process.memoryUsage().heapUsed - heapBefore) / 1024;
    check(grewKB < 1024,
        () => "T7: heap grew " + grewKB.toFixed(1) + " KB over " + CYCLES + " cycles");
}
