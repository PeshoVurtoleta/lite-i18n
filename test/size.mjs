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

// Budgets in GZIPPED-SOURCE bytes. Headroom sized to catch a material regression
// while absorbing normal feature growth. Move these only alongside a re-measured
// min+gz claim in llms.txt / package.json.
//
// I18n.js budget moved 10240 -> 13312 at v1.2.0. WHY, with the numbers -- all
// measured with THIS file's own method (zlib level 9), so they are re-derivable:
//
//                    gzipped source   code-only (comments stripped)
//   5d271ef                8943 B                  4637 B
//   v1.2.0                11718 B                  5410 B
//   growth                +2775 B                  + 773 B   <- 72% is comments
//
// "Comments stripped" means: remove /* */ blocks, drop whole-line // comments,
// collapse the resulting blank-line runs. State the method wherever the split is
// cited -- a different stripper yields different absolute numbers, which is how
// the first draft of this note drifted (it was measured at gzip's DEFAULT level,
// not level 9, and read 8974/11653).
//
// So the metric measures GZIPPED SOURCE and only +773 B of the growth is CODE --
// proportionate for resolveLocale + unloadLocale + clear + LocaleCapacityError +
// bounded caches + eviction + the warn budget + three stats() fields. The other
// 72% is docstrings, which suite law mandates and which cost ZERO shipped bytes
// after minification. Shrinking comments to fit a source-bytes proxy would
// optimize the measurement, not the artifact (the I-10 pathology), so the budget
// moves instead: 13312 B = measured 11718 + ~14% headroom, the same proportional
// margin the original 10240 held over its measurement. The metric's own blind
// spot -- it taxes comment density and cannot see true min+gz -- is filed as
// I-20 (roadmap S3, assigned I7) next to I-13/I-18.
const BUDGETS = [
    { file: "I18n.js", gzBudget: 13312 },
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
