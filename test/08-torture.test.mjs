import { test } from "node:test";
import assert from "node:assert/strict";
import { effect, batch } from "@zakkster/lite-signal";
import { createI18n } from "../I18n.js";

// ============================================================================
//  Small errors -- defensive coverage of the tiniest surface details
// ============================================================================

test("torture: empty template renders empty string", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "" });
    assert.equal(i.t("m"), "");
});

test("torture: template that is just whitespace preserves it", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "   \t\n   " });
    assert.equal(i.t("m"), "   \t\n   ");
});

test("torture: single slot with no surrounding literal", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "{x}" });
    assert.equal(i.t("m", { x: "only" }), "only");
});

test("torture: slot key with digits is a valid identifier", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "{item1} vs {item2}" });
    assert.equal(i.t("m", { item1: "A", item2: "B" }), "A vs B");
});

test("torture: defineMessages with undefined dict throws TypeError", () => {
    const i = createI18n();
    assert.throws(() => i.defineMessages("en", undefined), TypeError);
    assert.throws(() => i.defineMessages("en", null), TypeError);
});

test("torture: defineMessages with non-string locale throws TypeError", () => {
    const i = createI18n();
    assert.throws(() => i.defineMessages(123, { m: "x" }), TypeError);
    assert.throws(() => i.defineMessages(null, { m: "x" }), TypeError);
});

// ============================================================================
//  Unicode -- combining chars, RTL, emoji, surrogate pairs, ZWJ
// ============================================================================

test("torture: emoji in slot values render intact", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "Hello {name}" });
    assert.equal(i.t("m", { name: "🎉🌍" }), "Hello 🎉🌍");
});

test("torture: family ZWJ emoji preserved", () => {
    // 👨‍👩‍👧‍👦 -- man + ZWJ + woman + ZWJ + girl + ZWJ + boy
    const i = createI18n();
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
    i.defineMessages("en", { m: "{who}" });
    assert.equal(i.t("m", { who: family }), family);
});

test("torture: RTL text in templates and params", () => {
    const i = createI18n({ locale: "ar" });
    i.defineMessages("ar", { m: "مرحبا {name}" });
    assert.equal(i.t("m", { name: "زهاري" }), "مرحبا زهاري");
});

test("torture: combining characters (é as e + combining acute)", () => {
    const i = createI18n();
    const composed = "café";                    // NFC
    const decomposed = "cafe\u0301";            // NFD (e + U+0301)
    i.defineMessages("en", { a: "{x}", b: "{x}" });
    assert.equal(i.t("a", { x: composed }), composed);
    assert.equal(i.t("b", { x: decomposed }), decomposed);
    // Both are preserved as-is; we don't normalize.
});

test("torture: surrogate pairs in template survive tokenization", () => {
    // 𝓗𝓮𝓵𝓵𝓸 -- mathematical script capital letters, all above U+10000
    const i = createI18n();
    i.defineMessages("en", { m: "𝓗𝓮𝓵𝓵𝓸, {name}!" });
    assert.equal(i.t("m", { name: "Z" }), "𝓗𝓮𝓵𝓵𝓸, Z!");
});

test("torture: zero-width space between slot and delimiter", () => {
    // U+200B is not whitespace to charCodeAt <= 32; must pass through literally.
    const i = createI18n();
    i.defineMessages("en", { m: "a\u200B{x}\u200Bb" });
    assert.equal(i.t("m", { x: "-" }), "a\u200B-\u200Bb");
});

// ============================================================================
//  Regex-eating templates -- strings crafted to confuse the plural detector
// ============================================================================

test("torture: literal comma in text (outside braces) is literal", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "hello, {name}, and everyone" });
    assert.equal(i.t("m", { name: "Z" }), "hello, Z, and everyone");
});

test("torture: slot named 'plural' is not confused with plural syntax", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "the {plural} of ox" });
    assert.equal(i.t("m", { plural: "plural" }), "the plural of ox");
});

test("torture: slot named 'select' or 'selectordinal' is not confused", () => {
    const i = createI18n();
    i.defineMessages("en", {
        a: "{select}",
        b: "{selectordinal}",
    });
    assert.equal(i.t("a", { select: "x" }), "x");
    assert.equal(i.t("b", { selectordinal: "y" }), "y");
});

test("torture: template with the literal string 'plural,' as text works", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "the word plural, when written literally" });
    assert.equal(i.t("m"), "the word plural, when written literally");
});

