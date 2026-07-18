import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    createI18n,
    setDefaultI18n,
    t as topT,
    defineMessages as topDefine,
    locale as topLocale,
    MissingKeyError,
} from "../I18n.js";

test("static message returns literal", () => {
    const i = createI18n();
    i.defineMessages("en", { hello: "Hello!" });
    assert.equal(i.t("hello"), "Hello!");
});

test("simple {name} interpolation", () => {
    const i = createI18n();
    i.defineMessages("en", { greet: "Hi, {name}!" });
    assert.equal(i.t("greet", { name: "Zahary" }), "Hi, Zahary!");
});

test("multi-slot interpolation preserves order", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "{a} and {b} and {a}" });
    assert.equal(i.t("m", { a: "X", b: "Y" }), "X and Y and X");
});

test("numeric interpolation stringifies", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "You: {age}" });
    assert.equal(i.t("m", { age: 42 }), "You: 42");
});

test("nested dict flattens with dot paths", () => {
    const i = createI18n();
    i.defineMessages("en", {
        header: { title: "Welcome", subtitle: "Sign in below" },
        footer: { copyright: "(c) 2026" },
    });
    assert.equal(i.t("header.title"), "Welcome");
    assert.equal(i.t("header.subtitle"), "Sign in below");
    assert.equal(i.t("footer.copyright"), "(c) 2026");
});

test("cumulative defineMessages merges", () => {
    const i = createI18n();
    i.defineMessages("en", { a: "A" });
    i.defineMessages("en", { b: "B" });
    assert.equal(i.t("a"), "A");
    assert.equal(i.t("b"), "B");
});

test("defineMessages for a locale replaces existing keys", () => {
    const i = createI18n();
    i.defineMessages("en", { greet: "Hi" });
    i.defineMessages("en", { greet: "Hello" });
    assert.equal(i.t("greet"), "Hello");
});

test("locale switch triggers effect re-run", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { hi: "Hi" });
    i.defineMessages("bg", { hi: "Здравей" });
    const seen = [];
    effect(() => seen.push(i.t("hi")));
    i.locale.set("bg");
    i.locale.set("en");
    assert.deepEqual(seen, ["Hi", "Здравей", "Hi"]);
});

test("defineMessages during effect run triggers re-fire", () => {
    const i = createI18n({ locale: "en" });
    const seen = [];
    effect(() => seen.push(i.t("hi")));
    // Initially missing -> returns key
    assert.equal(seen[0], "hi");
    i.defineMessages("en", { hi: "Hi" });
    assert.equal(seen[seen.length - 1], "Hi");
});

test("missing key policy 'key' returns key literal (default)", () => {
    const i = createI18n();
    assert.equal(i.t("nope"), "nope");
});

test("missing key policy 'throw' throws MissingKeyError", () => {
    const i = createI18n({ missingKeyPolicy: "throw" });
    assert.throws(() => i.t("nope"), MissingKeyError);
});

test("missing key policy 'warn' warns and returns key", () => {
    const i = createI18n({ missingKeyPolicy: "warn" });
    const orig = console.warn;
    let warned = null;
    console.warn = (msg) => { warned = msg; };
    try {
        const r = i.t("nope");
        assert.equal(r, "nope");
        assert.match(warned, /Missing key/);
    } finally {
        console.warn = orig;
    }
});

test("onMissingKey hook overrides", () => {
    const i = createI18n({
        onMissingKey: (key) => `[[${key}]]`,
    });
    assert.equal(i.t("nope"), "[[nope]]");
});

test("onMissingKey returning void falls through to policy", () => {
    const i = createI18n({
        missingKeyPolicy: "key",
        onMissingKey: () => undefined,
    });
    assert.equal(i.t("nope"), "nope");
});

test("setMissingKeyPolicy at runtime", () => {
    const i = createI18n();
    i.setMissingKeyPolicy("throw");
    assert.throws(() => i.t("nope"), MissingKeyError);
    i.setMissingKeyPolicy("key");
    assert.equal(i.t("nope"), "nope");
});

test("createI18n instances are isolated", () => {
    const a = createI18n({ locale: "en" });
    const b = createI18n({ locale: "en" });
    a.defineMessages("en", { hi: "A" });
    b.defineMessages("en", { hi: "B" });
    assert.equal(a.t("hi"), "A");
    assert.equal(b.t("hi"), "B");
    a.locale.set("bg");
    assert.equal(b.locale.peek(), "en");
});

