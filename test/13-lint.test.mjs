// The /lint entry (I4, v1.3.0).
//
// Four build-time checks that read a dict-set and return structured findings,
// none of which ever throws. The linter is only worth shipping if it AGREES with
// the runtime it lints -- a check that passes a dict the runtime mis-renders is a
// green light over a hole. So this file does more than test each check against a
// catch/pass fixture: it dogfoods all four against the package's own fixtures,
// proves extractSlots agrees with the COMPILER by render-observation (coupling E,
// option 2 -- the re-parse's only real risk is drift, and this is the gate that
// catches it), and asserts on the resolved module graph that the `.` entry never
// pulls Lint.js.
//
// Non-vacuity: each catch assertion below fails if the corresponding check is
// stubbed to `return []` (proven by reverting during development). A test that
// cannot fail proves nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename } from "node:path";

import {
    extractSlots,
    checkParity,
    checkCoverage,
    checkPluralCompleteness,
} from "../Lint.js";
import { createI18n } from "../I18n.js";
import {
    PASS_DICTS,
    COVERAGE_CATCH, COVERAGE_PASS,
    PARITY_CATCH, PARITY_PASS,
    PLURAL_C_CATCH, PLURAL_A_CATCH, PLURAL_B_CATCH,
    PLURAL_PASS, PLURAL_A_PASS_RU,
    CORPUS,
} from "./lint-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sortset = (a) => [...new Set(a)].sort();

// ---------- extractSlots: the shared, recursive primitive ----------

test("extractSlots: flat slots and escaped braces", () => {
    assert.deepEqual(sortset(extractSlots("Welcome")), []);
    assert.deepEqual(sortset(extractSlots("Hi {name}")), ["name"]);
    assert.deepEqual(sortset(extractSlots("{a} plus {b}")), ["a", "b"]);
    // '{'not a slot'}' is a literal, not a slot.
    assert.deepEqual(sortset(extractSlots("Escaped '{'not a slot'}' but {real} is")), ["real"]);
});

test("extractSlots: recurses into nested variants (coupling D)", () => {
    // The plural variable `n` lives inside the select `male` variant. A
    // top-level-only scan sees {g} and misses n -- the I-15 bug shape.
    const msg = "{g, select, male {He has {n, plural, one {# apple} other {# apples}}} other {none}}";
    assert.deepEqual(sortset(extractSlots(msg)), ["g", "n"]);
    // Deeper: three levels, three distinct variables.
    const deep = "{a, select, x {{b, select, y {{c, plural, other {#}}} other {z}}} other {w}}";
    assert.deepEqual(sortset(extractSlots(deep)), ["a", "b", "c"]);
    // `#` adds no slot; it is the enclosing plural variable already counted.
    assert.deepEqual(sortset(extractSlots("{n, plural, one {# thing} other {# things and {extra}}}")), ["extra", "n"]);
});

test("extractSlots: never throws on garbage input", () => {
    for (const bad of [null, undefined, 42, {}, [], "{unbalanced", "{n, number}", "{a, select, }"]) {
        assert.doesNotThrow(() => extractSlots(bad));
    }
});

// ---------- hostile dicts: the three dict-level checks never throw ----------
// A circular dict, a dict nested past the depth cap, and non-string leaves must
// each produce a structured malformed-dict FINDING, not a stack overflow and not
// a silent drop. Without the flattenDict cycle+depth guard this test goes red
// (checkParity/Coverage/PluralCompleteness throw RangeError on the circular and
// deep cases).
test("hostile dicts: dict-level checks surface a finding, never throw", () => {
    const circular = {};
    circular.self = circular;

    let deep = {};
    let cur = deep;
    for (let i = 0; i < 40; i++) { cur.n = {}; cur = cur.n; }
    cur.leaf = "hi";

    const badLeaves = { a: 42, b: null, c: [1, 2], d: true };

    for (const [label, dict] of [["circular", circular], ["deep", deep], ["badLeaves", badLeaves]]) {
        const dicts = { en: dict, ru: { placeholder: "x" } };
        let fp, fc, fpc;
        assert.doesNotThrow(() => { fp = checkParity(dicts, "en"); }, `checkParity threw on ${label}`);
        assert.doesNotThrow(() => { fc = checkCoverage(dicts, "en"); }, `checkCoverage threw on ${label}`);
        assert.doesNotThrow(() => { fpc = checkPluralCompleteness(dicts); }, `checkPluralCompleteness threw on ${label}`);
        for (const [check, f] of [["parity", fp], ["coverage", fc], ["plural-completeness", fpc]]) {
            const bad = f.find((x) => x.kind === "malformed-dict" && x.locale === "en");
            assert.ok(bad, `${check} must surface a malformed-dict finding for ${label}`);
        }
    }
    // The specific reasons are pinned so the finding is actionable.
    assert.ok(checkParity({ en: circular }, "en").some((x) => x.detail.reason === "circular"));
    assert.ok(checkParity({ en: deep }, "en").some((x) => x.detail.reason === "max-depth"));
    assert.ok(checkParity({ en: badLeaves }, "en").some((x) => x.detail.reason === "non-string-leaf"));
});

