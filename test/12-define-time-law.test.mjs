// Define-time + dispatch-time law (I3, v1.2.1).
//
// The four questions that had no written answer, so the same logical value could
// render two different sentences and nothing said which was right:
//
//   I-08  the plural selector is normalized ONCE (coerceCount) so a count
//         renders the same sentence regardless of its JS type; null/''/undefined
//         stay in the `other` path (null is not zero), a bigint coerces instead
//         of throwing out of Intl.       decisions/0004-count-coercion.md
//   I-07  argument-block nesting is capped at MAX_TEMPLATE_DEPTH (32) at compile
//         time; a deeper message throws a NAMED MessageDepthError carrying the
//         key and depth, and the dict stays byte-identical after the throw.
//                                         decisions/0005-depth-cap.md
//   I-06  nested plural/select/selectordinal renders (the README once denied it).
//   I-05  an explicit defineMessages for a locale with a load in flight WINS; the
//         load result is discarded with a named warn (the losing writer is
//         observable) and the promise RESOLVES.  decisions/0006-load-define-race.md
//
// Each test FAILS against the pre-fix 1.2.0 code -- non-vacuity is proven by
// reverting the corresponding guard in I18n.js and watching it go red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n, MessageDepthError } from "../I18n.js";

// ---------- I-08: type-independent count dispatch ----------

test("I-08: count '1' renders identically to 1 across =1, category, and =0 templates", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        ex: "{n, plural, =1 {EXACT} one {ONE} other {MANY}}",
        z: "{n, plural, =0 {ZERO} one {ONE} other {MANY}}",
        files: "{n, plural, one {# file} other {# files}}",
    });
    // The exact bucket is number-keyed: pre-fix '1' missed =1 and dropped to the
    // `one` category, a DIFFERENT sentence than 1.
    assert.equal(i.t("ex", { n: 1 }), "EXACT");
    assert.equal(i.t("ex", { n: "1" }), "EXACT", "'1' must hit =1 exactly, like 1");
    assert.equal(i.t("z", { n: 0 }), "ZERO");
    assert.equal(i.t("z", { n: "0" }), "ZERO", "'0' must hit =0 exactly, like 0");
    // Full parity sweep.
    for (const c of [0, 1, 2, 3, 11, 100]) {
        for (const key of ["ex", "z", "files"]) {
            assert.equal(i.t(key, { n: String(c) }), i.t(key, { n: c }),
                `count/string parity broke at ${key} count=${c}`);
        }
    }
});

test("I-08: null, '' and undefined stay in `other` -- null is not zero", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { z: "{n, plural, =0 {ZERO} one {ONE} other {MANY}}" });
    // A bare Number() would map null->0 and ''->0 and render the ZERO sentence
    // for a nullish count. Suite law forbids it: these resolve to `other`.
    assert.equal(i.t("z", { n: null }), "MANY", "null must NOT render =0");
    assert.equal(i.t("z", { n: "" }), "MANY", "'' must NOT render =0");
    assert.equal(i.t("z", { n: undefined }), "MANY", "undefined must NOT render =0");
    assert.equal(i.t("z", { n: NaN }), "MANY");
    assert.equal(i.t("z", {}), "MANY", "a missing count must NOT render =0");
    // A blank (all-whitespace) string is blank input too: +'  ' is 0, so a bare
    // Number() would drop it into the author's =0 bucket. Blank is not zero -- it
    // must render exactly like '' and null, NOT the =0 literal (in English).
    assert.equal(i.t("z", { n: "  " }), i.t("z", { n: "" }), "'  ' must render like ''");
    assert.equal(i.t("z", { n: "  " }), "MANY", "whitespace-only must NOT render =0");
    assert.equal(i.t("z", { n: "\t\n" }), "MANY", "tabs/newlines are blank too");
    // But incidental whitespace around a real number still parses.
    assert.equal(i.t("z", { n: " 5 " }), i.t("z", { n: 5 }), "' 5 ' parses to 5");
});

test("I-08: a BigInt count coerces and renders -- never throws out of Intl", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        ex: "{n, plural, =1 {EXACT} one {ONE} other {MANY}}",
        files: "{n, plural, one {# file} other {# files}}",
    });
    assert.doesNotThrow(() => i.t("files", { n: 2n }));
    assert.equal(i.t("files", { n: 1n }), "1 file", "1n renders like 1");
    assert.equal(i.t("files", { n: 2n }), "2 files");
    assert.equal(i.t("ex", { n: 1n }), "EXACT", "1n hits =1 like 1");
    // Huge bigints coerce to a finite number that selects `other`, still no throw.
    assert.equal(i.t("files", { n: 123456789012345678901234567890n }),
        "123456789012345678901234567890 files");
});

test("I-08: plural-object dict entries coerce the count the same way", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { m: { "=0": "ZERO", one: "ONE", other: "MANY" } });
    assert.equal(i.plural("m", 0), "ZERO");
    assert.equal(i.t("m", { count: "0" }), "ZERO", "'0' matches =0 in a plural-object");
    assert.equal(i.t("m", { count: null }), "MANY", "null stays other in a plural-object");
    assert.equal(i.t("m", { count: 2n }), "MANY");
    assert.doesNotThrow(() => i.t("m", { count: 5n }));
});

// ---------- I-07: compile-time depth cap ----------

function bombOfDepth(n) {
    let s = "leaf";
    for (let d = 0; d < n; d++) s = "{n, plural, other {" + s + "}}";
    return s;
}

