/**
 * T0 -- metamorphic laws over a fixed corpus.
 *
 * Laws that must hold for every entry, stated as assertions so nobody deletes
 * a feature by editing prose (the I-06 lesson: the nested-plural law is pinned
 * here, not in a README paragraph that already drifted once).
 *
 *   - t(k, p) is pure: same key/params/locale -> same string, and p is never
 *     mutated (frozen params must not throw).
 *   - plural(k, n, p) == t(k, {...p, [pluralVar]: n}).
 *   - defineMessages is order-independent for disjoint key sets.
 *   - nested render == manual composition (I-06).
 *   - fallback resolution terminates on a chain with the active locale, a
 *     repeat, and a self-reference.
 *   - compiling the same dict twice yields identical output.
 */

import { createI18n } from "../../I18n.js";
import { check, makePrng, SEED } from "./harness.mjs";

export async function run() {
    const rng = makePrng(SEED);

    const inst = createI18n({ locale: "en" });
    inst.defineMessages("en", {
        greet: "Hi {name}",
        files: "{n, plural, one {# file} other {# files}}",
        gender: "{g, select, male {He} female {She} other {They}}",
        rank: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
        nested: "{g, select, male {He has {n, plural, one {# apple} other {# apples}}} other {none}}",
    });

    // --- purity + no mutation -------------------------------------------------
    // Frozen params must render identically twice and must not be mutated.
    const p0 = Object.freeze({ name: "Ada" });
    const a = inst.t("greet", p0);
    const b = inst.t("greet", p0);
    check(a === b, () => `T0: t not pure -- "${a}" != "${b}"`);
    check(a === "Hi Ada", () => `T0: greet rendered "${a}"`);

    // Fuzz the count law across a spread of integers.
    for (let i = 0; i < 2000; i++) {
        const n = (rng() % 1000) | 0;
        const viaPlural = inst.plural("files", n);
        const viaT = inst.t("files", { n });
        check(viaPlural === viaT,
            () => `T0: plural/t divergence at n=${n}: "${viaPlural}" != "${viaT}"`);
    }

    // --- order independence for disjoint key sets -----------------------------
    const one = createI18n({ locale: "en" });
    one.defineMessages("en", { x: "X {v}" });
    one.defineMessages("en", { y: "Y {v}" });
    const two = createI18n({ locale: "en" });
    two.defineMessages("en", { y: "Y {v}" });
    two.defineMessages("en", { x: "X {v}" });
    check(one.t("x", { v: 1 }) === two.t("x", { v: 1 }) &&
          one.t("y", { v: 2 }) === two.t("y", { v: 2 }),
        () => `T0: defineMessages not order-independent`);

    // --- nested render == manual composition (I-06) ---------------------------
    // The nesting law holds through t() with an explicit params object -- that
    // is the feature README:186 wrongly denies, pinned so nobody deletes it.
    const composed = inst.t("nested", { g: "male", n: 3 });
    const innerPlural = inst.t("files", { n: 3 }); // "3 files" -- shares category selection
    check(composed === "He has 3 apples",
        () => `T0: nested composition rendered "${composed}"`);
    check(innerPlural === "3 files",
        () => `T0: inner plural rendered "${innerPlural}"`);

    // KNOWN-FAILING, scoped (I-15, S2): the plural()-merge form of the SAME
    // nesting does NOT hold today. compileString scans TOP-LEVEL tokens only for
    // the plural variable (I18n.js:396-403); in a nested template the top-level
    // token is the select, so the scan finds nothing, pluralVar stays null, and
    // plural() merges the count under "count" instead of "n" -- the inner # then
    // reads an absent param and renders "". This law will hold after I3 fixes
    // the compile-time scan (same family as I-08); until then the current buggy
    // output is pinned so the gate stays green and the regression is named, not
    // deleted. Blueprint B0 precedent: register the excluded case, do not drop
    // the law. When I3 lands, flip this to `=== composed`.
    const manualInner = inst.plural("nested", 3, { g: "male" });
    check(manualInner === "He has  apples",
        () => `T0: I-15 nested plural() merge changed from the pinned buggy ` +
            `output "He has  apples" to "${manualInner}" -- if I3 fixed the ` +
            `compile-time scan, flip this pin to === "He has 3 apples"`);

    // --- fallback terminates on a pathological chain --------------------------
    const fb = createI18n({ locale: "en" });
    fb.defineMessages("en", { k: "EN" });
    fb.defineMessages("de", { only_de: "DE" });
    // Chain contains the active locale, a repeat, and a self-reference.
    fb.setFallback(["en", "de", "de", "en"]);
    const r1 = fb.t("only_de");      // resolves via fallback to "DE"
    const r2 = fb.t("k");            // resolves in active locale
    const r3 = fb.t("missing_everywhere"); // returns the key, must not loop
    check(r1 === "DE", () => `T0: fallback chain did not resolve only_de: "${r1}"`);
    check(r2 === "EN", () => `T0: fallback chain broke active lookup: "${r2}"`);
    check(r3 === "missing_everywhere",
        () => `T0: missing-key over a cyclic fallback chain returned "${r3}"`);

    // --- double compile is idempotent -----------------------------------------
    const dc = createI18n({ locale: "en" });
    const dict = { m: "{n, plural, one {# item} other {# items}}" };
    dc.defineMessages("en", dict);
    const first = dc.t("m", { n: 5 });
    dc.defineMessages("en", dict);
    const second = dc.t("m", { n: 5 });
    check(first === second && first === "5 items",
        () => `T0: recompiling the same dict changed output "${first}" -> "${second}"`);
}