test("torture: brace immediately followed by close brace parses as empty-key slot", () => {
    // {} -- inner is empty string, key.trim() is "", no comma -> slot with "" key.
    // params[""] returns undefined unless explicitly set. Deterministic behavior.
    const i = createI18n();
    i.defineMessages("en", { m: "before {} after" });
    assert.equal(i.t("m"), "before  after");    // "" + "" + "" between literals
    assert.equal(i.t("m", { "": "X" }), "before X after");
});

test("torture: whitespace-only slot key trims to empty", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "before {   } after" });
    assert.equal(i.t("m"), "before  after");
});

// ============================================================================
//  Parser corner cases -- deep nesting, long inputs, malformed patterns
// ============================================================================

test("torture: 100 levels of nested dict flatten to dot-path", () => {
    const i = createI18n();
    let dict = { leaf: "found" };
    let key = "leaf";
    for (let k = 0; k < 100; k++) {
        dict = { ["l" + k]: dict };
        key = "l" + k + "." + key;
    }
    i.defineMessages("en", dict);
    assert.equal(i.t(key), "found");
});

test("torture: template with 1000 slots compiles and renders", () => {
    const i = createI18n();
    let template = "";
    const params = {};
    for (let k = 0; k < 1000; k++) {
        template += "-{s" + k + "}";
        params["s" + k] = String(k);
    }
    i.defineMessages("en", { m: template });
    const out = i.t("m", params);
    // Expected: "-0-1-...-999" -- 1000 dashes + digit chars of 0..999.
    // digits: 10*1 (0-9) + 90*2 (10-99) + 900*3 (100-999) = 2890
    assert.equal(out.length, 1000 + 2890);
    assert.ok(out.startsWith("-0-1-2-"));
    assert.ok(out.endsWith("-999"));
});

test("torture: plural with =0 through =50 exact matches", () => {
    const i = createI18n({ locale: "en" });
    let body = "";
    for (let k = 0; k <= 50; k++) body += `=${k} {exact${k}} `;
    body += "one {one} other {other}";
    i.defineMessages("en", { m: "{n, plural, " + body + "}" });
    assert.equal(i.t("m", { n: 0 }),  "exact0");
    assert.equal(i.t("m", { n: 25 }), "exact25");
    assert.equal(i.t("m", { n: 50 }), "exact50");
    assert.equal(i.t("m", { n: 51 }), "other");
});

test("torture: malformed exact =-1 is NOT recognised as exact", () => {
    // Sign is not part of the =N syntax; =-1 is parsed as = (empty digits)
    // followed by -1 as literal, which is not a valid selector.
    const i = createI18n();
    assert.throws(
        () => i.defineMessages("en", { m: "{n, plural, =-1 {a} other {b}}" }),
        SyntaxError
    );
});

test("torture: malformed exact = (no digits) throws", () => {
    const i = createI18n();
    assert.throws(
        () => i.defineMessages("en", { m: "{n, plural, = {a} other {b}}" }),
        SyntaxError
    );
});

test("torture: plural with duplicate CLDR selector -- last wins", () => {
    // Compiler doesn't reject duplicates; Map.set overwrites. Documented
    // behavior via this test -- if we later want to reject, add a check.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: "{n, plural, one {A} one {B} other {O}}" });
    assert.equal(i.t("m", { n: 1 }), "B");
});

// ============================================================================
//  Runtime numeric edges -- Infinity, NaN, BigInt, negative, huge
// ============================================================================

test("torture: plural with negative count uses |n| for category selection", () => {
    // Intl.PluralRules(en).select(-1) === "one" -- CLDR rules use absolute
    // value for category matching in English. -5 -> "other". This is spec.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: { one: "one item", other: "many items" } });
    assert.equal(i.plural("m", -1), "one item");
    assert.equal(i.plural("m", -5), "many items");
});

test("torture: plural with Infinity does not throw", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: { one: "one", other: "many" } });
    // Intl.PluralRules(Infinity) -> "other" in all sane implementations
    assert.equal(i.plural("m", Infinity), "many");
});

test("torture: plural with NaN does not throw", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: { one: "one", other: "many" } });
    // Intl.PluralRules(NaN) -> "other"
    const out = i.plural("m", NaN);
    assert.equal(typeof out, "string");
});

test("torture: plural with 1e20 (very large number) works", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: { one: "one", other: "many" } });
    assert.equal(i.plural("m", 1e20), "many");
});

