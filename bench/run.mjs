// bench/run.mjs
//
// Compares lite-i18n against i18next and intl-messageformat (formatjs) on
// four representative workloads. Each workload runs 1M iterations after a
// 100k-iteration warm-up. Times are wall-clock via process.hrtime.bigint;
// per-op cost is derived as ns/op and ops/sec.
//
// Runs are deterministic given the same node build; publish results with the
// node --version stamped alongside.
//
// Fairness notes:
//   * Each library is fed the template shape it natively supports.
//     lite-i18n and formatjs use ICU MessageFormat; i18next uses its
//     native {{var}} + suffix-based plural forms.
//   * Selectors invoked are the same category for the same input across
//     libraries (e.g. count=5 -> "other" in en for all three).
//   * Correctness is asserted BEFORE timing: if outputs diverge, the
//     benchmark aborts. No point comparing wrong-and-fast to right-and-slow.

import { createI18n as createLite } from "../I18n.js";
import i18next from "i18next";
import { IntlMessageFormat } from "intl-messageformat";

const ITER = 1_000_000;
const COMP_ITER = 500_000;   // composition is heavier; use fewer iterations
const WARM = 100_000;

// ---------- lite-i18n setup ----------
const lite = createLite({ locale: "en" });
lite.defineMessages("en", {
    simple:      "Hello, {name}! You have {count} messages.",
    plural:      "{count, plural, one {# item} other {# items}}",
    select:      "{gender, select, male {He is here} female {She is here} other {They are here}}",
    composition: "{gender, select, "
        + "male {He has {n, plural, one {# apple} other {# apples}}} "
        + "female {She has {n, plural, one {# apple} other {# apples}}} "
        + "other {They have {n, plural, one {# apple} other {# apples}}}}",
});

// ---------- i18next setup ----------
// i18next uses {{var}} interpolation + suffix-based plural resources.
// It doesn't support select natively, so for select we compare against
// its native equivalent (context-based resource selection).
await i18next.init({
    lng: "en",
    resources: {
        en: {
            translation: {
                simple: "Hello, {{name}}! You have {{count}} messages.",
                plural_one:   "{{count}} item",
                plural_other: "{{count}} items",
                select_male:   "He is here",
                select_female: "She is here",
                select:        "They are here",   // "other" -> base key
                // Composition uses interpolation + context + count.
                composition_male_one:   "He has {{n}} apple",
                composition_male_other: "He has {{n}} apples",
                composition_female_one: "She has {{n}} apple",
                composition_female_other:"She has {{n}} apples",
                composition_one:        "They have {{n}} apple",
                composition_other:      "They have {{n}} apples",
            },
        },
    },
    interpolation: { escapeValue: false },
});

// ---------- formatjs setup ----------
// intl-messageformat compiles the message once; the same ICU template as
// lite-i18n. The `.format(params)` call is the hot path.
const fjSimple = new IntlMessageFormat(
    "Hello, {name}! You have {count} messages.", "en"
);
const fjPlural = new IntlMessageFormat(
    "{count, plural, one {# item} other {# items}}", "en"
);
const fjSelect = new IntlMessageFormat(
    "{gender, select, male {He is here} female {She is here} other {They are here}}", "en"
);
const fjComp = new IntlMessageFormat(
    "{gender, select, "
    + "male {He has {n, plural, one {# apple} other {# apples}}} "
    + "female {She has {n, plural, one {# apple} other {# apples}}} "
    + "other {They have {n, plural, one {# apple} other {# apples}}}}",
    "en"
);

// ---------- Correctness asserts (before timing) ----------

function must(actual, expected, label) {
    if (actual !== expected) {
        console.error(`\n[correctness] ${label} MISMATCH`);
        console.error(`  actual:   ${JSON.stringify(actual)}`);
        console.error(`  expected: ${JSON.stringify(expected)}`);
        process.exit(1);
    }
}

// Simple
must(lite.t("simple", { name: "Zahary", count: 42 }),
    "Hello, Zahary! You have 42 messages.", "lite/simple");
must(i18next.t("simple", { name: "Zahary", count: 42 }),
    "Hello, Zahary! You have 42 messages.", "i18next/simple");
must(fjSimple.format({ name: "Zahary", count: 42 }),
    "Hello, Zahary! You have 42 messages.", "formatjs/simple");

// Plural (count=5 -> "other" in en)
must(lite.t("plural", { count: 5 }), "5 items", "lite/plural");
must(i18next.t("plural", { count: 5 }), "5 items", "i18next/plural");
must(fjPlural.format({ count: 5 }), "5 items", "formatjs/plural");

