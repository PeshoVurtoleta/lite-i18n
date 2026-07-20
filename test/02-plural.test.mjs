import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../I18n.js";

// ---------- plural-object dict entries (helper form) ----------

test("plural-object entry with one/other via plural() helper", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        items: { one: "{count} item", other: "{count} items" },
    });
    assert.equal(i.plural("items", 0), "0 items");
    assert.equal(i.plural("items", 1), "1 item");
    assert.equal(i.plural("items", 5), "5 items");
});

test("plural-object entry with # shortcut works", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        items: { one: "# item", other: "# items" },
    });
    assert.equal(i.plural("items", 3), "3 items");
});

test("plural-object entry with exact matches", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        items: {
            "=0": "no items",
            one: "1 item",
            other: "{count} items",
        },
    });
    assert.equal(i.plural("items", 0), "no items");
    assert.equal(i.plural("items", 1), "1 item");
    assert.equal(i.plural("items", 42), "42 items");
});

test("plural helper merges extra params", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        messages: {
            one: "{name}: # unread",
            other: "{name}: # unread",
        },
    });
    assert.equal(i.plural("messages", 3, { name: "Inbox" }), "Inbox: 3 unread");
});

test("plural-object with only 'other' works (fallback selector)", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: { other: "{count} things" } });
    assert.equal(i.plural("m", 1), "1 things");
    assert.equal(i.plural("m", 5), "5 things");
});

test("plural-object without 'other' is not treated as plural (falls back to nested dict)", () => {
    // Missing required 'other' selector -> not detected as plural-object -> treated as nested dict.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: { one: "just one" } });
    // Compiles as nested: m.one -> "just one"
    assert.equal(i.t("m.one"), "just one");
    // And plural(m, ...) misses because m itself is not a compiled entry.
    assert.equal(i.plural("m", 1), "m");
});

// ---------- Inline ICU plural ----------

test("inline plural: basic one/other", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{count, plural, one {# item} other {# items}}",
    });
    assert.equal(i.t("m", { count: 1 }), "1 item");
    assert.equal(i.t("m", { count: 4 }), "4 items");
});

test("inline plural: mixed literal + slot + plural block", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{name} added {count, plural, one {# comment} other {# comments}}",
    });
    assert.equal(i.t("m", { name: "Z", count: 1 }), "Z added 1 comment");
    assert.equal(i.t("m", { name: "Z", count: 7 }), "Z added 7 comments");
});

test("inline plural: exact match =0 wins over CLDR selector", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        cart: "{count, plural, =0 {empty} one {# item} other {# items}}",
    });
    assert.equal(i.t("cart", { count: 0 }), "empty");
    assert.equal(i.t("cart", { count: 1 }), "1 item");
    assert.equal(i.t("cart", { count: 2 }), "2 items");
});

test("inline plural: nested {slot} references outer params", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{count, plural, one {only {who}} other {all # of {who}}}",
    });
    assert.equal(i.t("m", { count: 1, who: "us" }), "only us");
    assert.equal(i.t("m", { count: 3, who: "us" }), "all 3 of us");
});

test("inline plural: unnamed variable via t (custom variable name)", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{apples, plural, one {# apple} other {# apples}}",
    });
    assert.equal(i.t("m", { apples: 1 }), "1 apple");
    assert.equal(i.t("m", { apples: 9 }), "9 apples");
});

test("inline plural: missing 'other' throws at compile time", () => {
    const i = createI18n();
    assert.throws(
        () => i.defineMessages("en", { m: "{n, plural, one {# item}}" }),
        SyntaxError
    );
});

// ---------- Locale-aware plural selection ----------

test("Bulgarian: one vs other", () => {
    // Bulgarian: 1 -> one, everything else -> other
    const i = createI18n({ locale: "bg" });
    i.defineMessages("bg", {
        items: { one: "# артикул", other: "# артикула" },
    });
    assert.equal(i.plural("items", 1), "1 артикул");
    assert.equal(i.plural("items", 2), "2 артикула");
    assert.equal(i.plural("items", 5), "5 артикула");
});

