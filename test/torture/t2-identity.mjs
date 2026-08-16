/**
 * T2 -- the identity matrix (this package's A-07). Filled by I1 (v1.1.4).
 *
 * Six read sites x four property provenances. This is where I-01 lived: the
 * select variable (I18n.js:367), the plural/selectordinal variable (:354) and
 * the plural-object count (:462) were bare `params[key]` reads with no
 * Object.hasOwn guard, so Object.prototype decided which variant rendered.
 * v1.1.4 adds one hasOwn per selector read -- the same well-predicted branch a
 * slot already pays -- and this tier pins the whole matrix.
 *
 *   Read site                       | own | inherited  | null-proto | Proxy
 *   --------------------------------|-----|------------|------------|--------
 *   type-1 slot {name}              | ok  | "" (guard) | ok         | honoured
 *   # inside a plural variant       | ok  | "" (guard) | ok         | honoured
 *   plural variable                 | ok  | other (fix)| ok         | honoured
 *   selectordinal variable          | ok  | other (fix)| ok         | honoured
 *   select variable                 | ok  | other (fix)| ok         | honoured
 *   plural(key, n) merged count     | ok  | n/a        | ok         | honoured
 *
 * The Proxy contract (decisions/0002-selector-reads.md): Object.hasOwn triggers
 * the getOwnPropertyDescriptor trap, so after the fix every selector read emits
 * a `gopd` before its `get`. A Proxy that exposes the property as own (gopd
 * returns a descriptor) is honoured; one whose gopd returns undefined now
 * selects `other`, exactly like a slot. The observable trap sequences are pinned
 * below so a later refactor cannot change them silently.
 */

import { createI18n } from "../../I18n.js";
import { check } from "./harness.mjs";

/** A trap-logging Proxy over `target`. `log` receives "trap:key" per access. */
function loggingProxy(target, log) {
    return new Proxy(target, {
        getOwnPropertyDescriptor(t, k) {
            log.push("gopd:" + String(k));
            return Reflect.getOwnPropertyDescriptor(t, k);
        },
        get(t, k) {
            log.push("get:" + String(k));
            return Reflect.get(t, k);
        },
    });
}

