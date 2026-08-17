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
// I-14: the lite-leak retention witness is STILL DEFERRED (re-checked at I2).
//
// Re-run at v1.2.0 (2026-08-16): `npm i -D @zakkster/lite-leak` still fails
// ERESOLVE. The current @zakkster/lite-leak@1.8.1 peer-requires
// @zakkster/lite-signal ">=1.5.0-beta.3 <2.0.0"; lite-signal's registry latest
// is 1.4.3 (installed 1.4.0) and no 1.5.x exists, so the peer cannot be
// satisfied. lite-leak is NOT in devDependencies and NOT imported. I2 landed the
// eviction API (unloadLocale / clear) the retention witness is meant to observe,
// but the witness itself waits on a compatible lite-signal. Until then T7 ships
// the structural-conservation half only (extended below to the new stats fields
// and an unloadLocale churn), plus the T4/T8 pool-budget assertions; the gap is
// this comment and the CHANGELOG known-issues entry, not a silent omission.
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

        // Eviction churn: define a TRANSIENT locale, read it, then unloadLocale
        // it -- so the retire path runs 4096 times and must leave the live set
        // back at exactly {en}. This witnesses that unloadLocale actually
        // releases (I-12), not merely marks.
        inst.defineMessages("tmp", { z: "t" + c + " {v}" });
        sink = inst.t("z", { v: c }); // active is en (no 'z'); tmp is not in the chain, so this is the literal "z"
        const removed = inst.unloadLocale("tmp");
        check(removed === true, () => "T7: cycle " + c + " unloadLocale('tmp') did not remove");

        // Conservation after EVERY cycle: one locale, one cardinal rules entry,
        // no ordinal rules (no selectordinal read), nothing unbounded.
        check(conserved(inst, 1),
            () => "T7: cycle " + c + " conservation violated -- " +
                JSON.stringify(inst.stats()));
        // The new I2 counters stay coherent: no ready signals were minted, and
        // retiredLocales tracks the unloads exactly.
        check(inst.stats().readySignalsCached === 0,
            () => "T7: cycle " + c + " minted a phantom ready signal");
        check(inst.stats().retiredLocales === c + 1,
            () => "T7: cycle " + c + " retiredLocales " + inst.stats().retiredLocales + " != " + (c + 1));
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