test("config.messages pre-loads dicts", () => {
    const i = createI18n({
        locale: "en",
        messages: {
            en: { hi: "Hi" },
            bg: { hi: "Здравей" },
        },
    });
    assert.equal(i.t("hi"), "Hi");
    i.locale.set("bg");
    assert.equal(i.t("hi"), "Здравей");
});

test("stats reports current state", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { a: "A", b: { c: "C" } });
    i.defineMessages("bg", { a: "А" });
    const s = i.stats();
    assert.equal(s.locales, 2);
    assert.equal(s.keys, 3);           // en.a, en.b.c, bg.a
    assert.equal(s.currentLocale, "en");
});

test("top-level t routes to default instance", () => {
    const custom = createI18n({ locale: "en" });
    custom.defineMessages("en", { hello: "Hello from custom" });
    setDefaultI18n(custom);
    assert.equal(topT("hello"), "Hello from custom");
    // Reset default for other tests -- fresh instance.
    setDefaultI18n(createI18n());
});

test("top-level defineMessages + locale routes to default", () => {
    const fresh = createI18n({ locale: "en" });
    setDefaultI18n(fresh);
    topDefine("en", { x: "X" });
    assert.equal(topT("x"), "X");
    assert.equal(topLocale.peek(), "en");
    setDefaultI18n(createI18n());
});

test("missing param on slot template renders empty string, not 'undefined'", () => {
    // Nullish coalesce (?? "") on the hot path -- prevents "undefined" from
    // bleeding into the DOM when a caller forgets a param.
    const i = createI18n();
    i.defineMessages("en", { m: "Hi, {name}!" });
    assert.equal(i.t("m"), "Hi, !");
});

test("explicit null param also renders empty string", () => {
    // Common when params come from JSON -- missing fields serialise as null.
    const i = createI18n();
    i.defineMessages("en", { m: "Hi, {name}!" });
    assert.equal(i.t("m", { name: null }), "Hi, !");
});

test("empty string param renders empty (no coalesce)", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "Hi, {name}!" });
    assert.equal(i.t("m", { name: "" }), "Hi, !");
});

test("zero param renders '0' (0 is not nullish)", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "Count: {n}" });
    assert.equal(i.t("m", { n: 0 }), "Count: 0");
});

test("escape: '{' produces literal '{'", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "Use '{'name'}' as the slot" });
    assert.equal(i.t("m"), "Use {name} as the slot");
});

test("escape: '}' produces literal '}'", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "Close with '}'." });
    assert.equal(i.t("m"), "Close with }.");
});

test("escape: '' produces literal apostrophe", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "It''s fine" });
    assert.equal(i.t("m"), "It's fine");
});

test("escape: bare apostrophe stays literal (no ICU quoted-string mode)", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "It's fine" });
    assert.equal(i.t("m"), "It's fine");
});

test("escape: literal braces mix with real slots", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "'{' {name} '}'" });
    assert.equal(i.t("m", { name: "x" }), "{ x }");
});

test("escape: '{name}' produces literal {name} (whole slot quoted)", () => {
    // The full ICU quoted-string behavior: an apostrophe before { opens a
    // quoted section that runs until the next apostrophe. The slot is not
    // parsed. This is what makes docs/prose about the template DSL possible.
    const i = createI18n();
    i.defineMessages("en", { m: "Use '{name}' as a slot" });
    assert.equal(i.t("m", { name: "IGNORED" }), "Use {name} as a slot");
});

test("escape: '' inside a quoted section stays literal apostrophe", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "'{it''s}'" });
    assert.equal(i.t("m"), "{it's}");
});

test("Intl.PluralRules with invalid locale warns once, falls back", () => {
    const orig = console.warn;
    const warned = [];
    console.warn = (msg) => warned.push(msg);
    try {
        const i = createI18n({ locale: "not_a_locale_$" });
        i.defineMessages("not_a_locale_$", {
            m: { one: "one", other: "many" },
        });
        // First call triggers the fallback + warn.
        const r1 = i.plural("m", 5);
        assert.equal(typeof r1, "string");
        // Second call hits the cache -- no additional warn.
        const r2 = i.plural("m", 5);
        assert.equal(typeof r2, "string");
        assert.equal(warned.length, 1);
        assert.match(warned[0], /Intl\.PluralRules|Invalid|locale/i);
    } finally {
        console.warn = orig;
    }
});

