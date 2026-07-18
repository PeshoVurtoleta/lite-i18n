import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createI18n } from "../I18n.js";

test("loadLocale calls loader and registers dict", async () => {
    const i = createI18n({ locale: "bg" });
    await i.loadLocale("bg", async () => ({ hi: "Здравей" }));
    assert.equal(i.t("hi"), "Здравей");
});

test("ready signal is false before load, true after", async () => {
    const i = createI18n({ locale: "en" });
    const r = i.ready("bg");
    assert.equal(r.peek(), false);
    await i.loadLocale("bg", async () => ({ hi: "Здравей" }));
    assert.equal(r.peek(), true);
});

test("ready signal fires reactive effect", async () => {
    const i = createI18n({ locale: "en" });
    const seen = [];
    effect(() => seen.push(i.ready("bg")()));
    assert.deepEqual(seen, [false]);
    await i.loadLocale("bg", async () => ({ hi: "hej" }));
    assert.deepEqual(seen, [false, true]);
});

test("second loadLocale for in-flight locale shares the same promise", async () => {
    const i = createI18n({ locale: "en" });
    let callCount = 0;
    const loader = async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return { hi: "Здравей" };
    };
    const p1 = i.loadLocale("bg", loader);
    const p2 = i.loadLocale("bg", loader);
    assert.equal(p1, p2);                        // exact same promise identity
    await Promise.all([p1, p2]);
    assert.equal(callCount, 1);                  // loader ran once
});

test("loadLocale on already-loaded locale resolves immediately without calling loader", async () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("bg", { hi: "Здравей" });
    let called = false;
    await i.loadLocale("bg", async () => { called = true; return {}; });
    assert.equal(called, false);
});

test("loadLocale error clears inflight so caller can retry", async () => {
    const i = createI18n({ locale: "en" });
    let attempts = 0;
    const flakyLoader = async () => {
        attempts++;
        if (attempts === 1) throw new Error("network down");
        return { hi: "Hi" };
    };
    await assert.rejects(i.loadLocale("en", flakyLoader), /network down/);
    await i.loadLocale("en", flakyLoader);       // retry succeeds
    assert.equal(attempts, 2);
    assert.equal(i.t("hi"), "Hi");
});

test("loadLocale rejects when loader returns non-object", async () => {
    const i = createI18n({ locale: "en" });
    await assert.rejects(
        i.loadLocale("en", async () => "not a dict"),
        TypeError
    );
});

test("t() reactively picks up freshly loaded messages for active locale", async () => {
    const i = createI18n({ locale: "bg" });
    const seen = [];
    effect(() => seen.push(i.t("hi")));
    assert.deepEqual(seen, ["hi"]);
    await i.loadLocale("bg", async () => ({ hi: "Здравей" }));
    assert.deepEqual(seen, ["hi", "Здравей"]);
});

test("ready(locale) returns the same signal for repeated calls", () => {
    const i = createI18n({ locale: "en" });
    const a = i.ready("bg");
    const b = i.ready("bg");
    assert.equal(a, b);                          // identity preserved
});

test("switching to an unloaded locale then loading it: effect sees the transition", async () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { hi: "Hi" });
    const seen = [];
    effect(() => seen.push(i.t("hi")));
    i.locale.set("bg");                          // now missing -> "hi"
    await i.loadLocale("bg", async () => ({ hi: "Здравей" }));
    assert.deepEqual(seen, ["Hi", "hi", "Здравей"]);
});

// ---------- Regressions from external review ----------

test("sync-throw in loader: caller can retry (does not permanently poison the locale)", async () => {
    // Prior bug: the try/catch inside an async IIFE ran BEFORE the
    // _loadPromises.set() call, so the delete on failure hit an empty map and
    // the rejected promise got cached forever. Now defers via Promise.resolve.
    const i = createI18n({ locale: "en" });
    let attempts = 0;
    const syncThrowingLoader = () => {
        attempts++;
        if (attempts === 1) throw new ReferenceError("boom sync");
        return { hi: "Hi" };                     // sync return also works
    };
    await assert.rejects(i.loadLocale("en", syncThrowingLoader), /boom sync/);
    // Retry must actually invoke the loader again.
    await i.loadLocale("en", syncThrowingLoader);
    assert.equal(attempts, 2);
    assert.equal(i.t("hi"), "Hi");
});

test("sync JSON.parse throw in loader body also survives retry", async () => {
    const i = createI18n({ locale: "en" });
    let attempts = 0;
    const parseLoader = () => {
        attempts++;
        return JSON.parse(attempts === 1 ? "{not json" : '{"hi":"Hi"}');
    };
    await assert.rejects(i.loadLocale("en", parseLoader), SyntaxError);
    await i.loadLocale("en", parseLoader);
    assert.equal(attempts, 2);
    assert.equal(i.t("hi"), "Hi");
});

test("loadLocale clears _loadPromises on success (stats().loadsInFlight accurate)", async () => {
    const i = createI18n({ locale: "en" });
    await i.loadLocale("en", async () => ({ hi: "Hi" }));
    await i.loadLocale("bg", async () => ({ hi: "Здравей" }));
    assert.equal(i.stats().loadsInFlight, 0, "settled loads must not linger in-flight");
});
