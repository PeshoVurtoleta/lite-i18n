/**
 * T4 -- lifecycle abuse (I2, v1.2.0).
 *
 * The I-03 gate expressed as behaviour: 10k distinct locale strings through
 * ready(), locale.set and loadLocale must leave every per-locale cache BOUNDED,
 * the crash must be a NAMED per-instance LocaleCapacityError (never a dependency
 * pool crash that poisons the process), and createI18n() must still work after.
 * Plus the I-12 eviction API: unloadLocale of the active and of a fallback
 * locale, and clear() with a load in flight -- each with a DECIDED policy, not
 * "silently returns garbage".
 *
 * Pool hygiene: lite-signal nodes are reclaimed by dispose, not GC
 * (decisions/0003-locale-bounds.md). This tier mints up to LOCALE_CACHE_MAX
 * readiness signals; it disposes them before returning so the shared pool is
 * not drawn down for the remaining tiers in this single-process run. The
 * disposed signals have no subscribers here, so disposal is clean.
 */

import { dispose } from "@zakkster/lite-signal";
import { createI18n, LocaleCapacityError, LOCALE_CACHE_MAX } from "../../I18n.js";
import { check, withinLocaleBounds } from "./harness.mjs";

export async function run() {
    // --- I-03: 10k distinct locales through ready() + locale.set + t() -------
    const inst = createI18n({ locale: "en", fallback: "en" });
    inst.defineMessages("en", {
        p: "{n, plural, one {# item} other {# items}}",
        o: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
    });

    const sigs = [];
    let readyThrows = 0;
    let sink;
    // Silence the (budgeted) invalid-locale warnings so the torture run's output
    // stays clean; the WARN_BUDGET counter increments regardless of whether the
    // console.warn actually prints, so warningsSuppressed is still asserted below.
    const _warn = console.warn;
    console.warn = function () {};
    for (let n = 0; n < 10000; n++) {
        const loc = "loc-" + n;
        // ready(): fails closed past the ceiling with the NAMED error.
        try {
            sigs.push(inst.ready(loc));
        } catch (e) {
            check(e instanceof LocaleCapacityError,
                () => "T4: ready() threw " + (e && e.name) + ", expected LocaleCapacityError");
            check(e.locale === loc && e.ceiling === LOCALE_CACHE_MAX,
                () => "T4: LocaleCapacityError did not name the locale/ceiling: " + JSON.stringify({ l: e.locale, c: e.ceiling }));
            readyThrows++;
        }
        // locale.set + t() with a fallback: rules built against the requested
        // (untrusted) locale, FIFO-bounded, no throw.
        inst.locale.set(loc);
        sink = inst.t("p", { n: 2 });
        sink = inst.t("o", { n: 3 });
        // The invariant holds after EVERY operation.
        check(withinLocaleBounds(inst, LOCALE_CACHE_MAX),
            () => "T4: bound violated at n=" + n + " -- " + JSON.stringify(inst.stats()));
    }
    console.warn = _warn;
    void sink;

    check(readyThrows > 0, () => "T4: ready() ceiling never tripped over 10k distinct locales");
    const s = inst.stats();
    check(s.readySignalsCached === LOCALE_CACHE_MAX,
        () => "T4: readySignalsCached " + s.readySignalsCached + " != " + LOCALE_CACHE_MAX);
    check(s.pluralRulesCached <= LOCALE_CACHE_MAX && s.ordinalRulesCached <= LOCALE_CACHE_MAX,
        () => "T4: rules caches unbounded -- " + JSON.stringify(s));
    check(s.warningsSuppressed > 0,
        () => "T4: 10k invalid tags produced no suppressed warnings (I-19 budget inert)");

    // The process is NOT poisoned: a fresh instance constructs and renders.
    const fresh = createI18n({ locale: "en" });
    fresh.defineMessages("en", { hi: "hello" });
    check(fresh.t("hi") === "hello", () => "T4: a fresh instance is broken -- the shared pool was poisoned");

    // --- I-12: unloadLocale of a FALLBACK locale -----------------------------
    {
        const i = createI18n({ locale: "de", fallback: "en" });
        i.defineMessages("en", { greet: "hello" });
        i.defineMessages("de", { greet: "hallo" });
        check(i.t("greet") === "hallo", () => "T4: de should render before unload");
        const removed = i.unloadLocale("en"); // a fallback locale
        check(removed === true, () => "T4: unloadLocale('en') should report removal");
        check(i.stats().locales === 1, () => "T4: en dict not dropped");
        // de still resolves; the missing fallback just no longer contributes.
        check(i.t("greet") === "hallo", () => "T4: de broke after unloading its fallback");
    }

    // --- I-12: unloadLocale of the ACTIVE locale -> fallthrough + re-render ---
    {
        const i = createI18n({ locale: "de", fallback: "en" });
        i.defineMessages("en", { greet: "hello" });
        i.defineMessages("de", { greet: "hallo" });
        const seen = [];
        // A t() effect surrogate: read under the epoch so an unload re-resolves.
        const before = i.t("greet");
        seen.push(before);
        i.unloadLocale("de"); // the ACTIVE locale
        seen.push(i.t("greet"));
        check(seen[0] === "hallo" && seen[1] === "hello",
            () => "T4: unloading the active locale did not fall through to the fallback: " + JSON.stringify(seen));
    }

    // --- I-12: clear() with a load in flight ---------------------------------
    {
        const i = createI18n({ locale: "fr", fallback: "en" });
        i.defineMessages("en", { k: "en-v" });
        let resolveLoader;
        const pending = new Promise((res) => { resolveLoader = res; });
        const loadP = i.loadLocale("fr", () => pending);
        check(i.stats().loadsInFlight === 1, () => "T4: load should be in flight");
        i.clear(); // reset while the loader is pending
        check(i.stats().loadsInFlight === 0, () => "T4: clear() must drop the in-flight slot");
        check(i.stats().locales === 0, () => "T4: clear() must empty the dicts");
        // DECIDED POLICY: a loader already dispatched cannot be cancelled (it is
        // a live JS promise), so when it settles AFTER clear() it re-defines its
        // locale. This is documented, not garbage: clear() severs the in-flight
        // TRACKING, and the late write lands as an ordinary define. Guarding the
        // async write against a concurrent reset is the I-05 write-race, owned by
        // I3 -- not silently papered over here.
        resolveLoader({ k: "fr-late" });
        await loadP.catch(() => {});
        check(i.stats().locales === 1, () => "T4: the late load should re-define fr (documented): " + i.stats().locales);
        check(i.t("k") === "fr-late", () => "T4: late load did not land its dict: " + i.t("k"));
        // And the instance is fully usable afterward.
        i.locale.set("zz");
        i.defineMessages("zz", { k: "fresh" });
        check(i.t("k") === "fresh", () => "T4: instance unusable after clear()+late-load: " + i.t("k"));
    }

    // Pool hygiene: reclaim this tier's readiness-signal nodes for the rest of
    // the single-process run. No subscribers were attached, so this is clean.
    for (let k = 0; k < sigs.length; k++) dispose(sigs[k]);
}
