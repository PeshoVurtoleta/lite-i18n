/**
 * T1 -- degenerate params and counts.
 *
 * Every param shape and every count shape crossed against a slot template and
 * a plural template, with the ACTUAL answer pinned -- including the ugly ones
 * (I-08 string/number count split, I-09 throw surface). Pinning "this throws a
 * TypeError" is a valid contract; leaving it unpinned is not. These pins are
 * measured against the working tree, not idealised: if a later session changes
 * one, this tier makes the change visible.
 */

import { createI18n } from "../../I18n.js";
import { check } from "./harness.mjs";

// Assert t(key, params) renders exactly `want`. Message built only on failure.
function eq(inst, key, params, want) {
    const got = inst.t(key, params);
    check(got === want, () => `T1: t(${key}, ${safe(params)}) = "${got}", want "${want}"`);
}

// Assert t(key, params) throws `name`.
function throws(inst, key, params, name) {
    let threw = null;
    try { inst.t(key, params); } catch (e) { threw = e && e.constructor && e.constructor.name; }
    check(threw === name, () => `T1: t(${key}, ...) threw ${threw}, want ${name}`);
}

function safe(v) {
    try { return typeof v === "object" ? JSON.stringify(v) : String(v); }
    catch { return "<unserializable>"; }
}

export async function run() {
    const inst = createI18n({ locale: "en" });
    inst.defineMessages("en", {
        greet: "Hi {name}",
        files: "{n, plural, =0 {none} one {# file} other {# files}}",
        // I-08 (v1.2.1): a =1 exact bucket proves the string/number split -- the
        // exact Map is number-keyed, so '1' used to miss =1 and drop to the `one`
        // category, rendering a DIFFERENT sentence than 1. And a =0 bucket proves
        // the fail-closed half: null/''/undefined must NOT fall into =0.
        ex: "{n, plural, =1 {EXACT} one {ONE} other {MANY}}",
        z: "{n, plural, =0 {ZERO} one {ONE} other {MANY}}",
    });

    // --- degenerate params on a slot template ---------------------------------
    // Missing / nullish / non-object params all coalesce the slot to "".
    eq(inst, "greet", null, "Hi ");
    eq(inst, "greet", undefined, "Hi ");
    eq(inst, "greet", {}, "Hi ");
    eq(inst, "greet", "abc", "Hi ");        // string params: no own 'name'
    eq(inst, "greet", 5, "Hi ");            // number params
    eq(inst, "greet", [1, 2], "Hi ");       // array params
    eq(inst, "greet", Object.freeze({ name: "F" }), "Hi F");
    const np = Object.create(null); np.name = "NP";
    eq(inst, "greet", np, "Hi NP");         // null-proto own property renders
    eq(inst, "greet", { name: 2n }, "Hi 2"); // BigInt slot value stringifies

    // Proxy get-trap is NOT honoured for slots: Object.hasOwn triggers
    // getOwnPropertyDescriptor (absent here), so the slot reads "" -- pinned so
    // I1 records this decision rather than discovering it.
    eq(inst, "greet", new Proxy({}, { has: () => true, get: () => "PX" }), "Hi ");

    // Throw surface (I-09). A Symbol value, a throwing getter, and a throwing
    // toString each propagate out of t().
    throws(inst, "greet", { name: Symbol("s") }, "TypeError");
    throws(inst, "greet", { get name() { throw new Error("boom"); } }, "Error");
    throws(inst, "greet", { name: { toString() { throw new Error("ts"); } } }, "Error");

    // --- degenerate counts on a plural template (variable n) ------------------
    // I-08 (v1.2.1): the selector is normalized ONCE, so exact (number-keyed Map)
    // and category (Intl) dispatch see the same value. -0 matches =0
    // (SameValueZero); numeric strings normalize; nullish/'' stay `other`.
    eq(inst, "files", { n: 0 }, "none");
    eq(inst, "files", { n: "0" }, "none");       // FIX: '0' now matches =0 like 0
    eq(inst, "files", { n: -0 }, "none");
    eq(inst, "files", { n: 1 }, "1 file");
    eq(inst, "files", { n: "1" }, "1 file");     // '1' renders like 1
    eq(inst, "files", { n: NaN }, "NaN files");
    eq(inst, "files", { n: Infinity }, "Infinity files");
    eq(inst, "files", { n: -Infinity }, "-Infinity files");
    eq(inst, "files", { n: -1 }, "-1 file");
    eq(inst, "files", { n: 1.5 }, "1.5 files");
    eq(inst, "files", { n: 1e21 }, "1e+21 files");
    eq(inst, "files", { n: "1e3" }, "1e3 files"); // coerced 1000 -> other; # is raw
    eq(inst, "files", { n: "" }, " files");       // '' stays other (NOT =0)
    eq(inst, "files", { n: null }, " files");     // null stays other (NOT =0)
    eq(inst, "files", { n: undefined }, " files");// undefined stays other
    eq(inst, "files", { n: 2n }, "2 files");      // FIX: BigInt coerces, no throw

    // The I-08 table, verbatim: the =1 exact bucket separates a number-count
    // from a string-count PRE-fix; post-fix they must render the SAME sentence.
    eq(inst, "ex", { n: 1 }, "EXACT");
    eq(inst, "ex", { n: "1" }, "EXACT");          // FIX: '1' now hits =1 exactly
    eq(inst, "ex", { n: 2n }, "MANY");            // 2 -> no =1, category other
    eq(inst, "ex", { n: "1e3" }, "MANY");
    eq(inst, "ex", { n: null }, "MANY");
    eq(inst, "ex", { n: "" }, "MANY");
    eq(inst, "ex", { n: undefined }, "MANY");

    // The fail-closed half: null/''/undefined must NEVER render the =0 sentence.
    // `null` is not zero (suite law); coercing them to 0 would be a violation.
    eq(inst, "z", { n: 0 }, "ZERO");
    eq(inst, "z", { n: "0" }, "ZERO");            // FIX: '0' matches =0
    eq(inst, "z", { n: -0 }, "ZERO");
    eq(inst, "z", { n: null }, "MANY");           // law: null is not zero
    eq(inst, "z", { n: "" }, "MANY");             // law: '' is not zero
    eq(inst, "z", { n: "  " }, "MANY");           // law: blank (whitespace) is not zero
    eq(inst, "z", { n: "\t\n" }, "MANY");         // tabs/newlines are blank too
    eq(inst, "z", { n: " 5 " }, "MANY");          // but ' 5 ' parses to 5 -> other
    eq(inst, "z", { n: undefined }, "MANY");
    eq(inst, "z", { n: NaN }, "MANY");

    // count/string parity for every plural template in the corpus.
    for (const c of [0, 1, 2, 3, 10, 42]) {
        for (const key of ["files", "ex", "z"]) {
            const asNum = inst.t(key, { n: c });
            const asStr = inst.t(key, { n: String(c) });
            check(asNum === asStr,
                () => `T1: I-08 parity broke at ${key} count=${c}: num "${asNum}" != str "${asStr}"`);
        }
    }

    // No count shape -- including the ones that used to throw out of Intl -- may
    // throw from t(). Every dispatch-time failure is named; there are none here.
    for (const c of [0, 1, 2n, 1000n, NaN, Infinity, null, undefined, "", "1", "abc", true, false]) {
        let threw = null;
        try { inst.t("ex", { n: c }); } catch (e) { threw = e && e.name; }
        check(threw === null,
            () => `T1: count ${String(c)} threw ${threw} out of t() -- no input may throw from Intl`);
    }

    // plural() merges count under the template's variable (I-08 parity).
    check(inst.plural("files", 0) === "none",
        () => `T1: plural(files,0) = "${inst.plural("files", 0)}"`);
    check(inst.plural("files", 3) === "3 files",
        () => `T1: plural(files,3) = "${inst.plural("files", 3)}"`);
    check(inst.plural("ex", 1) === "EXACT",
        () => `T1: plural(ex,1) = "${inst.plural("ex", 1)}"`);
}