test("Polish: few/many/other selectors", () => {
    // Polish has three plural forms in most contexts: one, few, many, other.
    const i = createI18n({ locale: "pl" });
    i.defineMessages("pl", {
        items: {
            one: "# element",
            few: "# elementy",
            many: "# elementów",
            other: "# elementu",
        },
    });
    assert.equal(i.plural("items", 1), "1 element");
    assert.equal(i.plural("items", 2), "2 elementy");
    assert.equal(i.plural("items", 5), "5 elementów");
});

test("Arabic: zero/one/two/few/many/other", () => {
    const i = createI18n({ locale: "ar" });
    i.defineMessages("ar", {
        items: {
            zero: "لا شيء",
            one: "شيء واحد",
            two: "شيئان",
            few: "# أشياء",
            many: "# شيئا",
            other: "# شيء",
        },
    });
    assert.equal(i.plural("items", 0), "لا شيء");
    assert.equal(i.plural("items", 1), "شيء واحد");
    assert.equal(i.plural("items", 2), "شيئان");
});

test("switching locale changes plural selection", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        items: { one: "1 item", other: "{count} items" },
    });
    i.defineMessages("bg", {
        items: { one: "1 артикул", other: "{count} артикула" },
    });
    assert.equal(i.plural("items", 5), "5 items");
    i.locale.set("bg");
    assert.equal(i.plural("items", 5), "5 артикула");
});

test("plural for missing key returns key", () => {
    const i = createI18n({ locale: "en" });
    assert.equal(i.plural("nope", 3), "nope");
});

test("t() also works with plural-object entries when count in params", () => {
    // The helper is just sugar -- t(key, {count}) works for the same entry.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        items: { one: "{count} item", other: "{count} items" },
    });
    assert.equal(i.t("items", { count: 3 }), "3 items");
});

// ---------- Escapes inside plural sub-templates ----------

test("inline plural: '{' inside sub-template produces literal {", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{n, plural, one {'{'#'}' item} other {'{'#'}' items}}",
    });
    assert.equal(i.t("m", { n: 1 }), "{1} item");
    assert.equal(i.t("m", { n: 5 }), "{5} items");
});

test("inline plural: '#' inside sub-template produces literal #", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{n, plural, one {'#' # item} other {'#' # items}}",
    });
    assert.equal(i.t("m", { n: 1 }), "# 1 item");
    assert.equal(i.t("m", { n: 7 }), "# 7 items");
});

test("plural-object: '#' inside variant produces literal # (via helper)", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: {
            one: "'#' # item",
            other: "'#' # items",
        },
    });
    assert.equal(i.plural("m", 1), "# 1 item");
    assert.equal(i.plural("m", 5), "# 5 items");
});

// ---------- plural() helper on inline templates (regression) ----------
// v1.0 bug: plural(key, count) hardcoded merge under "count", so inline
// templates whose variable was named anything else (e.g. `{n, plural, ...}`)
// silently rendered with no numeric substitution and picked the "other"
// category regardless of the actual count. Fix: each compiled entry carries
// .pluralVar and plural() merges under it.

test("plural() on inline template with variable != 'count' uses the template's variable", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        files:    "{n, plural, one {# file} other {# files}}",
        apples:   "{apples, plural, one {# apple} other {# apples}}",
        withCount:"{count, plural, one {# item} other {# items}}",
    });
    assert.equal(i.plural("files", 1),     "1 file");
    assert.equal(i.plural("files", 5),     "5 files");
    assert.equal(i.plural("apples", 1),    "1 apple");
    assert.equal(i.plural("apples", 42),   "42 apples");
    assert.equal(i.plural("withCount", 1), "1 item");    // still works
    assert.equal(i.plural("withCount", 5), "5 items");
});