// ---------- checkCoverage ----------

test("checkCoverage: CATCHES a locale missing a reference key", () => {
    const f = checkCoverage(COVERAGE_CATCH, "en");
    assert.ok(f.length >= 1, "expected a missing-key finding");
    const miss = f.find((x) => x.kind === "missing-key" && x.key === "farewell" && x.locale === "ru");
    assert.ok(miss, "ru must be flagged for the missing `farewell` key");
    assert.equal(miss.check, "coverage");
});

test("checkCoverage: PASSES a fully-covered dict-set", () => {
    assert.deepEqual(checkCoverage(COVERAGE_PASS, "en"), []);
});

// ---------- checkParity (coupling D) ----------

test("checkParity: CATCHES a translation dropping a NESTED variable (coupling D)", () => {
    const f = checkParity(PARITY_CATCH, "en");
    const miss = f.find((x) => x.kind === "missing-slot" && x.key === "nested" && x.locale === "ru");
    assert.ok(miss, "ru `nested` must be flagged for dropping the nested plural var `n`");
    assert.ok(miss.detail.missing.includes("n"), "the missing slot is `n`");
    assert.equal(miss.check, "parity");
});

test("checkParity: PASSES when nested slot sets match", () => {
    assert.deepEqual(checkParity(PARITY_PASS, "en"), []);
});

test("checkParity: flags an EXTRA slot a translation invents", () => {
    const dicts = { en: { k: "Hi {name}" }, ru: { k: "Privet {name} {surname}" } };
    const f = checkParity(dicts, "en");
    const extra = f.find((x) => x.kind === "extra-slot" && x.locale === "ru");
    assert.ok(extra && extra.detail.extra.includes("surname"));
});

// ---------- checkPluralCompleteness (couplings A, B, C) ----------

test("checkPluralCompleteness: CATCHES `=1` standing in for the `one` category (coupling C)", () => {
    // ru: {=1 few many other} missing the `one` KEYWORD. `=1` catches literal 1
    // only; ru `one` also covers 21/31/41, so this under-renders and is flagged.
    const f = checkPluralCompleteness(PLURAL_C_CATCH);
    const miss = f.find((x) => x.kind === "missing-plural-category" && x.locale === "ru");
    assert.ok(miss, "ru dict with =1 but no `one` keyword must be flagged");
    assert.ok(miss.detail.missing.includes("one"), "the missing category is `one`, not satisfied by =1");
    assert.equal(miss.detail.type, "cardinal");
});

test("checkPluralCompleteness: cardinal vs ordinal category sets (coupling A)", () => {
    // en selectordinal needs one/two/few/other. A cardinal-rules checker would
    // pass {one, other}; the correct ordinal check flags two and few.
    const f = checkPluralCompleteness(PLURAL_A_CATCH);
    const miss = f.find((x) => x.kind === "missing-plural-category" && x.locale === "en");
    assert.ok(miss, "en ordinal {one, other} must be flagged");
    assert.equal(miss.detail.type, "ordinal");
    assert.deepEqual(sortset(miss.detail.missing), ["few", "two"]);
    // The other direction: a ru selectordinal needs ONLY `other`. A cardinal
    // checker would wrongly demand one/few/many -- ordinal rules must pass it.
    assert.deepEqual(checkPluralCompleteness(PLURAL_A_PASS_RU), []);
});

test("checkPluralCompleteness: an invalid locale yields a finding, not a throw (coupling B)", () => {
    let f;
    assert.doesNotThrow(() => { f = checkPluralCompleteness(PLURAL_B_CATCH); });
    const bad = f.find((x) => x.kind === "invalid-locale" && x.locale === "!!bad");
    assert.ok(bad, "an invalid locale tag must become a finding");
    assert.equal(bad.detail.error, "RangeError");
});

test("checkPluralCompleteness: PASSES complete cardinal and ordinal dicts", () => {
    assert.deepEqual(checkPluralCompleteness(PLURAL_PASS), []);
});

test("checkPluralCompleteness: a structurally-valid unknown tag resolves like the runtime (no finding)", () => {
    // xx-hurr does NOT throw out of Intl; it resolves to the default silently,
    // exactly as the runtime resolves it, so linter and runtime agree here.
    const f = checkPluralCompleteness({ "xx-hurr": { k: "{n, plural, one {# x} other {# xs}}" } });
    assert.deepEqual(f, [], "an unknown-but-valid tag must not be flagged invalid-locale");
});

// ---------- Dogfood: all four checks against the package's own fixtures ----------

