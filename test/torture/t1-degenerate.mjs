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
    // I-08: exact `=0` is a Map keyed by number; -0 matches it (SameValueZero),
    // string '1' misses every exact but coerces for category selection.
    eq(inst, "files", { n: 0 }, "none");
    eq(inst, "files", { n: -0 }, "none");
    eq(inst, "files", { n: 1 }, "1 file");
    eq(inst, "files", { n: "1" }, "1 file");     // string coerces to 'one'
    eq(inst, "files", { n: NaN }, "NaN files");
    eq(inst, "files", { n: Infinity }, "Infinity files");
    eq(inst, "files", { n: -Infinity }, "-Infinity files");
    eq(inst, "files", { n: -1 }, "-1 file");
    eq(inst, "files", { n: 1.5 }, "1.5 files");
    eq(inst, "files", { n: 1e21 }, "1e+21 files");
    eq(inst, "files", { n: undefined }, " files"); // select(undefined) -> other, # -> ""
    // BigInt count throws out of Intl.PluralRules.select.
    throws(inst, "files", { n: 2n }, "TypeError");

    // plural() merges count under the template's variable (I-08 parity).
    check(inst.plural("files", 0) === "none",
        () => `T1: plural(files,0) = "${inst.plural("files", 0)}"`);
    check(inst.plural("files", 3) === "3 files",
        () => `T1: plural(files,3) = "${inst.plural("files", 3)}"`);
}
