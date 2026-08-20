// Fixtures for the /lint checks (I4, v1.3.0). Beside test/13-lint.test.mjs.
//
// Two roles:
//   1. Dict-sets each check CATCHES and dict-sets each check PASSES.
//   2. A message CORPUS the render-observation parity gate drives: extractSlots
//      must equal the slot set the COMPILER actually honours on each message.
//
// The couplings from BRIEF.md are seeded here explicitly:
//   A  cardinal vs ordinal category sets (en ordinal needs one/two/few/other).
//   B  an invalid locale tag ("!!bad") -> a finding, never a throw.
//   C  a Russian `{=1 few many other}` missing the `one` KEYWORD is FLAGGED.
//   D  a nested plural variable is a slot; a translation dropping it is caught.

// ---------- PASS: a clean, dogfoodable multi-locale dict-set ----------
// Every reference key present in every locale; slot sets match; every plural
// token covers its locale's required categories (en: one/other cardinal,
// one/two/few/other ordinal; ru: one/few/many/other cardinal). All four checks
// return zero findings against this.
export const PASS_DICTS = {
    en: {
        greeting: "Hi {name}",
        inbox: "{n, plural, one {# message} other {# messages}}",
        rank: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
        gender: "{g, select, male {He} female {She} other {They}}",
        nested: "{g, select, male {He has {n, plural, one {# apple} other {# apples}}} other {none here}}",
        objForm: { one: "# file", other: "# files" },
    },
    ru: {
        greeting: "Privet {name}",
        inbox: "{n, plural, one {# soobshenie} few {# soobsheniya} many {# soobshenii} other {# soobshcheniya}}",
        rank: "{n, selectordinal, other {#-y}}",
        gender: "{g, select, male {On} female {Ona} other {Oni}}",
        nested: "{g, select, male {U nego {n, plural, one {# yabloko} few {# yabloka} many {# yablok} other {# yabloka}}} other {net}}",
        objForm: { one: "# fayl", few: "# fayla", many: "# faylov", other: "# fayla" },
    },
};

// ---------- checkCoverage ----------
// CATCH: ru is missing the `farewell` key that en defines.
export const COVERAGE_CATCH = {
    en: { hello: "Hi", farewell: "Bye" },
    ru: { hello: "Privet" },
};
// PASS: every en key present in ru.
export const COVERAGE_PASS = {
    en: { hello: "Hi", farewell: "Bye" },
    ru: { hello: "Privet", farewell: "Poka" },
};

// ---------- checkParity (coupling D) ----------
// CATCH: the ru `nested` translation drops the NESTED plural variable `n` -- a
// top-level-only scan would miss it and pass this.
export const PARITY_CATCH = {
    en: { nested: "{g, select, male {He has {n, plural, one {# apple} other {# apples}}} other {none}}" },
    ru: { nested: "{g, select, male {U nego yabloki} other {net}}" },
};
// PASS: both carry g and n.
export const PARITY_PASS = {
    en: { nested: "{g, select, male {He has {n, plural, one {# apple} other {# apples}}} other {none}}" },
    ru: { nested: "{g, select, male {U nego {n, plural, other {# yablok}}} other {net}}" },
};

// ---------- checkPluralCompleteness ----------
// CATCH (coupling C): ru plural carries `=1` but NOT the `one` keyword. `=1`
// catches the literal 1 only; ru `one` also covers 21/31/41, so this dict
// under-renders at count=21 and must be FLAGGED.
export const PLURAL_C_CATCH = {
    ru: { items: { "=1": "tochno odin", few: "few", many: "many", other: "other" } },
};
// CATCH (coupling A): an English selectordinal missing `two`/`few`. Cardinal
// categories (one/other) are NOT enough for an ordinal, which needs
// one/two/few/other. A checker using cardinal rules would pass this.
export const PLURAL_A_CATCH = {
    en: { rank: "{n, selectordinal, one {#st} other {#th}}" },
};
// CATCH (coupling B): an invalid locale tag must yield a finding, not a throw.
export const PLURAL_B_CATCH = {
    "!!bad": { items: "{n, plural, one {# item} other {# items}}" },
};
// PASS: en cardinal (one/other) and en ordinal (one/two/few/other) both complete.
export const PLURAL_PASS = {
    en: {
        items: "{n, plural, one {# item} other {# items}}",
        rank: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
    },
};
// PASS (coupling A, the other direction): a Russian selectordinal needs ONLY
// `other`. A checker using cardinal rules would wrongly demand one/few/many.
export const PLURAL_A_PASS_RU = {
    ru: { rank: "{n, selectordinal, other {#-y}}" },
};

// ---------- CORPUS for the render-observation parity gate ----------
// Every entry must compile cleanly. Variant text differs per branch so a
// selector's effect is observable by rendering.
export const CORPUS = [
    "Welcome",
    "Hi {name}",
    "{a} plus {b} equals {c}",
    "{n, plural, one {# item} other {# items}}",
    "{n, plural, =0 {none} one {# thing} other {# things}}",
    "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
    "{g, select, male {He} female {She} other {They}}",
    "{g, select, male {He has {n, plural, one {# apple} other {# apples}}} other {nobody has any}}",
    "Escaped '{'not a slot'}' but {real} is",
    "{outer, select, a {{inner, select, x {X here} other {default inner}}} other {default outer}}",
];