test("I-07: a message nested past 32 throws a named MessageDepthError with key + depth", () => {
    const i = createI18n({ locale: "en" });
    let err = null;
    try { i.defineMessages("en", { deep: bombOfDepth(4000) }); } catch (e) { err = e; }
    assert.ok(err instanceof MessageDepthError, "must be a MessageDepthError, not a bare RangeError");
    assert.ok(err instanceof SyntaxError, "MessageDepthError extends SyntaxError");
    assert.equal(err.name, "MessageDepthError");
    assert.equal(err.key, "deep", "the error names the offending key");
    assert.ok(typeof err.depth === "number" && err.depth > 32, "the error carries the depth");
    assert.match(err.message, /"deep"/, "the message names the key");
    assert.match(err.message, /32/, "the message names the limit");
});

test("I-07: depth 32 is accepted, depth 33 is the first rejected", () => {
    const ok = createI18n({ locale: "en" });
    assert.doesNotThrow(() => ok.defineMessages("en", { d32: bombOfDepth(32) }));
    const bad = createI18n({ locale: "en" });
    assert.throws(() => bad.defineMessages("en", { d33: bombOfDepth(33) }), MessageDepthError);
});

test("I-07: the dict is byte-identical after a depth throw", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", { keep: "KEEP {v}" });
    const before = JSON.stringify(i.stats());
    const rendered = i.t("keep", { v: 7 });
    assert.throws(() => i.defineMessages("en", { bombed: bombOfDepth(4000) }), MessageDepthError);
    assert.equal(JSON.stringify(i.stats()), before, "stats() unchanged after the throw");
    assert.equal(i.t("keep", { v: 7 }), rendered, "the prior key is unchanged");
    assert.equal(i.t("bombed"), "bombed", "the bombed key did not commit");
});

// ---------- I-06: nesting is supported ----------

test("I-06: nested plural inside select renders (the feature the README once denied)", () => {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        nested: "{g, select, male {He has {n, plural, one {# apple} other {# apples}}} other {none}}",
    });
    assert.equal(i.t("nested", { g: "male", n: 1 }), "He has 1 apple");
    assert.equal(i.t("nested", { g: "male", n: 3 }), "He has 3 apples");
    assert.equal(i.t("nested", { g: "female", n: 3 }), "none");
});

// ---------- I-05: the load/define race has a decided winner ----------

function captureWarnings() {
    const warnings = [];
    const original = console.warn;
    console.warn = (m) => warnings.push(String(m));
    return { warnings, restore: () => { console.warn = original; } };
}

test("I-05 load-then-define: the synchronous define beats the in-flight load", async () => {
    const i = createI18n({ locale: "fr" });
    const cap = captureWarnings();
    let p;
    try {
        // Load in flight, then an explicit define lands before it resolves.
        p = i.loadLocale("fr", () => new Promise((res) => setTimeout(() => res({ k: "from-loader" }), 10)));
        i.defineMessages("fr", { k: "from-define" });
        assert.equal(i.t("k"), "from-define", "define is visible immediately");
        await assert.doesNotReject(p, "the promise resolves, it does not reject");
    } finally {
        cap.restore();
    }
    assert.equal(i.t("k"), "from-define", "the intentional writer won");
    assert.equal(cap.warnings.length, 1, "the discarded load emits exactly one warning");
    assert.match(cap.warnings[0], /result discarded/);
    assert.match(cap.warnings[0], /"fr"/, "the warning names the superseded locale");
    assert.equal(i.stats().loadsInFlight, 0, "the in-flight slot is cleared");
});

test("I-05 define-then-load: a define already committed short-circuits a later load", async () => {
    const i = createI18n({ locale: "fr" });
    const cap = captureWarnings();
    let loaderRan = false;
    let p;
    try {
        i.defineMessages("fr", { k: "from-define" });
        // fr is already defined, so loadLocale must resolve without running the
        // loader at all -- the define trivially wins.
        p = i.loadLocale("fr", () => { loaderRan = true; return Promise.resolve({ k: "from-loader" }); });
        await p;
    } finally {
        cap.restore();
    }
    assert.equal(loaderRan, false, "an already-defined locale must not run the loader");
    assert.equal(i.t("k"), "from-define", "the define still wins");
    assert.equal(cap.warnings.length, 0, "no discard warning: the loader never produced a result");
});

test("I-05 both-in-flight: a define during a load supersedes it; a fresh later load then wins", async () => {
    const i = createI18n({ locale: "fr" });
    const cap = captureWarnings();
    try {
        // First load in flight, superseded by an explicit define.
        const p1 = i.loadLocale("fr", () => new Promise((res) => setTimeout(() => res({ k: "loader-1" }), 10)));
        i.defineMessages("fr", { k: "from-define" });
        await p1;
        assert.equal(i.t("k"), "from-define", "the define beat the first load");
        assert.equal(cap.warnings.length, 1, "the superseded load warned once");
        // A brand-new load AFTER the define is NOT superseded (marks are cleared
        // with their promise) -- but fr is already defined, so it short-circuits.
        let ran = false;
        await i.loadLocale("fr", () => { ran = true; return Promise.resolve({ k: "loader-2" }); });
        assert.equal(ran, false, "a fresh load for an already-defined locale short-circuits");
        assert.equal(i.t("k"), "from-define", "the define value stands");
    } finally {
        cap.restore();
    }
});

test("I-05: a load that is NOT superseded still commits normally", async () => {
    const i = createI18n({ locale: "de" });
    const cap = captureWarnings();
    try {
        await i.loadLocale("de", () => Promise.resolve({ k: "from-loader" }));
    } finally {
        cap.restore();
    }
    assert.equal(i.t("k"), "from-loader", "an uncontested load commits its dict");
    assert.equal(cap.warnings.length, 0, "no supersession warning for an uncontested load");
});