test("SyntaxError on unmatched brace at compile time", () => {
    const i = createI18n();
    assert.throws(
        () => i.defineMessages("en", { bad: "Hi, {name" }),
        SyntaxError
    );
});

test("MissingKeyError carries key and locale", () => {
    const i = createI18n({ locale: "bg", missingKeyPolicy: "throw" });
    try {
        i.t("nope");
        assert.fail("expected throw");
    } catch (e) {
        assert.ok(e instanceof MissingKeyError);
        assert.equal(e.key, "nope");
        assert.equal(e.locale, "bg");
    }
});

test("dispose (via internal reset) — cleanup after tests", () => {
    setDefaultI18n(createI18n());
});

// ---------- Regressions from external review ----------

test("prototype-chain param keys do not leak (constructor / __proto__)", () => {
    // {constructor} previously rendered "function Object() { [native code] }".
    // Object.hasOwn on the hot path rejects inherited reads.
    const i = createI18n();
    i.defineMessages("en", {
        a: "{constructor}",
        b: "{__proto__}",
        c: "{toString}",
    });
    assert.equal(i.t("a", {}), "");
    assert.equal(i.t("b", {}), "");
    assert.equal(i.t("c", {}), "");
    // Own-property with the same name still works.
    assert.equal(i.t("a", { constructor: "yes" }), "yes");
});

test("unsupported ICU argument at define time throws SyntaxError", () => {
    // Silent empty-string rendering of {n, number}, {d, date, short},
    // {gender, select, ...} etc. was the worst kind of translator footgun --
    // no signal that the shape was unsupported. Fail loudly at compile time.
    const i = createI18n();
    assert.throws(() => i.defineMessages("en", { m: "{n, number}" }), SyntaxError);
    assert.throws(() => i.defineMessages("en", { m: "Due {d, date, short}" }), SyntaxError);
    assert.throws(
        () => i.defineMessages("en", { m: "{g, select, male {He} other {They}}" }),
        SyntaxError
    );
});

test("top-level '#' dequotes the same way as inside plural sub-templates", () => {
    // Same source string, same result regardless of nesting depth.
    const i = createI18n();
    i.defineMessages("en", {
        top:    "Rank '#'1",
        inside: "{n, plural, other {Rank '#'1}}",
    });
    assert.equal(i.t("top"), "Rank #1");
    assert.equal(i.t("inside", { n: 5 }), "Rank #1");
});

test("defineMessages is atomic: bad template rolls back the whole batch", () => {
    const i = createI18n({ locale: "en" });
    // Pre-existing key stays untouched.
    i.defineMessages("en", { keep: "kept" });
    assert.throws(() => i.defineMessages("en", {
        good: "ok",
        bad: "Hi, {name",     // unmatched brace -> SyntaxError
        alsoGood: "also ok",
    }), SyntaxError);
    // None of the batch committed.
    assert.equal(i.t("good"), "good");
    assert.equal(i.t("alsoGood"), "alsoGood");
    // Prior key untouched.
    assert.equal(i.t("keep"), "kept");
});

test("nested namespace named 'other' is not misclassified as a plural", () => {
    // Previously: { menu: { other: { label } } } was treated as plural because
    // `other` is a CLDR key -- compilePluralObj then dropped the non-string
    // value, resulting in silent key loss and a raw TypeError at render.
    const i = createI18n();
    i.defineMessages("en", {
        menu: { other: { label: "Other" }, primary: { label: "Primary" } },
    });
    assert.equal(i.t("menu.other.label"), "Other");
    assert.equal(i.t("menu.primary.label"), "Primary");
});

test("unknown plural selector throws at define time (typos)", () => {
    const i = createI18n();
    assert.throws(
        () => i.defineMessages("en", { m: "{n, plural, mnay {many} other {o}}" }),
        SyntaxError
    );
    assert.throws(
        () => i.defineMessages("en", { m: "{n, plural, aother {?} other {o}}" }),
        SyntaxError
    );
});
