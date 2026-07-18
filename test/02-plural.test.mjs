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
