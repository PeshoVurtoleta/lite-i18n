import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createI18n } from "../I18n.js";

// ---------- select: basic dispatch ----------

test("select dispatches on string param", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{gender, select, male {He} female {She} other {They}}",
    });
    assert.equal(i.t("m", { gender: "male" }), "He");
    assert.equal(i.t("m", { gender: "female" }), "She");
    assert.equal(i.t("m", { gender: "nonbinary" }), "They");
});

test("select falls back to 'other' for missing param", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{role, select, admin {A} owner {O} other {?}}",
    });
    assert.equal(i.t("m"), "?");
    assert.equal(i.t("m", {}), "?");
    assert.equal(i.t("m", { role: null }), "?");
});

test("select with numeric-looking string selector", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{tier, select, gold {G} silver {S} bronze {B} other {?}}",
    });
    assert.equal(i.t("m", { tier: "gold" }), "G");
});

// ---------- select: missing 'other' rejected at compile ----------

test("select without 'other' throws SyntaxError", () => {
    const i = createI18n();
    assert.throws(
        () => i.defineMessages("en", {
            m: "{g, select, male {He} female {She}}",
        }),
        SyntaxError
    );
});

// ---------- select: nested slots and mixed content ----------

test("select variants can contain nested slots", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{gender, select, male {Mr. {name}} female {Ms. {name}} other {{name}}}",
    });
    assert.equal(i.t("m", { gender: "male", name: "Smith" }), "Mr. Smith");
    assert.equal(i.t("m", { gender: "female", name: "Jones" }), "Ms. Jones");
    assert.equal(i.t("m", { gender: "x", name: "Smith" }), "Smith");
});

test("select embedded in literal text", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "Welcome, {gender, select, male {sir} female {ma'am} other {friend}}!",
    });
    assert.equal(i.t("m", { gender: "male" }), "Welcome, sir!");
    assert.equal(i.t("m", { gender: "female" }), "Welcome, ma'am!");
    assert.equal(i.t("m", { gender: "x" }), "Welcome, friend!");
});

test("select variants support the same ICU escapes as elsewhere", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{g, select, code {'{' brace '}'} other {no brace}}",
    });
    assert.equal(i.t("m", { g: "code" }), "{ brace }");
    assert.equal(i.t("m", { g: "x" }), "no brace");
});

// ---------- select + plural composition ----------

test("select variants can wrap plural blocks", () => {
    // Multi-axis message pattern: gender × count. Manual layering avoids
    // nested-plural complexity while covering the real-world use case.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{gender, select, "
            + "male {He has {n, plural, one {# apple} other {# apples}}} "
            + "female {She has {n, plural, one {# apple} other {# apples}}} "
            + "other {They have {n, plural, one {# apple} other {# apples}}}}",
    });
    assert.equal(i.t("m", { gender: "male", n: 1 }),   "He has 1 apple");
    assert.equal(i.t("m", { gender: "female", n: 5 }), "She has 5 apples");
    assert.equal(i.t("m", { gender: "x", n: 3 }),      "They have 3 apples");
});

// ---------- select is locale-independent for selection ----------

test("select selection does NOT depend on locale (no PluralRules)", () => {
    // Confirms select is cheaper than plural: no Intl.PluralRules construction,
    // no locale-dependent dispatch. Only the sub-template rendering can vary
    // by locale via nested slots, not the selector itself.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{k, select, a {A} b {B} other {O}}",
    });
    assert.equal(i.t("m", { k: "a" }), "A");
    i.locale.set("bg");
    // Even without a bg dict, the key returns literal -- but we want to prove
    // select doesn't touch PluralRules. Add a bg dict:
    i.defineMessages("bg", { m: "{k, select, a {А} b {Б} other {О}}" });
    assert.equal(i.t("m", { k: "a" }), "А");
    // ordinalRulesCached should still be 0 -- select doesn't build any.
    assert.equal(i.stats().ordinalRulesCached, 0);
});

test("select re-fires effect on locale switch when variant text differs", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: "{g, select, male {He} other {They}}" });
    i.defineMessages("bg", { m: "{g, select, male {Той} other {Те}}" });
    const seen = [];
    effect(() => seen.push(i.t("m", { g: "male" })));
    i.locale.set("bg");
    i.locale.set("en");
    assert.deepEqual(seen, ["He", "Той", "He"]);
});

// ---------- select rejection cases ----------

test("select with empty selector name throws", () => {
    const i = createI18n();
    assert.throws(
        () => i.defineMessages("en", { m: "{g, select, {A} other {O}}" }),
        SyntaxError
    );
});

test("select selector followed by non-brace throws", () => {
    const i = createI18n();
    assert.throws(
        () => i.defineMessages("en", { m: "{g, select, male X other {O}}" }),
        SyntaxError
    );
});

// ---------- select vs plural discrimination in parser ----------

test("select and plural coexist as sibling entries", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        greeting: "{g, select, male {sir} female {ma'am} other {friend}}",
        items:    "{n, plural, one {# item} other {# items}}",
    });
    assert.equal(i.t("greeting", { g: "male" }), "sir");
    assert.equal(i.t("items", { n: 7 }), "7 items");
});
