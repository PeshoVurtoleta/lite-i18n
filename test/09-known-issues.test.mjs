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
//   I-03 -> I2 (v1.2.0)   ready() exhausts the lite-signal node pool
//   I-05 -> I3 (v1.2.1)   loadLocale overwrites a later defineMessages

import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../I18n.js";

// I-01 (S1, FIXED v1.1.4). Every read site is now hasOwn-guarded: the type-1
// slot, the type-2 plural/selectordinal variable (I18n.js:354), the type-3
// select variable (:367) and compilePluralObj's count (:462). Object.prototype
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

// I-03 (S1). ready() lazily creates and permanently caches one lite-signal per
// distinct locale string (I18n.js:684). On the installed lite-signal 1.4.0 the
// shared node pool (capacity 1024) throws CapacityError at ~1018 distinct
// strings, and then createI18n() itself throws -- process-wide, across every
// lite-* package sharing the pool. Locale strings ARE untrusted input.
//
// The crash is DOCUMENTED, not executed: exhausting the pool would poison every
// other test in this process. Repro (run standalone):
//   const i = createI18n(); for (let n = 0; n < 1100; n++) i.ready('x' + n);
//   -> throws CapacityError near n=1018; the next createI18n() throws too.
// This test executes a SAFE sub-threshold slice and pins the current shape:
// ready() on never-defined locales does not define a locale or build plural
// rules, yet (the bug) caches an unbounded signal per string. I2 lands the
// bound (a shared permanently-false singleton + a ceiling) and adds
// stats().readySignalsCached; when it does, assert that counter here.
test("I-03: ready() caches per-locale without a bound (I2 adds the ceiling)", () => {
    const i = createI18n({ locale: "en" });
    const SAFE = 200; // well under the 1024 pool cap -- never poisons the process
    for (let n = 0; n < SAFE; n++) i.ready("locale-" + n);
    assert.equal(i.stats().locales, 0, "querying readiness must not define locales");
    assert.ok(i.stats().pluralRulesCached <= 1, "readiness queries must not build plural rules");
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