test("torture: plural with BigInt throws (spec) -- caller must convert", () => {
    // Intl.PluralRules.select() is spec'd to take a Number; BigInt throws
    // "Cannot convert a BigInt value to a number". This is not a lite-i18n
    // failure but a language-level constraint the caller must respect.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: { one: "one", other: "many" } });
    assert.throws(() => i.plural("m", 5n), /BigInt/i);
    // Explicit conversion by the caller works.
    assert.equal(i.plural("m", Number(5n)), "many");
});

// ============================================================================
//  Params -- degenerate shapes, prototype pollution, symbol keys
// ============================================================================

test("torture: null-prototype params object works", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "Hi {name}" });
    const params = Object.create(null);
    params.name = "Z";
    assert.equal(i.t("m", params), "Hi Z");
});

test("torture: frozen params object works (no mutation attempted)", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "Hi {name}" });
    const params = Object.freeze({ name: "Z" });
    assert.equal(i.t("m", params), "Hi Z");
});

test("torture: params with getter that throws -- error propagates", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "Hi {name}" });
    const params = { get name() { throw new Error("boom in getter"); } };
    // We don't try/catch user code; a throwing getter surfaces to the caller.
    assert.throws(() => i.t("m", params), /boom in getter/);
});

test("torture: Symbol-keyed params values are inaccessible via slot name", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "Hi {name}" });
    const sym = Symbol("name");
    const params = { [sym]: "SYMBOL", name: "STRING" };
    assert.equal(i.t("m", params), "Hi STRING");
});

test("torture: {__proto__} does not leak Object.prototype (hasOwn guard)", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "{__proto__}" });
    assert.equal(i.t("m", {}), "");
    // But explicit own-property is honored.
    const params = Object.create(null);
    params.__proto__ = "explicit";
    assert.equal(i.t("m", params), "explicit");
});

test("torture: attempted prototype pollution via params does not affect Object.prototype", () => {
    const i = createI18n();
    i.defineMessages("en", { m: "{k}" });
    // Even if a user does something weird, we only READ params.
    const params = { k: "safe" };
    Object.defineProperty(Object.prototype, "pollute", { value: "gotcha", configurable: true });
    try {
        assert.equal(i.t("m", params), "safe");
        // Confirm hasOwn guard rejects the pollution attempt on OTHER templates.
        i.defineMessages("en", { p: "{pollute}" });
        assert.equal(i.t("p", params), "");
    } finally {
        delete Object.prototype.pollute;
    }
});

// ============================================================================
//  Reactive edges -- reentrant effects, nested effects, hook recursion
// ============================================================================

test("torture: locale.set inside effect body updates state without re-firing itself (loop prevention)", () => {
    // lite-signal's semantics: a set from within an effect's own body does
    // not synchronously re-fire that effect. This is deliberate loop
    // prevention. The set still takes effect for OTHER observers and for
    // subsequent external triggers -- we're just proving no runaway here.
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: "en" });
    i.defineMessages("bg", { m: "bg" });
    let steps = 0;
    effect(() => {
        i.t("m");
        steps++;
        if (steps === 1) i.locale.set("bg");
    });
    assert.equal(i.locale.peek(), "bg", "state updated");
    assert.equal(steps, 1, "effect did not recursively re-fire");
});

test("torture: nested effects reading t() both re-fire on locale change", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { a: "a-en", b: "b-en" });
    i.defineMessages("bg", { a: "a-bg", b: "b-bg" });
    const outer = [];
    const inner = [];
    effect(() => {
        outer.push(i.t("a"));
        effect(() => { inner.push(i.t("b")); });
    });
    i.locale.set("bg");
    assert.ok(outer.includes("a-en"));
    assert.ok(outer.includes("a-bg"));
    assert.ok(inner.includes("b-en"));
    assert.ok(inner.includes("b-bg"));
});

test("torture: onMissingKey that calls t() does not infinite-loop", () => {
    // Hook returns a string, short-circuiting the policy. Even if the hook
    // calls t() for another key, no recursion into the same missing key.
    const i = createI18n();
    i.defineMessages("en", { fallback: "FB" });
    i.onMissingKey((k) => `[${i.t("fallback")}:${k}]`);
    assert.equal(i.t("does-not-exist"), "[FB:does-not-exist]");
});

