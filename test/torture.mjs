/**
 * @zakkster/lite-i18n -- torture gate.
 *
 * The DONE-WHEN of every session is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Ten tiers share one shape (roadmap section 3). I0 stands up the harness and
 * wires the tiers this session owns:
 *
 *     T0  metamorphic laws            T1  degenerate params + counts
 *     T3  compile storm + fail-loud   T6  the allocation gate (Q1/Q2/Q3) + mono
 *     T7  soak + cache conservation   T9  controls (every gate must fail)
 *
 * T2 (identity matrix, I-01), T4 (lifecycle, I-03/I-05), T5 (differential fuzz)
 * and T8 (cross-surface) are registered as EMPTY tiers so a later session has a
 * slot to write into rather than a file to invent.
 *
 * lite-gc-profiler is one-measurement-at-a-time, so tiers run STRICTLY
 * SEQUENTIALLY -- never nested, never concurrent. Every tier that measures does
 * so in its own window and awaits settle before reading.
 *
 * Controls: `I18N_TORTURE_BREAK=1 node --expose-gc test/torture.mjs` drives T9's
 * five deliberately-broken gates and exits non-zero. A gate that cannot fail is
 * decorative.
 *
 * Peers (lite-gc-profiler) are devDependencies only. I18n.js has zero runtime
 * dependencies beyond its lite-signal peer.
 *
 * @license MIT
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SEED, BREAK } from "./torture/harness.mjs";
import { run as t0 } from "./torture/t0-laws.mjs";
import { run as t1 } from "./torture/t1-degenerate.mjs";
import { run as t2 } from "./torture/t2-identity.mjs";
import { run as t3 } from "./torture/t3-templates.mjs";
import { run as t4 } from "./torture/t4-lifecycle.mjs";
import { run as t5 } from "./torture/t5-fuzz.mjs";
import { run as t6 } from "./torture/t6-alloc.mjs";
import { run as t7 } from "./torture/t7-soak.mjs";
import { run as t8 } from "./torture/t8-cross.mjs";
import { run as t9 } from "./torture/t9-controls.mjs";

const TIERS = [
    ["T0 laws", t0],
    ["T1 degenerate", t1],
    ["T2 identity", t2],
    ["T3 templates", t3],
    ["T4 lifecycle", t4],
    ["T5 fuzz", t5],
    ["T6 alloc", t6],
    ["T7 soak", t7],
    ["T8 cross", t8],
    ["T9 controls", t9],
];

// The Q2 transient gate (T6/T9) counts minor GCs (scavenges) = bytes-allocated
// / new-space-capacity. V8 sizes new-space adaptively between its min and max,
// GROWING it as a long run allocates, so the SAME workload scavenges fewer
// times late in the tier sequence than in the fresh process the ceilings were
// measured in -- an absolute count is position-dependent. --max-semi-space-size
// alone does NOT fix this (it caps growth but new-space still grows up TO the
// cap). Setting min == max PINS new-space at a constant size, and then the
// count is deterministic regardless of sequence position (verified EARLY==LATE
// through a full T6/T7-scale churn). baseline.json's numbers are measured under
// this exact pin. So if the mandated `node --expose-gc test/torture.mjs` did not
// pin it, re-exec ourselves with the pin and pass stdio/exit through.
const SEMI_SPACE_MB = 1;
function reexecPinnedIfNeeded() {
    const pinned = process.execArgv.some((a) => a.startsWith("--min-semi-space-size"));
    if (pinned) return false;
    const child = spawnSync(
        process.execPath,
        [
            "--expose-gc",
            "--min-semi-space-size=" + SEMI_SPACE_MB,
            "--max-semi-space-size=" + SEMI_SPACE_MB,
            fileURLToPath(import.meta.url),
        ],
        { stdio: "inherit" });
    process.exit(child.status === null ? 1 : child.status);
    return true;
}

async function main() {
    reexecPinnedIfNeeded();

    if (typeof globalThis.gc !== "function") {
        process.stderr.write(
            "torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n");
        process.exit(1);
    }

    // Strictly sequential: each tier fully settles before the next opens a
    // window. lite-gc-profiler throws "already in flight" on any overlap.
    for (const [name, run] of TIERS) {
        try {
            await run();
        } catch (err) {
            process.stderr.write(
                "torture: FAIL -- " + name + " threw: " + (err && err.stack || err) +
                "\n  replay: TORTURE_SEED=" + SEED + " node --expose-gc test/torture.mjs\n");
            process.exit(1);
        }
    }

    // In BREAK mode every control tier must have exited already. Reaching here
    // means a control did not trip -- a fault.
    if (BREAK) {
        process.stderr.write(
            "torture: FAIL -- I18N_TORTURE_BREAK set but every control passed\n");
        process.exit(1);
    }

    process.stdout.write("ok\n");
    process.exit(0);
}

main();
