// Locale bounds + eviction (I2, v1.2.0).
//
// Every per-locale structure was unbounded and nothing released one; the three
// fail in OPPOSITE directions and so take DIFFERENT policies
// (decisions/0003-locale-bounds.md). Each test below FAILS against the pre-fix
// 1.1.4 code (git show 5d271ef:I18n.js) -- the failure output is recorded in the
// CHANGELOG 1.2.0 body and the decision record. A regression test that never
// failed is decoration.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { effect, destroy } from "@zakkster/lite-signal";
import {
    createI18n,
    resolveLocale,
    LocaleCapacityError,
    LOCALE_CACHE_MAX,
} from "../I18n.js";

// lite-signal nodes live in a process-wide pool and are reclaimed by explicit
// dispose, NOT by GC (decisions/0003-locale-bounds.md). Several tests below each
// mint up to LOCALE_CACHE_MAX (256) readiness signals; left un-reclaimed they
// would accumulate across tests and exhaust the 1024-node pool -- which is the
// very multi-instance limitation the decision record documents. Resetting the
// default registry after each test keeps the file's own pool pressure bounded.
// (This mirrors production reality: one instance's readiness signals cap at 256
// because ready() fails CLOSED rather than churning, so per-instance consumption
// does not scale with the number of locale strings observed.)
afterEach(() => destroy());

// ---------------------------------------------------------------------------
// ready() identity contract (the brief's most important assertion).
//
// The REJECTED design was a shared, permanently-false singleton. It is rejected
// because it breaks all four of these properties at once: a shared signal has
// no per-locale identity, cannot flip true (or it flips for every locale), and
// re-fires every observer on any locale's transition. Distinct, stable,
// per-locale identity is load-bearing. (This test PASSES pre-fix too -- its job
// is to fence the rejected design out, not to prove a bug fixed.)
// ---------------------------------------------------------------------------

test("ready(): distinct signal identity per locale", () => {
    const i = createI18n({ locale: "en" });
    assert.notStrictEqual(i.ready("bg"), i.ready("de"), "bg and de must be distinct signals");
});

test("ready(): stable signal identity across calls", () => {
    const i = createI18n({ locale: "en" });
    assert.strictEqual(i.ready("bg"), i.ready("bg"), "ready('bg') must return the same signal each call");
});

test("ready(): flips false -> true on load, and only for the loaded locale", async () => {
    const i = createI18n({ locale: "en" });
    const bg = i.ready("bg");
    const de = i.ready("de");
    assert.equal(bg.peek(), false, "bg starts false (not yet loaded)");
    assert.equal(de.peek(), false, "de starts false");
    await i.loadLocale("bg", () => Promise.resolve({ hi: "zdravei" }));
    assert.equal(bg.peek(), true, "bg flips true after load");
    assert.equal(de.peek(), false, "de must NOT flip -- a shared singleton would");
});

test("ready(): loading locale A does NOT re-fire an observer gated on locale B", async () => {
    const i = createI18n({ locale: "en" });
    let aRuns = 0;
    let bRuns = 0;
    effect(() => { aRuns++; i.ready("a")(); });
    effect(() => { bRuns++; i.ready("b")(); });
    assert.equal(aRuns, 1, "a effect ran once at setup");
    assert.equal(bRuns, 1, "b effect ran once at setup");
    await i.loadLocale("a", () => Promise.resolve({ k: "A" }));
    assert.equal(aRuns, 2, "a effect re-ran when a loaded");
    assert.equal(bRuns, 1, "b effect must NOT re-run -- distinct identity, not a shared singleton");
});

// ---------------------------------------------------------------------------
// _readySignals ceiling: fail closed with a NAMED library error.
// ---------------------------------------------------------------------------

test("ready(): fails closed at LOCALE_CACHE_MAX with a named LocaleCapacityError", () => {
    const i = createI18n({ locale: "en" });
    for (let n = 0; n < LOCALE_CACHE_MAX; n++) i.ready("loc-" + n);
    assert.equal(i.stats().readySignalsCached, LOCALE_CACHE_MAX, "cache filled to the ceiling");
    let err;
    try { i.ready("one-too-many"); } catch (e) { err = e; }
    assert.ok(err instanceof LocaleCapacityError, "must throw LocaleCapacityError, not a dependency's CapacityError");
    assert.equal(err.name, "LocaleCapacityError");
    assert.equal(err.locale, "one-too-many", "error names the offending locale");
    assert.equal(err.ceiling, LOCALE_CACHE_MAX, "error names the ceiling");
});