test("torture: setFallback with self-reference is harmless", () => {
    // Active locale is 'en'; fallback ['en', 'bg'] should skip 'en' in walk.
    const i = createI18n({ locale: "en" });
    i.defineMessages("bg", { hi: "Здравей" });
    i.setFallback(["en", "en", "bg"]);           // multi-self-ref
    assert.equal(i.t("hi"), "Здравей");
});

test("torture: fallback chain of length 50 walks in order", () => {
    const i = createI18n({ locale: "z0" });
    const chain = [];
    for (let k = 1; k < 50; k++) chain.push("z" + k);
    i.defineMessages("z49", { hi: "found" });
    i.setFallback(chain);
    assert.equal(i.t("hi"), "found");
});

// ============================================================================
//  Async torture -- concurrent loads, mid-load switch, reentrant loader
// ============================================================================

test("torture: parallel loadLocale of 10 locales completes cleanly", async () => {
    const i = createI18n({ locale: "en" });
    const promises = [];
    for (let k = 0; k < 10; k++) {
        const loc = "lang" + k;
        promises.push(i.loadLocale(loc, async () => ({ hi: "hi-" + loc })));
    }
    await Promise.all(promises);
    for (let k = 0; k < 10; k++) {
        i.locale.set("lang" + k);
        assert.equal(i.t("hi"), "hi-lang" + k);
    }
    // All settled -- inflight should be zero.
    assert.equal(i.stats().loadsInFlight, 0);
});

test("torture: locale switch during in-flight load resolves consistently", async () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { hi: "Hi" });
    const load = i.loadLocale("bg", async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { hi: "Здравей" };
    });
    // Switch locale immediately, before the load finishes.
    i.locale.set("bg");
    // At this point 'bg' isn't loaded yet -> missing key returns key literal.
    assert.equal(i.t("hi"), "hi");
    await load;
    assert.equal(i.t("hi"), "Здравей");
});

test("torture: loader that itself calls loadLocale for a different locale", async () => {
    // Real-world case: language pack A pulls in a shared common pack.
    const i = createI18n({ locale: "en" });
    await i.loadLocale("app", async () => {
        await i.loadLocale("common", async () => ({ hello: "hi-common" }));
        return { hello: "hi-app" };
    });
    // 'app' dict took precedence over 'common' via load order.
    i.locale.set("app");
    assert.equal(i.t("hello"), "hi-app");
});

// ============================================================================
//  API edges -- locale.set with degenerate values
// ============================================================================

test("torture: locale.set(undefined) is tolerated by Intl fallback + warn", () => {
    // lite-signal doesn't reject non-string signal values. Rendering with a
    // non-string locale falls back through the Intl warn path.
    const orig = console.warn;
    console.warn = () => {};
    try {
        const i = createI18n({ locale: "en" });
        i.defineMessages("en", { m: "en" });
        i.locale.set(undefined);
        // Missing dict for `undefined` locale, no fallback -> key literal.
        assert.equal(i.t("m"), "m");
    } finally {
        console.warn = orig;
    }
});

test("torture: very long slot name (500 chars) works", () => {
    const long = "a".repeat(500);
    const i = createI18n();
    i.defineMessages("en", { m: "before {" + long + "} after" });
    assert.equal(i.t("m", { [long]: "X" }), "before X after");
});

test("torture: stats() on brand-new instance reports zeros", () => {
    const i = createI18n({ locale: "en" });
    const s = i.stats();
    assert.equal(s.locales, 0);
    assert.equal(s.keys, 0);
    assert.equal(s.currentLocale, "en");
    assert.deepEqual(s.fallback, []);
    assert.equal(s.pluralRulesCached, 0);
    assert.equal(s.ordinalRulesCached, 0);
    assert.equal(s.loadsInFlight, 0);
});

// ============================================================================
//  Composition -- select + plural + selectordinal all in one template
// ============================================================================

test("torture: three-argument composition (select > plural > slot)", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{g, select, "
            + "male {He is in {p, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} place with {n, plural, one {# apple} other {# apples}}} "
            + "other {They are in {p, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} place with {n, plural, one {# apple} other {# apples}}}}",
    });
    assert.equal(
        i.t("m", { g: "male", p: 1, n: 1 }),
        "He is in 1st place with 1 apple"
    );
    assert.equal(
        i.t("m", { g: "male", p: 22, n: 5 }),
        "He is in 22nd place with 5 apples"
    );
    assert.equal(
        i.t("m", { g: "x", p: 3, n: 2 }),
        "They are in 3rd place with 2 apples"
    );
});
