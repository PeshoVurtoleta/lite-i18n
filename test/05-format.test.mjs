import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createI18n, setDefaultI18n } from "../I18n.js";
import {
    formatNumber, formatDate, formatList, formatRelativeTime,
    numberFormat, dateFormat, listFormat, relativeTimeFormat,
    createFormatters,
} from "../Format.js";

const EUR = Object.freeze({ style: "currency", currency: "EUR" });
const MEDIUM_DATE = Object.freeze({ dateStyle: "medium" });
const LIST_CONJ = Object.freeze({ style: "long", type: "conjunction" });

test("formatNumber uses default instance's locale", () => {
    const inst = createI18n({ locale: "en-US" });
    setDefaultI18n(inst);
    assert.equal(formatNumber(1234.5), "1,234.5");
    inst.locale.set("de-DE");
    assert.equal(formatNumber(1234.5), "1.234,5");
});

test("formatNumber with currency opts", () => {
    const inst = createI18n({ locale: "en-US" });
    setDefaultI18n(inst);
    assert.match(formatNumber(9.99, EUR), /€/);
    inst.locale.set("de-DE");
    assert.match(formatNumber(9.99, EUR), /€/);
});

test("formatDate uses instance locale", () => {
    const inst = createI18n({ locale: "en-US" });
    setDefaultI18n(inst);
    const d = new Date(Date.UTC(2026, 6, 18));
    assert.match(formatDate(d, MEDIUM_DATE), /2026/);
    inst.locale.set("bg-BG");
    // Bulgarian: dd.mm.yyyy г.
    assert.match(formatDate(d, MEDIUM_DATE), /2026/);
});

test("formatList joins with correct connector per locale", () => {
    const inst = createI18n({ locale: "en" });
    setDefaultI18n(inst);
    assert.equal(formatList(["a", "b", "c"], LIST_CONJ), "a, b, and c");
    inst.locale.set("fr");
    assert.match(formatList(["a", "b", "c"], LIST_CONJ), /et c/);
});

test("formatRelativeTime works", () => {
    const inst = createI18n({ locale: "en" });
    setDefaultI18n(inst);
    assert.match(formatRelativeTime(-3, "day"), /3 days ago/);
    assert.match(formatRelativeTime(2, "month"), /in 2 months/);
});

test("formatter re-fires effect on locale switch", () => {
    const inst = createI18n({ locale: "en-US" });
    setDefaultI18n(inst);
    const seen = [];
    effect(() => seen.push(formatNumber(1234.5)));
    inst.locale.set("de-DE");
    inst.locale.set("en-US");
    assert.equal(seen.length, 3);
    assert.equal(seen[0], "1,234.5");
    assert.equal(seen[1], "1.234,5");
    assert.equal(seen[2], "1,234.5");
});

test("factory form: numberFormat returns reactive fn", () => {
    const inst = createI18n({ locale: "en-US" });
    setDefaultI18n(inst);
    const fmt = numberFormat(EUR);
    const seen = [];
    effect(() => seen.push(fmt(9.99)));
    inst.locale.set("de-DE");
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);           // different formatting
});

test("factory form: dateFormat returns reactive fn", () => {
    const inst = createI18n({ locale: "en" });
    setDefaultI18n(inst);
    const fmt = dateFormat(MEDIUM_DATE);
    const d = new Date(Date.UTC(2026, 6, 18));
    const a = fmt(d);
    inst.locale.set("bg-BG");
    const b = fmt(d);
    assert.notEqual(a, b);
});

test("factory form: listFormat + relativeTimeFormat work", () => {
    const inst = createI18n({ locale: "en" });
    setDefaultI18n(inst);
    const list = listFormat(LIST_CONJ);
    const rt = relativeTimeFormat();
    assert.equal(list(["x", "y"]), "x and y");
    assert.match(rt(-1, "hour"), /1 hour ago/);
});

test("formatter accepts explicit i18n arg for multi-instance apps", () => {
    const a = createI18n({ locale: "en-US" });
    const b = createI18n({ locale: "de-DE" });
    // Note: default is unset here for this test; pass instance explicitly.
    setDefaultI18n(a);
    assert.equal(formatNumber(1234.5, undefined, a), "1,234.5");
    assert.equal(formatNumber(1234.5, undefined, b), "1.234,5");
});

test("createFormatters binds all 8 formatters to an instance", () => {
    const inst = createI18n({ locale: "en" });
    const F = createFormatters(inst);
    // All 4 convenience:
    assert.equal(typeof F.formatNumber, "function");
    assert.equal(typeof F.formatDate, "function");
    assert.equal(typeof F.formatList, "function");
    assert.equal(typeof F.formatRelativeTime, "function");
    // All 4 factories:
    assert.equal(typeof F.numberFormat, "function");
    assert.equal(typeof F.dateFormat, "function");
    assert.equal(typeof F.listFormat, "function");
    assert.equal(typeof F.relativeTimeFormat, "function");
    // And they respect the bound instance's locale:
    assert.equal(F.formatNumber(1234.5), "1,234.5");
    inst.locale.set("de-DE");
    assert.equal(F.formatNumber(1234.5), "1.234,5");
});

test("hoisted opts + factory: same Intl instance reused across calls (identity proxy)", () => {
    const inst = createI18n({ locale: "en-US" });
    setDefaultI18n(inst);
    const fmt = numberFormat(EUR);
    // Calling many times with same locale should reuse a single cached Intl instance.
    // We assert by output stability -- if a fresh Intl was built each time we'd still
    // get the same output, so this is a smoke check; the real allocation-check test
    // is in 06-zero-gc.test.mjs.
    const outs = [];
    for (let n = 0; n < 100; n++) outs.push(fmt(n));
    assert.equal(outs.length, 100);
});
