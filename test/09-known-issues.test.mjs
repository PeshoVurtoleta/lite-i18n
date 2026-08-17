// Known-issue reproductions (I0, v1.1.3).
//
// These are NOT fixed this session -- they are the falsifiers the fixing
// sessions inherit. Each EXECUTES the reproduction and PINS the current (buggy)
// behaviour as a passing assertion whose message names the session that must
// flip it. So `npm test` is green today, the repro actually runs (a regression
// test that never failed is decoration), and the fix session cannot land
// without editing the pin here. Do not weaken a pin; flip it when you fix the
// code in the session that owns it.
//
//   I-01 -> FIXED in I1 (v1.1.4)   prototype pollution no longer selects a variant
//   I-03 -> FIXED in I2 (v1.2.0)   ready() no longer exhausts the lite-signal pool
//   I-05 -> I3 (v1.2.1)   loadLocale overwrites a later defineMessages

import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n, LocaleCapacityError, LOCALE_CACHE_MAX } from "../I18n.js";

// I-01 (S1, FIXED v1.1.4). Every read site is now hasOwn-guarded: the type-1
// slot, the type-2 plural/selectordinal variable, the type-3 select variable
// (all in renderTokens) and compilePluralObj's count read. Object.prototype
// can no longer decide which SENTENCE renders. This pin was flipped from "He"
// (the reproduced bug on 1.1.2/1.1.3) to "They" (the fix); the full matrix
// lives in test/torture/t2-identity.mjs and test/08-torture.test.mjs.
test("I-01: prototype pollution no longer selects a variant (fixed v1.1.4)", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { g: "{gender, select, male {He} female {She} other {They}}" });
    assert.equal(i.t("g", {}), "They", "unpolluted baseline changed");
    try {
        // eslint-disable-next-line no-extend-native
        Object.prototype.gender = "male";
        // The hasOwn guard rejects the inherited property: `other` still renders.
        assert.equal(
            i.t("g", {}), "They",
            "I-01 regression: an inherited Object.prototype.gender chose the variant again");
    } finally {
        delete Object.prototype.gender;
    }
});

// I-03 (S1, FIXED v1.2.0). Pre-fix, ready() lazily created and permanently
// cached one lite-signal per distinct locale string (in ready()). On lite-signal
// 1.4.0 the shared node pool (capacity 1024) threw CapacityError at ~1020
// distinct strings, and then createI18n() itself threw -- process-wide, across
// every lite-* package sharing the pool. Locale strings ARE untrusted input.
//
// I2's fix: the readiness cache fails CLOSED at LOCALE_CACHE_MAX (256) with a
// NAMED LocaleCapacityError (per-INSTANCE blast radius, not lite-signal's
// process-wide CapacityError), and stats() exposes readySignalsCached so the
// bound is observable. This pin was flipped from "the map grows unbounded" to
// "the map is bounded and the process survives". The rejected shared-singleton
// design (which would break the ready-before-load idiom) is NOT what landed;
// distinct per-locale signal identity is preserved (see
// test/11-locale-bounds.test.mjs and decisions/0003-locale-bounds.md).
test("I-03: ready() is bounded and fails closed (fixed v1.2.0)", () => {
    const i = createI18n({ locale: "en" });
    // Fill to the ceiling: querying readiness still must not define locales or
    // build plural rules.
    for (let n = 0; n < LOCALE_CACHE_MAX; n++) i.ready("locale-" + n);
    assert.equal(i.stats().locales, 0, "querying readiness must not define locales");
    assert.ok(i.stats().pluralRulesCached <= 1, "readiness queries must not build plural rules");
    assert.equal(i.stats().readySignalsCached, LOCALE_CACHE_MAX, "the readiness cache is now observable and bounded");
    // The (ceiling+1)th distinct locale fails closed with the NAMED error.
    let err;
    try { i.ready("one-past-the-ceiling"); } catch (e) { err = e; }
    assert.ok(err instanceof LocaleCapacityError, "I-03 fixed: a named, per-instance error, not a dependency's pool crash");
    // The process is NOT poisoned: a fresh instance still constructs and works.
    const j = createI18n({ locale: "en" });
    j.defineMessages("en", { k: "v" });
    assert.equal(j.t("k"), "v", "a fresh instance works -- the shared pool was not exhausted");
});

// I-05 (S2). A load in flight for 'fr', then a synchronous, intentional
// defineMessages('fr', ...), then the loader resolves: the async writer wins,
// silently, across the await boundary.
test("I-05: an in-flight load overwrites a later define (I3 must flip this)", async () => {
    const i = createI18n({ locale: "fr" });
    const p = i.loadLocale("fr", () => new Promise((res) => setTimeout(() => res({ k: "from-loader" }), 10)));
    i.defineMessages("fr", { k: "from-define" });
    assert.equal(i.t("k"), "from-define", "the synchronous define should be visible immediately");
    await p;
    // PINNED BUG: the async loader silently overwrote the explicit define. When
    // I3 makes the synchronous writer win, this becomes "from-define" -- flip it.
    assert.equal(
        i.t("k"), "from-loader",
        "I-05 no longer reproduces: I3 (v1.2.1) fixed the write race -- flip this pin to 'from-define'");
});
