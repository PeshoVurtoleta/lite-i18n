/**
 * T3 -- adversarial templates: compile storm + fail-loud corpus.
 *
 * Compile storm: many defineMessages over generated dicts; assert stats()
 * counts honestly and locales stay bounded. Fail-loud corpus: each bad
 * template is pinned to a NAMED error at define time. Atomicity: a bad template
 * mid-batch leaves the dict byte-identical (the staging Map guarantee).
 *
 * Note (I-07): the depth bomb throws a raw RangeError from the recursive
 * tokenizer, NOT a named library error. That is pinned here as the CURRENT
 * behaviour; I3 (v1.2.1) caps depth and throws a named SyntaxError, at which
 * point this pin changes deliberately.
 */

import { createI18n } from "../../I18n.js";
import { check } from "./harness.mjs";

function throwsDefine(dict, name, label) {
    const inst = createI18n({ locale: "en" });
    let threw = null;
    try { inst.defineMessages("en", dict); } catch (e) { threw = e && e.constructor && e.constructor.name; }
    check(threw === name, () => `T3: ${label} threw ${threw}, want ${name}`);
}

export async function run() {
    // --- compile storm --------------------------------------------------------
    // Merge many small dicts into one locale; keys accumulate, locale count
    // stays 1, and stats() must report the exact key total.
    const storm = createI18n({ locale: "en" });
    const STORM = 5000;
    let expectKeys = 0;
    for (let i = 0; i < STORM; i++) {
        const key = "k" + i;
        storm.defineMessages("en", { [key]: "msg " + i + " {v}" });
        expectKeys++;
    }
    const s = storm.stats();
    check(s.locales === 1, () => `T3: storm grew locales to ${s.locales}, want 1`);
    check(s.keys === expectKeys, () => `T3: storm keys ${s.keys} != ${expectKeys}`);
    // A spot render proves the compiled entries survive the merge.
    check(storm.t("k4999", { v: 7 }) === "msg 4999 7",
        () => `T3: storm entry render wrong: "${storm.t("k4999", { v: 7 })}"`);

    // Every ICU form compiles in one dict.
    const forms = createI18n({ locale: "en" });
    forms.defineMessages("en", {
        lit: "plain",
        slot: "a {x} b",
        plu: "{n, plural, =0 {none} one {# one} other {# many}}",
        sel: "{g, select, male {M} other {O}}",
        ord: "{n, selectordinal, one {#st} other {#th}}",
        po: { one: "# thing", other: "# things" },
        nest: "{g, select, male {He {n, plural, one {# apple} other {# apples}}} other {x}}",
    });
    check(forms.stats().keys === 7, () => `T3: every-form dict keys ${forms.stats().keys} != 7`);

    // --- fail-loud corpus (each pinned to a named error) ----------------------
    throwsDefine({ k: "a {b" }, "SyntaxError", "unbalanced brace");
    throwsDefine({ k: "{n, plural, one {x}}" }, "SyntaxError", "plural missing other");
    throwsDefine({ k: "{n, number}" }, "SyntaxError", "unsupported ICU {n, number}");
    throwsDefine({ k: "{n, plural, 2 {x} other {y}}" }, "SyntaxError", "numeric selector");
    throwsDefine({ k: "{n, plural, many2 {x} other {y}}" }, "SyntaxError", "selector typo many2");
    throwsDefine({ k: "{n, plural, others_ {x} other {y}}" }, "SyntaxError", "selector typo others_");
    throwsDefine({ k: "{g, select, male {x}}" }, "SyntaxError", "select missing other");
    throwsDefine(null, "TypeError", "null dict");
    // I-07: raw RangeError from the recursive tokenizer (unnamed today).
    let bomb = "x";
    for (let d = 0; d < 4000; d++) bomb = "{n, plural, other {" + bomb + "}}";
    throwsDefine({ k: bomb }, "RangeError", "depth bomb (I-07, unnamed today)");

    // Non-string locale is a TypeError regardless of dict.
    {
        const inst = createI18n({ locale: "en" });
        let threw = null;
        try { inst.defineMessages(5, {}); } catch (e) { threw = e && e.constructor && e.constructor.name; }
        check(threw === "TypeError", () => `T3: non-string locale threw ${threw}, want TypeError`);
    }

    // --- ICU quoted-string escapes compile and render literal -----------------
    const esc = createI18n({ locale: "en" });
    esc.defineMessages("en", { a: "'{'", b: "'{name}'", c: "''" });
    check(esc.t("a") === "{", () => `T3: '{' escape rendered "${esc.t("a")}"`);
    check(esc.t("b") === "{name}", () => `T3: '{name}' escape rendered "${esc.t("b")}"`);
    check(esc.t("c") === "'", () => `T3: '' escape rendered "${esc.t("c")}"`);

    // --- atomicity: a bad template mid-batch commits nothing ------------------
    const atomic = createI18n({ locale: "en" });
    atomic.defineMessages("en", { pre: "PRE" });
    let threw = false;
    try {
        atomic.defineMessages("en", { good: "G", bad: "{n, plural, one {x}}", also: "A" });
    } catch { threw = true; }
    check(threw, () => `T3: atomic batch with a bad template did not throw`);
    check(atomic.stats().keys === 1, () => `T3: atomic batch leaked keys, count ${atomic.stats().keys} != 1`);
    check(atomic.t("pre") === "PRE", () => `T3: atomic batch corrupted a prior key`);
    check(atomic.t("good") === "good", () => `T3: atomic batch committed "good" despite the throw`);
}
