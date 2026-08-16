// Version-sync guard (I-16, v1.1.4).
//
// The suite law is a version that lives in four places at once: package.json,
// the `VERSION` const in I18n.js, llms.txt, and -- the gap this test closes --
// the I18n.d.ts declaration. I0 added the runtime `VERSION` export but the
// `.d.ts` never declared it, so for anyone on `tsc` the sync was two places and
// the symbol did not exist. The /release skill's manual grep does not catch a
// MISSING declaration, so this runs under `npm test` (and thus `npm run
// verify`) to make the gap fail CI instead of reopening at the next bump.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../I18n.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");

test("version-sync: runtime VERSION equals package.json version (string compare)", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(VERSION, pkg.version, "I18n.js VERSION and package.json disagree");
});

test("version-sync: I18n.d.ts declares the VERSION export (I-16 gap stays closed)", () => {
    const dts = read("I18n.d.ts");
    assert.match(
        dts, /export const VERSION\s*:\s*string\s*;/,
        "I18n.d.ts must declare `export const VERSION: string;` -- tsc consumers cannot see it otherwise");
});

test("version-sync: llms.txt carries the current version string", () => {
    const llms = read("llms.txt");
    assert.ok(
        llms.includes(VERSION),
        `llms.txt does not mention version ${VERSION} -- the third sync site drifted`);
});