// Select (gender=male)
must(lite.t("select", { gender: "male" }), "He is here", "lite/select");
must(i18next.t("select", { context: "male" }), "He is here", "i18next/select");
must(fjSelect.format({ gender: "male" }), "He is here", "formatjs/select");

// Composition (male, n=5)
must(lite.t("composition", { gender: "male", n: 5 }), "He has 5 apples", "lite/comp");
must(i18next.t("composition", { context: "male", count: 5, n: 5 }), "He has 5 apples", "i18next/comp");
must(fjComp.format({ gender: "male", n: 5 }), "He has 5 apples", "formatjs/comp");

console.log("[correctness] all libraries produce identical output for the timed inputs.\n");

// ---------- Timing ----------

function nowNs() { return process.hrtime.bigint(); }

function bench(name, fn, iterations) {
    // Warm up JIT
    for (let k = 0; k < WARM; k++) fn();
    // Time
    const start = nowNs();
    for (let k = 0; k < iterations; k++) fn();
    const end = nowNs();
    const nsTotal = Number(end - start);
    const nsPerOp = nsTotal / iterations;
    const opsPerSec = 1e9 / nsPerOp;
    return { name, iterations, nsPerOp, opsPerSec, msTotal: nsTotal / 1e6 };
}

const workloads = [
    {
        label: "simple interpolation",
        iters: ITER,
        runners: [
            () => bench("lite-i18n", () => lite.t("simple", { name: "Zahary", count: 42 }), ITER),
            () => bench("i18next",   () => i18next.t("simple", { name: "Zahary", count: 42 }), ITER),
            () => bench("formatjs",  () => fjSimple.format({ name: "Zahary", count: 42 }), ITER),
        ],
    },
    {
        label: "plural (en, count=5)",
        iters: ITER,
        runners: [
            () => bench("lite-i18n", () => lite.t("plural", { count: 5 }), ITER),
            () => bench("i18next",   () => i18next.t("plural", { count: 5 }), ITER),
            () => bench("formatjs",  () => fjPlural.format({ count: 5 }), ITER),
        ],
    },
    {
        label: "select (gender=male)",
        iters: ITER,
        runners: [
            () => bench("lite-i18n", () => lite.t("select", { gender: "male" }), ITER),
            () => bench("i18next",   () => i18next.t("select", { context: "male" }), ITER),
            () => bench("formatjs",  () => fjSelect.format({ gender: "male" }), ITER),
        ],
    },
    {
        label: "select+plural composition",
        iters: COMP_ITER,
        runners: [
            () => bench("lite-i18n", () => lite.t("composition", { gender: "male", n: 5 }), COMP_ITER),
            () => bench("i18next",   () => i18next.t("composition", { context: "male", count: 5, n: 5 }), COMP_ITER),
            () => bench("formatjs",  () => fjComp.format({ gender: "male", n: 5 }), COMP_ITER),
        ],
    },
];

// ---------- Run and report ----------

console.log(`node: ${process.version}`);
console.log(`iterations: ${ITER.toLocaleString()} (${COMP_ITER.toLocaleString()} for composition)`);
console.log(`warm-up: ${WARM.toLocaleString()} per workload\n`);

const allResults = [];
for (const w of workloads) {
    console.log(`--- ${w.label} ---`);
    const results = w.runners.map((r) => r());
    // Sort by ops/sec descending
    results.sort((a, b) => b.opsPerSec - a.opsPerSec);
    const fastest = results[0].opsPerSec;
    for (const r of results) {
        const rel = r.opsPerSec / fastest;
        console.log(
            `  ${r.name.padEnd(10)} ${(r.opsPerSec / 1e6).toFixed(2).padStart(6)} Mops/s   `
            + `${r.nsPerOp.toFixed(0).padStart(4)} ns/op   `
            + `(${(rel * 100).toFixed(0)}%)`
        );
    }
    allResults.push({ label: w.label, results });
    console.log();
}

// ---------- Markdown table (paste-ready for README) ----------

console.log("--- Markdown (paste into README) ---\n");
console.log("| Workload | lite-i18n | i18next | formatjs |");
console.log("|----------|-----------|---------|----------|");
for (const w of allResults) {
    const byName = new Map(w.results.map((r) => [r.name, r]));
    const fmt = (name) => {
        const r = byName.get(name);
        return `${(r.opsPerSec / 1e6).toFixed(2)} Mops/s`;
    };
    console.log(`| ${w.label} | ${fmt("lite-i18n")} | ${fmt("i18next")} | ${fmt("formatjs")} |`);
}

console.log(`\nnode ${process.version} · warm-up ${WARM.toLocaleString()} · measured ${ITER.toLocaleString()}${COMP_ITER !== ITER ? ` (${COMP_ITER.toLocaleString()} for composition)` : ""} iterations`);