test("plural() on inline selectordinal also picks up the template's variable", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        place: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
    });
    assert.equal(i.plural("place", 1),  "1st");
    assert.equal(i.plural("place", 22), "22nd");
});

test("plural() on ambiguous multi-plural template falls back to 'count'", () => {
    // Two plurals with different variables at top level. plural() cannot
    // choose one; it merges as `count` (harmless -- the template doesn't
    // reference count) and the caller should use t() with explicit params.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{a, plural, one {A} other {As}} + {b, plural, one {B} other {Bs}}",
    });
    // Both plural variables undefined -> both pick "other" for numeric NaN in
    // Intl.PluralRules. Deterministic, non-throwing.
    const out = i.plural("m", 1);
    assert.equal(typeof out, "string");
    assert.ok(out.includes("+"));
});

test("plural() on static template is a no-op (renders template, ignores count)", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: "no plural here" });
    assert.equal(i.plural("m", 5), "no plural here");
});

// ---------- selectordinal (v1.1) ----------

test("selectordinal: English 1st/2nd/3rd/4th ordinal suffixes", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        place: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} place",
    });
    assert.equal(i.t("place", { n: 1 }), "1st place");
    assert.equal(i.t("place", { n: 2 }), "2nd place");
    assert.equal(i.t("place", { n: 3 }), "3rd place");
    assert.equal(i.t("place", { n: 4 }), "4th place");
});

test("selectordinal: English teens use 'other' (11th, 12th, 13th)", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        place: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} place",
    });
    // 11, 12, 13 are teens -> 'other' in English ordinal rules
    assert.equal(i.t("place", { n: 11 }), "11th place");
    assert.equal(i.t("place", { n: 12 }), "12th place");
    assert.equal(i.t("place", { n: 13 }), "13th place");
});

test("selectordinal: English 21st/22nd/23rd (teens exception ends)", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        place: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} place",
    });
    assert.equal(i.t("place", { n: 21 }), "21st place");
    assert.equal(i.t("place", { n: 22 }), "22nd place");
    assert.equal(i.t("place", { n: 23 }), "23rd place");
});

test("selectordinal: exact match =0 wins over CLDR selector", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{n, selectordinal, =0 {--} one {#st} two {#nd} few {#rd} other {#th}}",
    });
    assert.equal(i.t("m", { n: 0 }), "--");
    assert.equal(i.t("m", { n: 1 }), "1st");
});

test("selectordinal cache is isolated from cardinal cache", () => {
    // Same locale, both types used -> two separate cached Intl.PluralRules.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        n:    "{n, plural, one {# item} other {# items}}",
        rank: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
    });
    i.t("n", { n: 5 });
    i.t("rank", { n: 5 });
    const s = i.stats();
    assert.equal(s.pluralRulesCached, 1, "cardinal cached");
    assert.equal(s.ordinalRulesCached, 1, "ordinal cached separately");
});

test("selectordinal: missing 'other' throws at compile time", () => {
    const i = createI18n();
    assert.throws(
        () => i.defineMessages("en", {
            m: "{n, selectordinal, one {#st} two {#nd}}",
        }),
        SyntaxError
    );
});

test("selectordinal: unknown selector throws", () => {
    const i = createI18n();
    assert.throws(
        () => i.defineMessages("en", {
            m: "{n, selectordinal, one {#st} nope {?} other {#th}}",
        }),
        SyntaxError
    );
});

test("selectordinal: locale switch changes ordinal category", () => {
    // English ordinals are one/two/few/other. Bulgarian ordinals collapse
    // most numbers to "other". Same source, different categories.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
    });
    i.defineMessages("bg", {
        m: "{n, selectordinal, other {#-и}}",
    });
    assert.equal(i.t("m", { n: 3 }), "3rd");
    i.locale.set("bg");
    assert.equal(i.t("m", { n: 3 }), "3-и");
});
