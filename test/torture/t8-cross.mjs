/**
 * T8 -- cross-surface conformance + the lite-signal pool budget (I2, v1.2.0).
 *
 * The I-03 gate expressed as a BUDGET rather than a crash: one instance's
 * lite-signal pool consumption is bounded and does NOT scale with the number of
 * locale strings it observes. Pre-fix, ready() minted one pool node per distinct
 * locale forever, so consumption scaled linearly with untrusted input until the
 * process-wide 1024-node pool threw. Post-fix, ready() fails CLOSED at
 * LOCALE_CACHE_MAX, so an instance mints at most LOCALE_CACHE_MAX readiness
 * nodes over its entire life no matter how many distinct locales stream through.
 *
 * Measured directly against lite-signal's own `stats().activeNodes` (a
 * process-global gauge): the delta an instance adds must not grow when the
 * observed-locale count grows by an order of magnitude.
 */

import { stats as signalStats, dispose } from "@zakkster/lite-signal";
import { createI18n, LocaleCapacityError, LOCALE_CACHE_MAX } from "../../I18n.js";
import { check, withinLocaleBounds } from "./harness.mjs";

// Drive `distinct` untrusted locales through ready()+locale.set+t(), returning
// how many lite-signal pool nodes the run left allocated (net of what it frees).
// The readiness signals are disposed at the end so the measurement reflects the
// STEADY-STATE footprint and does not draw down the shared pool for later tiers.
function poolDeltaFor(distinct) {
    const base = signalStats().activeNodes;
    const inst = createI18n({ locale: "en", fallback: "en" });
    inst.defineMessages("en", { p: "{n, plural, one {# item} other {# items}}" });
    const sigs = [];
    const _warn = console.warn;
    console.warn = function () {};
    for (let n = 0; n < distinct; n++) {
        const loc = "t8-" + distinct + "-" + n;
        try { sigs.push(inst.ready(loc)); } catch (e) {
            check(e instanceof LocaleCapacityError, () => "T8: ready() threw non-LocaleCapacityError: " + (e && e.name));
        }
        inst.locale.set(loc);
        inst.t("p", { n: 2 });
    }
    console.warn = _warn;
    check(withinLocaleBounds(inst, LOCALE_CACHE_MAX),
        () => "T8: caches unbounded at distinct=" + distinct + " -- " + JSON.stringify(inst.stats()));
    // Peak footprint while the instance is fully live.
    const peak = signalStats().activeNodes - base;
    // Reclaim readiness nodes (no subscribers -> clean) so later tiers keep the pool.
    for (let k = 0; k < sigs.length; k++) dispose(sigs[k]);
    return peak;
}

export async function run() {
    // 500 distinct locales vs 5000: a 10x increase in observed input.
    const small = poolDeltaFor(500);
    const large = poolDeltaFor(5000);

    // The budget: pool consumption must NOT scale with locales observed. Both
    // runs mint the same ceiling of readiness nodes (LOCALE_CACHE_MAX) plus the
    // instance's own two (_locale, _epoch); the rules caches are plain Maps and
    // consume NO pool nodes. So the 10x input increase adds nothing.
    const budget = LOCALE_CACHE_MAX + 8; // ceiling + instance signals + slack
    check(small <= budget,
        () => "T8: 500-locale run consumed " + small + " pool nodes (> " + budget + ")");
    check(large <= budget,
        () => "T8: 5000-locale run consumed " + large + " pool nodes (> " + budget + ") -- consumption scaled with input");
    check(large <= small + 2,
        () => "T8: pool consumption scaled with observed locales: 500->" + small + ", 5000->" + large);

    // The process is not poisoned by either run: a fresh instance still works.
    const fresh = createI18n({ locale: "en" });
    fresh.defineMessages("en", { hi: "hello" });
    check(fresh.t("hi") === "hello", () => "T8: shared pool poisoned -- fresh instance broken");
}
