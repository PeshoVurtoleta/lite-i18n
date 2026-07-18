import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createI18n } from "../I18n.js";

test("fallback resolves missing keys to configured chain", () => {
    const i = createI18n({ locale: "bg", fallback: "en" });
    i.defineMessages("en", { hi: "Hi", bye: "Bye" });
    i.defineMessages("bg", { hi: "Здравей" });
    assert.equal(i.t("hi"), "Здравей");    // primary
    assert.equal(i.t("bye"), "Bye");        // fallback
});

test("fallback chain walks in order until hit", () => {
    const i = createI18n({ locale: "de", fallback: ["fr", "en"] });
    i.defineMessages("en", { hi: "Hi" });
    i.defineMessages("fr", { hi: "Salut" });
    assert.equal(i.t("hi"), "Salut");       // fr hits first
});

test("current locale skipped in fallback chain if listed", () => {
    // If the active locale appears in the fallback array we don't double-walk it.
    const i = createI18n({ locale: "en", fallback: ["en", "bg"] });
    i.defineMessages("bg", { hi: "Здравей" });
    // Not in en, next is en (skipped), then bg -> hit.
    assert.equal(i.t("hi"), "Здравей");
});

test("setFallback replaces the chain and bumps epoch", () => {
    const i = createI18n({ locale: "de" });
    i.defineMessages("en", { hi: "Hi" });
    i.defineMessages("fr", { hi: "Salut" });
    // No fallback -> missing.
    assert.equal(i.t("hi"), "hi");
    i.setFallback("fr");
    assert.equal(i.t("hi"), "Salut");
    i.setFallback(["en", "fr"]);
    assert.equal(i.t("hi"), "Hi");
});

test("setFallback triggers effect re-run", () => {
    const i = createI18n({ locale: "de" });
    i.defineMessages("en", { hi: "Hi" });
    i.defineMessages("fr", { hi: "Salut" });
    const seen = [];
    effect(() => seen.push(i.t("hi")));
    assert.equal(seen[0], "hi");
    i.setFallback("en");
    assert.equal(seen[seen.length - 1], "Hi");
    i.setFallback("fr");
    assert.equal(seen[seen.length - 1], "Salut");
});

test("defineMessages for a locale in fallback triggers effect", () => {
    const i = createI18n({ locale: "de", fallback: "en" });
    const seen = [];
    effect(() => seen.push(i.t("hi")));
    assert.equal(seen[0], "hi");
    i.defineMessages("en", { hi: "Hi" });
    assert.equal(seen[seen.length - 1], "Hi");
});

test("defineMessages for an unrelated locale does NOT re-fire the current effect", () => {
    // Micro-optimization: epoch only bumps for active or fallback locales.
    const i = createI18n({ locale: "en", fallback: "en" });
    i.defineMessages("en", { hi: "Hi" });
    let runs = 0;
    effect(() => { runs++; i.t("hi"); });
    assert.equal(runs, 1);
    i.defineMessages("fr", { hi: "Salut" });        // irrelevant to en
    assert.equal(runs, 1);                          // no re-fire
    i.defineMessages("en", { hi: "Hi again" });
    assert.equal(runs, 2);
});

test("fallback via setFallback keeps effect subscription live across chain flips", () => {
    const i = createI18n({ locale: "de" });
    i.defineMessages("en", { hi: "Hi" });
    i.defineMessages("fr", { hi: "Salut" });
    const seen = [];
    effect(() => seen.push(i.t("hi")));
    i.setFallback("en"); i.setFallback("fr"); i.setFallback("en");
    assert.deepEqual(seen, ["hi", "Hi", "Salut", "Hi"]);
});
