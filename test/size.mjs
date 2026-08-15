// @zakkster/lite-i18n -- size gate (I-13).
//
// The README/llms.txt claim ~3.5 KB min+gz core + ~0.76 KB Format. Nothing in
// the repo measured it, so the claim aged silently across releases. This gate
// makes drift fail CI.
//
// It measures GZIPPED SOURCE bytes (zlib level 9), not minified-then-gzipped:
// the package ships no minifier and adds no dependency for one. So the numbers
// below are ~2.5x the marketing "min+gz" figure and are a RELATIVE regression
// sentinel, not that figure. A budget breach means the source grew materially
// since the budget was set -- re-measure the min+gz claim and move the budget
// deliberately, in the same commit as the change that earned it.
//
// Exit 0 and print the measurements on pass; exit 1 and name the overage on
// fail. Wired into `npm run verify`.

import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Budgets in GZIPPED-SOURCE bytes. Headroom over the 1.1.3 measurement
// (I18n.js 8777, Format.js 2128) sized to catch a material regression while
// absorbing normal feature growth. Move these only alongside a re-measured
// min+gz claim in llms.txt / package.json.
const BUDGETS = [
    { file: "I18n.js", gzBudget: 10240 },
    { file: "Format.js", gzBudget: 2560 },
];

process.stdout.write(
    "size: metric = GZIPPED SOURCE bytes (NOT min+gz). The ~3.5 KB min+gz / " +
    "~0.76 KB claim is not verified in-repo -- see decisions/0001-measurement.md, " +
    "inherited by I7.\n");

let failed = false;
for (const { file, gzBudget } of BUDGETS) {
    const raw = readFileSync(join(ROOT, file));
    const gzsrc = gzipSync(raw, { level: 9 }).length;
    const status = gzsrc <= gzBudget ? "ok" : "OVER";
    process.stdout.write(
        "size " + file + ": raw=" + raw.length + " gzsrc=" + gzsrc +
        " budget=" + gzBudget + " (gzsrc) -- " + status + "\n");
    if (gzsrc > gzBudget) {
        failed = true;
        process.stderr.write(
            "size: FAIL -- " + file + " gzipped source " + gzsrc +
            " B exceeds budget " + gzBudget + " B (+" + (gzsrc - gzBudget) + " B). " +
            "Re-measure and move the budget deliberately.\n");
    }
}
process.exit(failed ? 1 : 0);