test("ready(): an already-cached locale still returns past the ceiling (no throw)", () => {
    const i = createI18n({ locale: "en" });
    for (let n = 0; n < LOCALE_CACHE_MAX; n++) i.ready("loc-" + n);
    // Re-requesting an existing entry must not throw -- the miss branch is the
    // only place the ceiling is checked.
    assert.doesNotThrow(() => i.ready("loc-0"));
    assert.strictEqual(i.ready("loc-0"), i.ready("loc-0"), "identity still stable at the ceiling");
});

test("ready(): the ceiling has a per-INSTANCE blast radius -- createI18n() still works after", () => {
    const i = createI18n({ locale: "en" });
    // At 1.1.4 this loop exhausts lite-signal's process-wide 1024-node pool near
    // n=1020 and the NEXT createI18n() throws CapacityError. Post-fix it throws a
    // per-instance LocaleCapacityError and the pool is untouched.
    let threw = 0;
    for (let n = 0; n < 4000; n++) {
        try { i.ready("x-" + n); } catch (e) {
            if (e instanceof LocaleCapacityError) threw++;
            else throw e;
        }
    }
    assert.ok(threw > 0, "the ceiling tripped");
    assert.equal(i.stats().readySignalsCached, LOCALE_CACHE_MAX, "readiness cache stayed bounded");
    // The process is still usable: a fresh instance constructs and renders.
    const j = createI18n({ locale: "en" });
    j.defineMessages("en", { hi: "hello" });
    assert.equal(j.t("hi"), "hello", "a fresh instance works -- the pool was not poisoned");
});

// ---------------------------------------------------------------------------
// I-04: the Intl-rules caches leak ONLY with a fallback chain. BOTH rows.
// ---------------------------------------------------------------------------

test("I-04 row 1 (NO fallback): distinct locales cache 0 rules -- the key misses first", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { p: "{n, plural, one {# item} other {# items}}" });
    for (let n = 0; n < 1000; n++) { i.locale.set("xx-" + n); i.t("p", { n: 2 }); }
    // No fallback: lookup misses, returns the literal key, getRules never runs.
    assert.equal(i.stats().pluralRulesCached, 0, "no fallback -> no rules built");
    assert.equal(i.t("p", { n: 2 }), "p", "renders the literal key (no resolution)");
});

test("I-04 row 2 (fallback:'en'): distinct locales are BOUNDED at LOCALE_CACHE_MAX", () => {
    const i = createI18n({ locale: "en", fallback: "en" });
    i.defineMessages("en", { p: "{n, plural, one {# item} other {# items}}" });
    for (let n = 0; n < 1000; n++) { i.locale.set("xx-" + n); i.t("p", { n: 2 }); }
    // With a fallback the message resolves but the rules are built against the
    // REQUESTED locale -- at 1.1.4 that cached 1000 forever. Now FIFO-bounded.
    assert.ok(i.stats().pluralRulesCached <= LOCALE_CACHE_MAX,
        "pluralRulesCached " + i.stats().pluralRulesCached + " > " + LOCALE_CACHE_MAX);
    assert.equal(i.t("p", { n: 2 }), "2 items", "still resolves correctly through the fallback");
});

test("I-04: selectordinal doubles the surface -- both cardinal and ordinal caches bound", () => {
    const i = createI18n({ locale: "en", fallback: "en" });
    i.defineMessages("en", {
        c: "{n, plural, one {# item} other {# items}}",
        o: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
    });
    for (let n = 0; n < 800; n++) { i.locale.set("yy-" + n); i.t("c", { n: 2 }); i.t("o", { n: 3 }); }
    const s = i.stats();
    assert.ok(s.pluralRulesCached <= LOCALE_CACHE_MAX, "cardinal bounded");
    assert.ok(s.ordinalRulesCached <= LOCALE_CACHE_MAX, "ordinal bounded");
});

// ---------------------------------------------------------------------------
// Eviction-equivalence: the assertion that LICENSES the policy split. An evicted
// _pluralRules entry, rebuilt on the next render, is byte-identical -- so which
// entry FIFO drops is observationally irrelevant, which is why eviction (not a
// throw) is sound for a pure memo.
// ---------------------------------------------------------------------------

