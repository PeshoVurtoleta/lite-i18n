import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../I18n.js";
import { numberFormat } from "../Format.js";

// These tests require --expose-gc. They check that steady-state hot paths do
// not retain heap monotonically. Absolute byte thresholds are conservative
// bounds -- V8's TurboFan compilation and inline caches can inflate short-
// term heap on the first few thousand iterations, so we warm up before
// measuring.

const hasGC = typeof globalThis.gc === "function";

async function idleGC(rounds = 3) {
    for (let i = 0; i < rounds; i++) {
        globalThis.gc();
        await new Promise((r) => setImmediate(r));
    }
}

test("t() with simple interpolation: 100k calls retain <200 KB", { skip: !hasGC }, async () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: "Hello, {name}! Count: {count}" });
    const params = { name: "Zahary", count: 42 };
    // Warm up JIT
    for (let k = 0; k < 10000; k++) i.t("m", params);
    await idleGC();
    const before = process.memoryUsage().heapUsed;
    for (let k = 0; k < 100000; k++) i.t("m", params);
    await idleGC();
    const delta = process.memoryUsage().heapUsed - before;
    assert.ok(delta < 200_000, `retained ${delta} bytes (>200 KB) after 100k t() calls`);
});

test("plural inline: 100k calls retain <300 KB", { skip: !hasGC }, async () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        m: "{count, plural, one {# item} other {# items}}",
    });
    const params = { count: 5 };
    for (let k = 0; k < 10000; k++) i.t("m", params);
    await idleGC();
    const before = process.memoryUsage().heapUsed;
    for (let k = 0; k < 100000; k++) i.t("m", params);
    await idleGC();
    const delta = process.memoryUsage().heapUsed - before;
    assert.ok(delta < 300_000, `retained ${delta} bytes (>300 KB) after 100k plural calls`);
});

test("numberFormat factory: 100k calls retain <100 KB (steady-state zero-alloc)", { skip: !hasGC }, async () => {
    const i = createI18n({ locale: "en-US" });
    // Bind factory to this instance
    const fmt = numberFormat({ style: "currency", currency: "EUR" }, i);
    for (let k = 0; k < 10000; k++) fmt(k);
    await idleGC();
    const before = process.memoryUsage().heapUsed;
    for (let k = 0; k < 100000; k++) fmt(k);
    await idleGC();
    const delta = process.memoryUsage().heapUsed - before;
    assert.ok(delta < 100_000, `retained ${delta} bytes (>100 KB) after 100k factory-fmt calls`);
});

test("defineMessages then read: 1000 rounds retain <500 KB", { skip: !hasGC }, async () => {
    // Cumulative define + read; unique keys per round grow the dict monotonically
    // (that's real memory, not GC pressure). Instead we redefine the SAME keys
    // each round and check that compiled entries recycle cleanly.
    const i = createI18n({ locale: "en" });
    const dict = { a: "A {x}", b: "B {y}", c: { one: "# c", other: "# cs" } };
    for (let k = 0; k < 100; k++) {
        i.defineMessages("en", dict);
        i.t("a", { x: "x" });
        i.plural("c", 3);
    }
    await idleGC();
    const before = process.memoryUsage().heapUsed;
    for (let k = 0; k < 1000; k++) {
        i.defineMessages("en", dict);
        i.t("a", { x: "x" });
        i.plural("c", 3);
    }
    await idleGC();
    const delta = process.memoryUsage().heapUsed - before;
    assert.ok(delta < 500_000, `retained ${delta} bytes (>500 KB) after 1000 redefine cycles`);
});