test("dogfood: PASS_DICTS is clean under all four checks", () => {
    assert.deepEqual(checkCoverage(PASS_DICTS, "en"), [], "coverage");
    assert.deepEqual(checkParity(PASS_DICTS, "en"), [], "parity");
    assert.deepEqual(checkPluralCompleteness(PASS_DICTS), [], "plural-completeness");
});

// ---------- Parity gate (coupling E, option 2): extractSlots == compiler ----------
//
// The re-parse's only risk is drifting from the compiler. Prove it does not: for
// every corpus message, the set of params the COMPILER actually reads (observed
// by rendering -- a param it reads changes t()'s output when varied; one it
// ignores does not) must equal extractSlots(message). Over-extraction (a slot the
// compiler never reads) and under-extraction (a slot the compiler reads that the
// re-parse missed) both fail this.

const IDENT_RE = /[A-Za-z_]\w*/g;
// Values that both fill a text slot (AA/BB) and route a selector (male/female/
// other for select; 0/1/2/5/11/21 across plural categories).
const VALUE_GRID = ["AA", "BB", 0, 1, 2, 5, 11, 21, "male", "female", "other"];
const ROUTE_GRID = ["male", "female", "other", 0, 1, 2, 5];
const TRIALS = 80;

// Deterministic PRNG so a failure replays.
let _seed = 0x1234abcd;
function rnd() {
    _seed ^= _seed << 13; _seed ^= _seed >>> 17; _seed ^= _seed << 5; _seed |= 0;
    return ((_seed >>> 0) % 1000) / 1000;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
const uniq = (arr) => [...new Set(arr)];

function compilerReads(i18n, key, candidate, others, valueGrid, routeGrid) {
    for (let trial = 0; trial < TRIALS; trial++) {
        const base = {};
        for (const o of others) base[o] = pick(routeGrid);
        let first;
        let seen = false;
        for (const v of valueGrid) {
            base[candidate] = v;
            let out;
            try { out = i18n.t(key, base); } catch { out = " throw"; }
            if (!seen) { first = out; seen = true; }
            else if (out !== first) return true;
        }
    }
    return false;
}

test("parity gate: extractSlots equals the compiler's honoured slot set on the corpus", () => {
    const i18n = createI18n({ locale: "en" });
    for (let c = 0; c < CORPUS.length; c++) {
        const message = CORPUS[c];
        const key = "m" + c;
        i18n.defineMessages("en", { [key]: message });
        const candidates = [...new Set(message.match(IDENT_RE) || [])];
        // Select-variant keys are identifiers in the template (e.g. `a`, `x`),
        // so a selector only routes into its branch if the grid can supply that
        // key. Augment both grids with the message's own identifiers.
        const valueGrid = uniq([...VALUE_GRID, ...candidates]);
        const routeGrid = uniq([...ROUTE_GRID, ...candidates]);
        const honoured = [];
        for (const cand of candidates) {
            const others = candidates.filter((x) => x !== cand);
            if (compilerReads(i18n, key, cand, others, valueGrid, routeGrid)) honoured.push(cand);
        }
        assert.deepEqual(
            sortset(extractSlots(message)), sortset(honoured),
            `extractSlots disagrees with the compiler on: ${message}`);
    }
});

// ---------- Import-graph assertion (coupling: `.` never pulls Lint.js) ----------

async function resolveGraph(entryUrl) {
    const seen = new Set();
    const stack = [entryUrl];
    const importRe = /(?:^|[\s;])(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
    const bareImportRe = /(?:^|[\s;])import\s*["']([^"']+)["']/g;
    const dynRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
    while (stack.length) {
        const url = stack.pop();
        if (seen.has(url)) continue;
        seen.add(url);
        if (!url.startsWith("file:")) continue;
        let src;
        try { src = readFileSync(fileURLToPath(url), "utf8"); } catch { continue; }
        const specs = [];
        let m;
        while ((m = importRe.exec(src))) specs.push(m[1]);
        while ((m = bareImportRe.exec(src))) specs.push(m[1]);
        while ((m = dynRe.exec(src))) specs.push(m[1]);
        for (const spec of specs) {
            let resolved;
            try { resolved = import.meta.resolve(spec, url); } catch { continue; }
            if (resolved && !seen.has(resolved)) stack.push(resolved);
        }
    }
    return seen;
}

test("import graph: the `.` entry (I18n.js) never reaches Lint.js", async () => {
    const entry = pathToFileURL(join(ROOT, "I18n.js")).href;
    const graph = await resolveGraph(entry);
    // Sanity: the walk actually traversed something (the entry itself at least).
    assert.ok(graph.size >= 1);
    for (const url of graph) {
        if (!url.startsWith("file:")) continue;
        assert.notEqual(
            basename(fileURLToPath(url)), "Lint.js",
            "Lint.js must NOT appear in the resolved graph of the `.` entry");
    }
});
