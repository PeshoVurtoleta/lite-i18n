/**
 * T3 -- adversarial templates: compile storm + fail-loud corpus.
 *
 * Compile storm: many defineMessages over generated dicts; assert stats()
 * counts honestly and locales stay bounded. Fail-loud corpus: each bad
 * template is pinned to a NAMED error at define time. Atomicity: a bad template
 * mid-batch leaves the dict byte-identical (the staging Map guarantee).
 *
 * Note (I-07, FIXED v1.2.1): the depth bomb now throws a NAMED MessageDepthError
 * (a SyntaxError subclass carrying the key and the depth), capped at compile time
 * at MAX_TEMPLATE_DEPTH = 32 -- never the bare RangeError the uncapped recursive
 * tokenizer used to bottom out in. The staging Map leaves the live dict
 * byte-identical after the throw, asserted below rather than assumed.
 */

import { createI18n, MessageDepthError } from "../../I18n.js";
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
    // I-07 (v1.2.1): a depth bomb throws a NAMED MessageDepthError carrying the
    // key and the depth, capped at compile time -- not a bare stack RangeError.
    let bomb = "x";
    for (let d = 0; d < 4000; d++) bomb = "{n, plural, other {" + bomb + "}}";
    throwsDefine({ k: bomb }, "MessageDepthError", "depth bomb (I-07, named + capped)");
    {
        // The named error carries the offending key and the depth reached, and
        // the cap fires far below the stack (never a RangeError).
        const inst = createI18n({ locale: "en" });
        let err = null;
        try { inst.defineMessages("en", { deep: bomb }); } catch (e) { err = e; }
        check(err instanceof MessageDepthError,
            () => `T3: depth bomb threw ${err && err.name}, want MessageDepthError`);
        check(err.key === "deep",
            () => `T3: MessageDepthError did not name the key: ${JSON.stringify(err.key)}`);
        check(typeof err.depth === "number" && err.depth > 32,
            () => `T3: MessageDepthError did not carry a depth > 32: ${JSON.stringify(err.depth)}`);
    }
    {
        // Byte-identical dict after a depth throw (the staging Map guarantee,
        // asserted not assumed). A good key committed first must survive, and
        // stats() must be unchanged by the failed define.
        const inst = createI18n({ locale: "en" });
        inst.defineMessages("en", { keep: "KEEP {v}" });
        const before = JSON.stringify(inst.stats());
        const rendered = inst.t("keep", { v: 1 });
        let threw = false;
        try { inst.defineMessages("en", { bombed: bomb }); } catch { threw = true; }
        check(threw, () => `T3: depth bomb did not throw at define`);
        check(JSON.stringify(inst.stats()) === before,
            () => `T3: stats() changed after a depth throw -- dict not byte-identical`);
        check(inst.t("keep", { v: 1 }) === rendered,
            () => `T3: a prior key changed after a depth throw`);
        check(inst.t("bombed") === "bombed",
            () => `T3: the bombed key committed despite the throw`);
    }
    // Depth 32 is accepted; depth 33 is the first rejected -- the boundary is
    // exact, not approximate.
    {
        const inst = createI18n({ locale: "en" });
        const wrap = (n) => { let s = "deep"; for (let d = 0; d < n; d++) s = "{n, plural, other {" + s + "}}"; return s; };
        let ok32 = true;
        try { inst.defineMessages("en", { d32: wrap(32) }); } catch { ok32 = false; }
        check(ok32, () => `T3: a 32-deep message was rejected -- the cap is too tight`);
        throwsDefine({ d33: wrap(33) }, "MessageDepthError", "depth 33 (one past the cap)");
    }

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