test("eviction-equivalence: a re-rendered evicted rules entry is byte-identical", () => {
    const i = createI18n({ locale: "pl", fallback: "en" });
    // Polish has a rich plural table (one/few/many/other) -- a good witness that
    // the RECONSTRUCTED rules select the same category as the original.
    i.defineMessages("en", { p: "{n, plural, one {# rzecz} few {# rzeczy} many {# rzeczy} other {# rzeczy}}" });

    // Baseline: render at "pl" for several counts, capture output.
    const counts = [1, 2, 3, 5, 22, 100];
    const before = counts.map((n) => { i.locale.set("pl"); return i.t("p", { n }); });
    assert.equal(i.stats().pluralRulesCached >= 1, true, "pl rules cached");

    // Force eviction of the "pl" entry: fill the cache past the ceiling with
    // other distinct locales so FIFO drops "pl" (inserted first).
    for (let n = 0; n < LOCALE_CACHE_MAX + 5; n++) { i.locale.set("zz-" + n); i.t("p", { n: 2 }); }

    // Re-render at "pl": the entry was evicted and is reconstructed on this miss.
    const after = counts.map((n) => { i.locale.set("pl"); return i.t("p", { n }); });
    assert.deepEqual(after, before, "reconstructed rules must render byte-identically");
});

// ---------------------------------------------------------------------------
// I-19: the warn budget.
// ---------------------------------------------------------------------------

test("I-19: invalid-locale warnings are capped per instance; the rest are counted", () => {
    const i = createI18n({ locale: "en", fallback: "en" });
    i.defineMessages("en", { p: "{n, plural, one {# item} other {# items}}" });
    let warns = 0;
    const orig = console.warn;
    console.warn = () => { warns++; };
    try {
        for (let n = 0; n < 300; n++) { i.locale.set("!!bad" + n); i.t("p", { n: 2 }); }
    } finally {
        console.warn = orig;
    }
    // At 1.1.4 this is 300 warns and warningsSuppressed is undefined.
    assert.ok(warns <= 32, "warnings capped at the budget, got " + warns);
    assert.ok(i.stats().warningsSuppressed >= 300 - 32, "the suppressed warnings are counted");
    assert.equal(warns + i.stats().warningsSuppressed, 300, "every invalid tag is accounted for");
});

// ---------------------------------------------------------------------------
// I-12: unloadLocale.
// ---------------------------------------------------------------------------

test("unloadLocale: drops the dict, both rules memos, and the ready signal", () => {
    const i = createI18n({ locale: "de", fallback: "en" });
    i.defineMessages("en", { greet: "hi" });
    i.defineMessages("de", {
        greet: "hallo",
        p: "{n, plural, one {# Ding} other {# Dinge}}",
        o: "{n, selectordinal, other {#.}}",
    });
    i.ready("de");
    i.t("p", { n: 1 });
    i.t("o", { n: 1 });
    let s = i.stats();
    assert.equal(s.locales, 2);
    assert.ok(s.pluralRulesCached >= 1 && s.ordinalRulesCached >= 1, "de rules built");
    assert.equal(s.readySignalsCached, 1);

    const removed = i.unloadLocale("de");
    assert.equal(removed, true, "unloadLocale returns true when a dict was removed");
    s = i.stats();
    assert.equal(s.locales, 1, "de dict dropped");
    assert.equal(s.pluralRulesCached, 0, "de plural rules dropped");
    assert.equal(s.ordinalRulesCached, 0, "de ordinal rules dropped");
    assert.equal(s.readySignalsCached, 0, "de ready signal dropped");
    assert.equal(s.retiredLocales, 1, "retiredLocales incremented");
});

test("unloadLocale: subscribers observe the ready signal's true->false transition", async () => {
    const i = createI18n({ locale: "en" });
    await i.loadLocale("bg", () => Promise.resolve({ hi: "zdravei" }));
    const seen = [];
    effect(() => { seen.push(i.ready("bg")()); });
    assert.deepEqual(seen, [true], "observer sees true after load");
    i.unloadLocale("bg");
    assert.deepEqual(seen, [true, false], "observer must see the false transition on unload");
});