export async function run() {
    const i = createI18n({ locale: "en" });
    i.defineMessages("en", {
        slot: "{name}",
        plural: "{count, plural, one {# item} other {# items}}",
        ordinal: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
        select: "{gender, select, male {He} female {She} other {They}}",
        pobj: { one: "# thing", other: "# things" },
    });

    // ---- Column: own property (renders the value at every site) --------------
    check(i.t("slot", { name: "Z" }) === "Z", () => "T2 slot/own");
    check(i.t("plural", { count: 3 }) === "3 items", () => "T2 plural/own");           // # inside variant reads own count
    check(i.t("plural", { count: 1 }) === "1 item", () => "T2 plural/own one");
    check(i.t("ordinal", { n: 3 }) === "3rd", () => "T2 selectordinal/own");
    check(i.t("select", { gender: "male" }) === "He", () => "T2 select/own");
    check(i.t("pobj", { count: 1 }) === "1 thing", () => "T2 plural-object/own");
    check(i.plural("plural", 3) === "3 items", () => "T2 plural()/own");
    check(i.plural("plural", 1) === "1 item", () => "T2 plural()/own one");

    // ---- Column: null-prototype own property (still ok at every site) --------
    const npSlot = Object.create(null); npSlot.name = "N";
    check(i.t("slot", npSlot) === "N", () => "T2 slot/null-proto");
    const npPlural = Object.create(null); npPlural.count = 3;
    check(i.t("plural", npPlural) === "3 items", () => "T2 plural/null-proto");         // selector AND # read own count
    const npOrd = Object.create(null); npOrd.n = 3;
    check(i.t("ordinal", npOrd) === "3rd", () => "T2 selectordinal/null-proto");
    const npSel = Object.create(null); npSel.gender = "female";
    check(i.t("select", npSel) === "She", () => "T2 select/null-proto");
    const npObj = Object.create(null); npObj.count = 1;
    check(i.t("pobj", npObj) === "1 thing", () => "T2 plural-object/null-proto");
    const npPluralFn = Object.create(null); npPluralFn.x = 1; // extra own key spreads harmlessly
    check(i.plural("plural", 3, npPluralFn) === "3 items", () => "T2 plural()/null-proto");

    // ---- Column: inherited property (guard -> "" for slots, `other` for selectors)
    // set on Object.prototype, restored in finally so later tiers are unpolluted.
    try {
        // eslint-disable-next-line no-extend-native
        Object.prototype.name = "PWN";
        // eslint-disable-next-line no-extend-native
        Object.prototype.count = 1;
        // eslint-disable-next-line no-extend-native
        Object.prototype.n = 3;
        // eslint-disable-next-line no-extend-native
        Object.prototype.gender = "male";
        // slot: inherited name never leaks -> "".
        check(i.t("slot", {}) === "", () => "T2 slot/inherited leaked " + i.t("slot", {}));
        // plural variable: inherited count must not pick `one`; # (a guarded
        // slot) renders "" -> " items", byte-identical to the unpolluted `other`.
        check(i.t("plural", {}) === " items", () => "T2 plural/inherited leaked " + i.t("plural", {}));
        // # inside the chosen variant is a guarded slot: no inherited number.
        check(i.t("plural", {}).indexOf("1") === -1, () => "T2 #/inherited leaked a number");
        // selectordinal variable: inherited n must not pick `few` -> "th".
        check(i.t("ordinal", {}) === "th", () => "T2 selectordinal/inherited leaked " + i.t("ordinal", {}));
        // select variable: inherited gender must not pick `male` -> "They".
        check(i.t("select", {}) === "They", () => "T2 select/inherited leaked " + i.t("select", {}));
        // plural-object count: inherited count must not pick `one` -> " things".
        check(i.t("pobj", {}) === " things", () => "T2 plural-object/inherited leaked " + i.t("pobj", {}));
    } finally {
        delete Object.prototype.name;
        delete Object.prototype.count;
        delete Object.prototype.n;
        delete Object.prototype.gender;
    }

    // ---- Column: Proxy get-trap (honoured when exposed as own) ---------------
    // The property is a real own property of the target, so gopd returns a
    // descriptor and hasOwn is true. Pin the trap sequence: every read gains a
    // `gopd` before its `get` (decisions/0002-selector-reads.md).
    let log = [];
    check(i.t("slot", loggingProxy({ name: "PX" }, log)) === "PX", () => "T2 slot/proxy");
    check(log.join(",") === "gopd:name,get:name", () => "T2 slot/proxy traps: " + log.join(","));

    log = [];
    check(i.t("select", loggingProxy({ gender: "male" }, log)) === "He", () => "T2 select/proxy");
    check(log.join(",") === "gopd:gender,get:gender", () => "T2 select/proxy traps: " + log.join(","));

    log = [];
    check(i.t("plural", loggingProxy({ count: 1 }, log)) === "1 item", () => "T2 plural/proxy");
    // selector read (gopd,get) then the # slot read (gopd,get).
    check(log.join(",") === "gopd:count,get:count,gopd:count,get:count", () => "T2 plural/proxy traps: " + log.join(","));

    log = [];
    check(i.t("ordinal", loggingProxy({ n: 2 }, log)) === "2nd", () => "T2 selectordinal/proxy");
    check(log.join(",") === "gopd:n,get:n,gopd:n,get:n", () => "T2 selectordinal/proxy traps: " + log.join(","));

    log = [];
    check(i.t("pobj", loggingProxy({ count: 1 }, log)) === "1 thing", () => "T2 plural-object/proxy");
    check(log.join(",") === "gopd:count,get:count,gopd:count,get:count", () => "T2 plural-object/proxy traps: " + log.join(","));

    // plural() spreads the proxy's own keys into a plain object, then reads own
    // count -- honoured, no trap surprises at the read site.
    check(i.plural("plural", 3, new Proxy({ x: 1 }, {})) === "3 items", () => "T2 plural()/proxy");

    // A Proxy whose gopd returns undefined (property NOT own) now selects
    // `other`, exactly like a slot -- the decided consequence of routing
    // selector reads through Object.hasOwn.
    const pxUndef = new Proxy({}, {
        getOwnPropertyDescriptor() { return undefined; },
        get(_t, k) { return k === "gender" ? "male" : undefined; },
    });
    check(i.t("select", pxUndef) === "They", () => "T2 select/proxy-undefined-descriptor must select other, got " + i.t("select", pxUndef));
}