test("unloadLocale: unloading the ACTIVE locale falls through to the fallback and re-renders", () => {
    const i = createI18n({ locale: "de", fallback: "en" });
    i.defineMessages("en", { greet: "hello" });
    i.defineMessages("de", { greet: "hallo" });
    const seen = [];
    effect(() => { seen.push(i.t("greet")); });
    assert.deepEqual(seen, ["hallo"], "active de renders");
    const removed = i.unloadLocale("de"); // the ACTIVE locale
    assert.equal(removed, true);
    // Epoch bumped: the effect re-ran and resolution fell through to en.
    assert.deepEqual(seen, ["hallo", "hello"], "unloading active locale re-renders via fallback");
    assert.equal(i.t("greet"), "hello");
});

test("unloadLocale: a never-defined locale returns false and does not touch counters", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { k: "v" });
    assert.equal(i.unloadLocale("nope"), false, "nothing to remove -> false");
    assert.equal(i.stats().retiredLocales, 0, "no phantom retirement");
    assert.equal(i.stats().locales, 1);
});

// ---------------------------------------------------------------------------
// I-12: clear().
// ---------------------------------------------------------------------------

test("clear(): then define then read matches a fresh instance exactly", () => {
    const churned = createI18n({ locale: "en", fallback: "en" });
    churned.defineMessages("en", { p: "{n, plural, one {# item} other {# items}}" });
    // Churn rules (bounded, no throw) heavily plus a handful of ready signals,
    // then reset. ready() is only exercised a few times -- it fails closed at
    // the ceiling, so a 500-deep ready() churn would (correctly) throw.
    for (let n = 0; n < 500; n++) { churned.locale.set("junk-" + n); churned.t("p", { n: 2 }); }
    for (let n = 0; n < 10; n++) churned.ready("r-" + n);
    churned.locale.set("en");
    churned.clear();
    churned.defineMessages("en", { greet: "hi {name}" });

    const fresh = createI18n({ locale: "en", fallback: "en" });
    fresh.defineMessages("en", { greet: "hi {name}" });

    assert.equal(churned.t("greet", { name: "x" }), fresh.t("greet", { name: "x" }), "render matches fresh");
    assert.deepEqual(churned.stats(), fresh.stats(), "stats() matches a fresh instance exactly");
});

test("clear(): flips live ready signals false and re-renders observers", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { k: "v" });
    const readySeen = [];
    effect(() => { readySeen.push(i.ready("en")()); });
    const tSeen = [];
    effect(() => { tSeen.push(i.t("k")); });
    assert.deepEqual(readySeen, [true]);
    assert.deepEqual(tSeen, ["v"]);
    i.clear();
    assert.deepEqual(readySeen, [true, false], "ready('en') flipped false on clear");
    assert.deepEqual(tSeen, ["v", "k"], "t('k') re-resolved to the literal after clear");
});

// ---------------------------------------------------------------------------
// resolveLocale: BCP 47 prefix matching. Named test each (brief ASSERTIONS).
// ---------------------------------------------------------------------------

test("resolveLocale: exact match", () => {
    assert.equal(resolveLocale("en", ["en", "fr", "de"]), "en");
});

test("resolveLocale: prefix match (request more specific than supported)", () => {
    assert.equal(resolveLocale("en-US", ["en", "fr"]), "en");
    assert.equal(resolveLocale("de-CH-1996", ["fr", "de"]), "de");
});

test("resolveLocale: reverse prefix (bare request matches a specific supported tag)", () => {
    assert.equal(resolveLocale("en", ["en-US", "fr-FR"]), "en-US");
});

test("resolveLocale: case-insensitive", () => {
    assert.equal(resolveLocale("EN-us", ["en"]), "en");
    assert.equal(resolveLocale("en", ["EN-US"]), "EN-US", "returns the supported entry's original casing");
});

test("resolveLocale: no match -> undefined", () => {
    assert.equal(resolveLocale("ja", ["en", "fr", "de"]), undefined);
});

test("resolveLocale: empty supported list -> undefined", () => {
    assert.equal(resolveLocale("en", []), undefined);
});

test("resolveLocale: malformed / empty request -> undefined", () => {
    assert.equal(resolveLocale("", ["en"]), undefined);
    assert.equal(resolveLocale("-", ["en"]), undefined);
    assert.equal(resolveLocale(null, ["en"]), undefined);
    assert.equal(resolveLocale("en", null), undefined);
});

test("resolveLocale: exact wins over prefix", () => {
    assert.equal(resolveLocale("en-US", ["en", "en-US", "en-GB"]), "en-US", "exact match takes precedence");
});
