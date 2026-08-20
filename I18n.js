// @zakkster/lite-i18n
// Zero-GC reactive internationalization built on @zakkster/lite-signal.
//
// Design law: compile once at defineMessages, allocate nothing on read.
// Templates parse into a stable token array; a closure over that array is the
// hot path. The only allocation per lookup is the returned string itself.
//
// Reactive graph: t()/plural() subscribe to two signals per instance:
//   _locale  -- current locale
//   _epoch   -- bumped on defineMessages for the active or fallback locale,
//               and on setFallback (both change lookup resolution)
// Any effect or computed calling t() re-runs when either fires.
//
// Author: Zahary Shinikchiev
// License: MIT

import { signal } from "@zakkster/lite-signal";

// Four-place version sync: package.json, this const, I18n.d.ts and llms.txt move together.
export const VERSION = "1.3.0";

// Per-instance ceiling for every per-locale structure keyed on an untrusted
// string (_readySignals, _pluralRules, _ordinalRules). Sized well under
// lite-signal's process-wide 1024-node pool so one instance's readiness signals
// cannot exhaust the pool the whole process shares. The bound is per-instance;
// see decisions/0003-locale-bounds.md for the multi-instance arithmetic and why
// resolveLocale (not the ceiling alone) is the real fix at the call site.
export const LOCALE_CACHE_MAX = 256;

// Per-instance budget for the invalid-locale warning in getRules. The tag set
// is untrusted input (Accept-Language), so warn-once-per-tag is a log-flood
// surface, not rate limiting (I-19). After WARN_BUDGET distinct warnings the
// rest are counted (stats().warningsSuppressed) and silenced.
const WARN_BUDGET = 32;

// ---------- Token types ----------
// 0: literal string
// 1: {key} interpolation slot
// 2: {var, plural, ...} / {var, selectordinal, ...} inline plural block
// 3: {var, select, ...} inline string-keyed select block
// The ICU '#' shortcut compiles to {type: 1, key: <plural variable>}.
// Sub-templates are NOT restricted to types 0 and 1: a plural/select/
// selectordinal block nests freely inside any variant (I-06, v1.2.1 -- the
// nesting law is pinned by torture T0, not by prose). Nesting depth is capped
// at compile time; see MAX_TEMPLATE_DEPTH and MessageDepthError.

const CLDR_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);
const EXACT_RE = /^=(\d+)$/;

// I-07 (v1.2.1): cap argument-block nesting at compile time. 32 is far above any
// real message (a two- or three-axis plural is already exotic) and far below the
// V8 call stack the uncapped recursive tokenizer used to hit -- so a dictionary
// built from a translation file throws a NAMED error naming the key and the
// depth, never a bare anonymous RangeError from deep in the parser.
const MAX_TEMPLATE_DEPTH = 32;

// ---------- Errors ----------
export class MissingKeyError extends Error {
    constructor(key, locale) {
        super(`Missing translation key "${key}" for locale "${locale}"`);
        this.name = "MissingKeyError";
        this.key = key;
        this.locale = locale;
    }
}

// Thrown by ready() when the per-instance readiness-signal cache is full. A
// signal has subscriber IDENTITY, so it is the ONE per-locale structure that
// fails CLOSED rather than evicting (evicting a signal a live effect is
// subscribed to silently orphans it -- worse than the leak). This is a package
// error with a per-INSTANCE blast radius, not lite-signal's process-wide
// CapacityError. See decisions/0003-locale-bounds.md.
export class LocaleCapacityError extends Error {
    constructor(locale, ceiling) {
        super(
            `lite-i18n: readiness-signal cache full (${ceiling} locales) -- ` +
            `cannot register readiness for "${locale}". Bound your locale set with ` +
            `resolveLocale(requested, supported) before calling ready(); do not feed ` +
            `it untrusted strings directly.`
        );
        this.name = "LocaleCapacityError";
        this.locale = locale;
        this.ceiling = ceiling;
    }
}

// Thrown at define time when a message nests argument blocks past
// MAX_TEMPLATE_DEPTH (I-07, v1.2.1). Extends SyntaxError so it groups with every
// other compile-time template failure, but carries the offending key and the
// depth reached -- the uncapped tokenizer used to bottom out in a bare
// `RangeError: Maximum call stack size exceeded` naming nothing. The staging Map
// in internalDefine guarantees the live dict is byte-identical after the throw.
export class MessageDepthError extends SyntaxError {
    constructor(key, depth) {
        super(
            `lite-i18n: message "${key}" nests argument blocks ${depth} deep, ` +
            `past the limit of ${MAX_TEMPLATE_DEPTH}. Split it into separate keys; ` +
            `a plural/select block that deep is almost always a runaway template.`
        );
        this.name = "MessageDepthError";
        this.key = key;
        this.depth = depth;
    }
}

// ---------- Tokenizer ----------

/** @param {string} s @param {number} start position of '{'
 *  Scans for the matching '}' at depth 0. Respects ICU quoted-string mode:
 *  an apostrophe before '{' '}' or '#' opens a quoted section (skipped for
 *  depth counting); the next unpaired apostrophe closes it; '' inside the
 *  quoted section stays literal. */
function findMatchingBrace(s, start) {
    let depth = 1;
    const len = s.length;
    let i = start + 1;
    let quoted = false;
    while (i < len) {
        const ch = s.charCodeAt(i);
        if (quoted) {
            if (ch === 39) {                     // '
                if (s.charCodeAt(i + 1) === 39) { i += 2; continue; }
                quoted = false;
                i++;
                continue;
            }
            i++;
            continue;
        }
        if (ch === 39) {                         // '
            const next = s.charCodeAt(i + 1);
            if (next === 39) { i += 2; continue; }
            if (next === 123 || next === 125 || next === 35) {
                quoted = true;
                i++;
                continue;
            }
            i++;
            continue;
        }
        if (ch === 123) depth++;                 // {
        else if (ch === 125) {                   // }
            depth--;
            if (depth === 0) return i;
        }
        i++;
    }
    throw new SyntaxError(`Unmatched '{' at position ${start} in: ${s}`);
}

/** Parse the inside of a {...} argument block. Shared by tokenizeMessage
 *  and tokenizeSub so nested plural / select / selectordinal blocks compose
 *  the way ICU expects: `{g, select, male {He has {n, plural, one {# apple}
 *  other {# apples}}} ...}` is the canonical multi-axis pattern.
 *
 *  Forward-declared at module level -- compilePluralToken and
 *  compileSelectToken are defined below; function declarations are hoisted. */
function parseArgument(inner, key, depth) {
    const pm = /^\s*(\w+)\s*,\s*(plural|selectordinal|select)\s*,\s*([\s\S]+)$/.exec(inner);
    if (pm) {
        // I-07: enforce the nesting cap BEFORE descending, so the parser never
        // recurses deep enough to hit the raw stack RangeError.
        if (depth > MAX_TEMPLATE_DEPTH) throw new MessageDepthError(key, depth);
        const kind = pm[2];
        if (kind === "select") return compileSelectToken(pm[1], pm[3], key, depth);
        return compilePluralToken(pm[1], pm[3], kind === "selectordinal", key, depth);
    }
    const slotKey = inner.trim();
    // Bare identifier is a slot. Anything with a comma is an unsupported
    // ICU shape ({n, number}, {d, date}, etc.) -- fail loudly.
    if (slotKey.indexOf(",") !== -1) {
        throw new SyntaxError(
            `Unsupported ICU argument "{${inner}}". lite-i18n supports {slot}, {var, plural, ...}, {var, selectordinal, ...}, {var, select, ...}. ` +
            `For number/date/list/relative-time formatting use the Format entry (formatNumber, formatDate, ...).`
        );
    }
    return { type: 1, key: slotKey };
}

/** Tokenize a top-level message template.
 *
 *  ICU quoted-string escape mode:
 *    '{ ... '        -- content between apostrophes is literal
 *    '} ... '        -- same, opens on '} too
 *    '{'             -- three chars: opens quote, {, closes quote  -> literal '{'
 *    '{name}'        -- literal '{name}' (whole slot escaped)
 *    ''              -- literal apostrophe
 *  Any apostrophe NOT followed by { } or ' is a literal apostrophe. */
function tokenizeMessage(template, key) {
    const tokens = [];
    const len = template.length;
    let literal = "";
    let i = 0;
    let quoted = false;
    while (i < len) {
        const ch = template.charCodeAt(i);
        if (quoted) {
            if (ch === 39) {                     // '
                if (template.charCodeAt(i + 1) === 39) { literal += "'"; i += 2; continue; }
                quoted = false;
                i++;
                continue;
            }
            literal += template[i];
            i++;
            continue;
        }
        if (ch === 39) {                         // '
            const next = template.charCodeAt(i + 1);
            if (next === 39) { literal += "'"; i += 2; continue; }
            // '#' also dequotes at top level -- ICU parity with sub-templates,
            // and prevents the same source string from producing different
            // results depending on nesting depth.
            if (next === 123 || next === 125 || next === 35) {
                quoted = true;
                i++;
                continue;
            }
            literal += "'";
            i++;
            continue;
        }
        if (ch === 123) {                        // {
            if (literal) { tokens.push({ type: 0, str: literal }); literal = ""; }
            const close = findMatchingBrace(template, i);
            const inner = template.slice(i + 1, close);
            // Top-level argument block: depth 1.
            tokens.push(parseArgument(inner, key, 1));
            i = close + 1;
            continue;
        }
        literal += template[i];
        i++;
    }
    if (literal) tokens.push({ type: 0, str: literal });
    return tokens;
}

/** Tokenize a plural-variant sub-template. '#' -> {type:1, key: pluralVariable}.
 *
 *  Same ICU quoted-string mode as tokenizeMessage, plus '#' as a quote-opener:
 *    '#'      -- three chars: opens quote, #, closes quote  -> literal '#'
 *    '#more'  -- literal '#more' */
function tokenizeSub(template, pluralVariable, key, depth) {
    const tokens = [];
    const len = template.length;
    let literal = "";
    let i = 0;
    let quoted = false;
    while (i < len) {
        const ch = template.charCodeAt(i);
        if (quoted) {
            if (ch === 39) {                     // '
                if (template.charCodeAt(i + 1) === 39) { literal += "'"; i += 2; continue; }
                quoted = false;
                i++;
                continue;
            }
            literal += template[i];
            i++;
            continue;
        }
        if (ch === 39) {                         // '
            const next = template.charCodeAt(i + 1);
            if (next === 39) { literal += "'"; i += 2; continue; }
            if (next === 123 || next === 125 || next === 35) {
                quoted = true;
                i++;
                continue;
            }
            literal += "'";
            i++;
            continue;
        }
        if (ch === 35) {                         // #  (unescaped -> plural variable)
            if (literal) { tokens.push({ type: 0, str: literal }); literal = ""; }
            tokens.push({ type: 1, key: pluralVariable });
            i++;
            continue;
        }
        if (ch === 123) {                        // {
            if (literal) { tokens.push({ type: 0, str: literal }); literal = ""; }
            const close = findMatchingBrace(template, i);
            const inner = template.slice(i + 1, close);
            // A block found inside this sub-template is one level deeper.
            tokens.push(parseArgument(inner, key, depth + 1));
            i = close + 1;
            continue;
        }
        literal += template[i];
        i++;
    }
    if (literal) tokens.push({ type: 0, str: literal });
    return tokens;
}

/** Compile an inline plural block. `ordinal` selects between cardinal
 *  (Intl.PluralRules) and ordinal (Intl.PluralRules { type: "ordinal" })
 *  category selection at render time. */
function compilePluralToken(variable, body, ordinal, key, depth) {
    const exact = new Map();
    const variants = new Map();
    const len = body.length;
    let i = 0;
    while (i < len) {
        while (i < len && body.charCodeAt(i) <= 32) i++;
        if (i >= len) break;
        // Read selector: word or =N
        let sel = "";
        if (body.charCodeAt(i) === 61) {         // =
            sel = "=";
            i++;
            while (i < len && body.charCodeAt(i) >= 48 && body.charCodeAt(i) <= 57) {
                sel += body[i];
                i++;
            }
        } else {
            while (i < len) {
                const c = body.charCodeAt(i);
                // First char: letter. Subsequent chars: letter | digit | _ so
                // typos like `many2` or `others_` are read as a single bad
                // selector and hit the "Unknown plural selector" error below
                // instead of degrading to "Expected '{' after selector".
                const first = sel.length === 0;
                if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) {
                    sel += body[i]; i++;
                } else if (!first && ((c >= 48 && c <= 57) || c === 95)) {
                    sel += body[i]; i++;
                } else break;
            }
        }
        if (!sel) throw new SyntaxError(`Expected plural selector at position ${i} in: ${body}`);
        while (i < len && body.charCodeAt(i) <= 32) i++;
        if (body.charCodeAt(i) !== 123) {
            throw new SyntaxError(`Expected '{' after plural selector "${sel}"`);
        }
        const close = findMatchingBrace(body, i);
        const subTokens = tokenizeSub(body.slice(i + 1, close), variable, key, depth);
        const em = EXACT_RE.exec(sel);
        if (em) {
            exact.set(+em[1], subTokens);
        } else if (CLDR_KEYS.has(sel)) {
            variants.set(sel, subTokens);
        } else {
            throw new SyntaxError(
                `Unknown plural selector "${sel}" in {${variable}, ${ordinal ? "selectordinal" : "plural"}, ...}. ` +
                `Valid selectors: zero, one, two, few, many, other, or =N.`
            );
        }
        i = close + 1;
    }
    if (!variants.has("other")) {
        throw new SyntaxError(
            `${ordinal ? "Selectordinal" : "Plural"} block for "${variable}" missing required "other" variant`
        );
    }
    return { type: 2, variable, exact, variants, ordinal: !!ordinal };
}

/** Compile a select block: string-keyed dispatch via params[variable], with
 *  a required 'other' fallback. Cheaper than plural at runtime -- no
 *  PluralRules constructor, no locale dependency for selection. */
function compileSelectToken(variable, body, key, depth) {
    const variants = new Map();
    const len = body.length;
    let i = 0;
    while (i < len) {
        while (i < len && body.charCodeAt(i) <= 32) i++;
        if (i >= len) break;
        // Selector: bare identifier, unrestricted. No =N syntax.
        let sel = "";
        while (i < len) {
            const c = body.charCodeAt(i);
            // Same identifier alphabet as slot names, plus digits after first char.
            if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95) {
                sel += body[i]; i++;
            } else if (sel.length > 0 && c >= 48 && c <= 57) {
                sel += body[i]; i++;
            } else break;
        }
        if (!sel) throw new SyntaxError(`Expected select selector at position ${i} in: ${body}`);
        while (i < len && body.charCodeAt(i) <= 32) i++;
        if (body.charCodeAt(i) !== 123) {
            throw new SyntaxError(`Expected '{' after select selector "${sel}"`);
        }
        const close = findMatchingBrace(body, i);
        const subTokens = tokenizeSub(body.slice(i + 1, close), variable, key, depth);
        variants.set(sel, subTokens);
        i = close + 1;
    }
    if (!variants.has("other")) {
        throw new SyntaxError(`Select block for "${variable}" missing required "other" variant`);
    }
    return { type: 3, variable, variants };
}

// ---------- Renderer ----------

// I-08 (v1.2.1): normalize a plural/selectordinal selector ONCE so the exact
// bucket (a number-keyed Map -- `exact.get(1)` hits, `exact.get('1')` misses)
// and the category path (Intl.PluralRules.select) see the SAME value. Without
// this, `count: 1` and `count: '1'` render two different sentences for the same
// logical value -- a form input hands you '1', a counter hands you 1.
//
// This is NOT a bare Number(): that maps null -> 0 and '' -> 0, so under an
// author-written `=0` bucket it would render that ZERO literal for a blank or
// nullish count. `null` is not zero (suite law), and neither is a blank string.
// So:
//   number   -> unchanged (NaN stays NaN)
//   bigint   -> Number(v): a BigInt is a determined numeric count, and coercing
//               it here makes `count: 2n` render like `count: 2` AND keeps the
//               raw `TypeError: Cannot convert a BigInt value to a number` that
//               Intl's own ToNumber used to throw completely unreachable.
//   string   -> the numeric value if it parses ('1' -> 1, '0' -> 0, '1e3' ->
//               1000, ' 5 ' -> 5); a BLANK string (empty or all-whitespace) and
//               a non-numeric string stay as-is, MISSING the number-keyed `=N`
//               buckets.
//   null/undefined/anything else -> unchanged, also missing the `=N` buckets.
// A value left as-is (blank/null/undefined/NaN/non-numeric) never triggers the
// author's `=N` literal; it falls to the CLDR category selector, where
// Intl.PluralRules applies its OWN coercion (`other` in a no-`zero`-category
// locale like English; the locale's `zero` category in e.g. Arabic; `undefined`
// -> NaN -> `other` everywhere). The `=N` buckets are only ever hit by real
// numeric values and numeric strings. See decisions/0004-count-coercion.md.
//
// The whole guard is one typeof and, only for strings, one blank-scan + one
// ToNumber; the number passthrough (the hot path) is untouched. The blank scan
// avoids `.trim()`, which would allocate -- a real number's chars are all above
// 0x20, so the first charCode > 0x20 proves the string is non-blank.
function coerceCount(v) {
    const tp = typeof v;
    if (tp === "number") return v;
    if (tp === "bigint") return Number(v);
    if (tp === "string") {
        // Blank (empty or all-whitespace) stays OUT of the number bucket: blank
        // is not zero. No .trim() -- scan for the first non-whitespace charCode.
        let blank = true;
        for (let i = 0; i < v.length; i++) {
            if (v.charCodeAt(i) > 32) { blank = false; break; }
        }
        if (blank) return v;
        const n = +v;
        return n === n ? n : v;              // NaN (non-numeric) stays as-is
    }
    return v;                                // null/undefined/boolean/object -> unchanged
}

// The plural rules cache lives on the instance -- this renderer receives the
// instance-scoped getter so different instances don't cross-pollute caches.
//
// Slot rendering coalesces nullish values (undefined, null) to "" via ??.
// EVERY read site rejects prototype-chain reads via Object.hasOwn -- the type-1
// slot (type 1), the type-2 plural/selectordinal variable, the type-3 select
// variable, and compilePluralObj's `count` read -- so a single assignment to
// Object.prototype can never decide which variant renders, nor leak an inherited
// value into the output. An absent own property resolves to "" (slot) or the
// `other` variant (selector), which is what a missing param already meant. Each
// guard is one well-predicted branch (I-01, fixed v1.1.4).
function renderTokens(tokens, params, locale, getRules) {
    let out = "";
    const n = tokens.length;
    for (let i = 0; i < n; i++) {
        const t = tokens[i];
        const type = t.type;
        if (type === 0) {
            out += t.str;
        } else if (type === 1) {
            const key = t.key;
            out += Object.hasOwn(params, key) ? (params[key] ?? "") : "";
        } else if (type === 2) {
            const vkey = t.variable;
            const nVal = Object.hasOwn(params, vkey) ? params[vkey] : undefined;
            // I-08: one normalization feeds BOTH exact and category dispatch.
            const cVal = coerceCount(nVal);
            const ex = t.exact.get(cVal);
            if (ex !== undefined) {
                out += renderTokens(ex, params, locale, getRules);
            } else {
                const rules = getRules(locale, t.ordinal);
                const sel = rules.select(cVal);
                const variant = t.variants.get(sel) || t.variants.get("other");
                out += renderTokens(variant, params, locale, getRules);
            }
        } else {
            // type 3: select -- string-keyed dispatch, no PluralRules
            const vkey = t.variable;
            const key = Object.hasOwn(params, vkey) ? params[vkey] : undefined;
            const variant = t.variants.get(key) || t.variants.get("other");
            out += renderTokens(variant, params, locale, getRules);
        }
    }
    return out;
}

// ---------- Compilation ----------

// A compiled entry is always a function (params, locale) => string. We route
// static strings through a closure too so the lookup site has a monomorphic
// call shape.

function compileString(template, key) {
    // Pure literal fast-path. Skip only when the template has none of the
    // characters that could introduce syntax: '{' opens slots/plurals, '#'
    // is the plural shorthand, and "'" may open an ICU quoted section.
    if (template.indexOf("{") === -1 &&
        template.indexOf("#") === -1 &&
        template.indexOf("'") === -1) {
        const fn = function () { return template; };
        fn.pluralVar = null;
        return fn;
    }
    const tokens = tokenizeMessage(template, key);
    // If tokenizer collapsed to a single literal, specialize.
    if (tokens.length === 1 && tokens[0].type === 0) {
        const s = tokens[0].str;
        const fn = function () { return s; };
        fn.pluralVar = null;
        return fn;
    }
    // For plural(key, count, params): find the outermost plural/selectordinal
    // token, if exactly one exists, so plural() merges count under the right
    // variable name. Multiple different plural variables at top level are
    // ambiguous -- plural() falls back to "count" and the caller should use
    // t() with an explicit params object.
    let pluralVar = null;
    let ambiguous = false;
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === 2) {                  // plural / selectordinal
            if (pluralVar === null) pluralVar = tokens[i].variable;
            else if (pluralVar !== tokens[i].variable) { ambiguous = true; break; }
        }
    }
    const fn = function (params, locale, getRules) {
        return renderTokens(tokens, params || EMPTY_PARAMS, locale, getRules);
    };
    fn.pluralVar = ambiguous ? null : pluralVar;
    return fn;
}

function isPluralObj(v) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    let hasOther = false;
    // Object.keys skips inherited enumerables (the docs promise); a plural
    // entry is ALL strings so a nested namespace like { other: { label } }
    // falls through to flattenInto instead of throwing at render time.
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (typeof v[k] !== "string") return false;
        if (CLDR_KEYS.has(k)) {
            if (k === "other") hasOther = true;
            continue;
        }
        if (EXACT_RE.test(k)) continue;
        return false;
    }
    return hasOther;
}

/** Compile a plural-object dict entry `{ one: '...', other: '...', =0: '...' }`.
 *  The variable is implicitly `count`. */
function compilePluralObj(obj, key) {
    const exact = new Map();
    const variants = new Map();
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = obj[k];
        // isPluralObj already guarantees string values, but assert defensively --
        // this is the last line between a bad shape and a runtime TypeError.
        if (typeof v !== "string") continue;
        // A plural-object entry is itself one argument-block level: depth 1.
        const sub = tokenizeSub(v, "count", key, 1);
        const em = EXACT_RE.exec(k);
        if (em) exact.set(+em[1], sub);
        else variants.set(k, sub);
    }
    if (!variants.has("other")) {
        throw new SyntaxError(`Plural-object entry missing required "other" variant`);
    }
    const fn = function (params, locale, getRules) {
        const p = params || EMPTY_PARAMS;
        const nVal = Object.hasOwn(p, "count") ? p.count : undefined;
        // I-08: normalize once, feed both exact and category dispatch.
        const cVal = coerceCount(nVal);
        const ex = exact.get(cVal);
        if (ex !== undefined) return renderTokens(ex, p, locale, getRules);
        const rules = getRules(locale);
        const sel = rules.select(cVal);
        const variant = variants.get(sel) || variants.get("other");
        return renderTokens(variant, p, locale, getRules);
    };
    fn.pluralVar = "count";
    return fn;
}

const EMPTY_PARAMS = Object.freeze({});

/** Flatten a nested dict into a Map<dot.path, compiledEntry>.
 *  A literal dotted key (`"a.b": "..."`) and a nested path (`a: { b: "..." }`)
 *  collide on the same output slot -- resolution is insertion order (last
 *  write wins), because Map.set overwrites. This is deterministic; if you
 *  need both to coexist, rename one. */
function flattenInto(dict, prefix, out) {
    const keys = Object.keys(dict);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = dict[k];
        const path = prefix ? prefix + "." + k : k;
        if (typeof v === "string") {
            out.set(path, compileString(v, path));
        } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            if (isPluralObj(v)) {
                out.set(path, compilePluralObj(v, path));
            } else {
                flattenInto(v, path, out);
            }
        } else {
            // Numbers, arrays, null, undefined, functions, symbols, bigints.
            // Silent drop caused typos to lose keys without a sound; warn
            // once at define time. Not gated on missingKeyPolicy because
            // that policy controls RUNTIME missing-key behavior, not the
            // shape of the dict being defined.
            if (typeof console !== "undefined" && console.warn) {
                const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
                console.warn(
                    `[lite-i18n] defineMessages: skipping "${path}" -- ` +
                    `expected string or nested object, got ${t}. ` +
                    `Typos here silently lose keys; check the dict shape.`
                );
            }
        }
    }
}

// ---------- Locale negotiation ----------

/**
 * Resolve a requested locale against an application's own supported list using
 * BCP 47 prefix matching (no RFC 4647 lookup registry). This is the fix for the
 * unbounded-cache findings AT THE CALL SITE: it turns an untrusted stream of
 * locale strings into a bounded set drawn from `supported`, so the per-locale
 * caches only ever see values the app already vouches for.
 *
 * Matching, in order, all case-insensitive:
 *   1. Exact match.
 *   2. Progressive truncation of the request: `en-US-x` -> `en-US` -> `en`.
 *   3. Reverse prefix: a bare request `en` matches a supported `en-US`.
 * Returns the matching entry from `supported` (original casing), or `undefined`
 * -- a malformed/empty request, an empty list, or no match all fail closed.
 *
 * @param {string} requested
 * @param {string[]} supported
 * @returns {string|undefined}
 */
export function resolveLocale(requested, supported) {
    if (typeof requested !== "string" || !Array.isArray(supported) || supported.length === 0) {
        return undefined;
    }
    const req = requested.toLowerCase();
    if (req === "") return undefined;
    const n = supported.length;
    // 1. Exact (case-insensitive).
    for (let i = 0; i < n; i++) {
        const s = supported[i];
        if (typeof s === "string" && s.toLowerCase() === req) return s;
    }
    // 2. Truncate the request one subtag at a time and re-match.
    let tag = req;
    let cut = tag.lastIndexOf("-");
    while (cut > 0) {
        tag = tag.slice(0, cut);
        for (let i = 0; i < n; i++) {
            const s = supported[i];
            if (typeof s === "string" && s.toLowerCase() === tag) return s;
        }
        cut = tag.lastIndexOf("-");
    }
    // 3. Reverse prefix: bare request matches a more-specific supported tag.
    const reqPrefix = req + "-";
    for (let i = 0; i < n; i++) {
        const s = supported[i];
        if (typeof s === "string" && s.toLowerCase().startsWith(reqPrefix)) return s;
    }
    return undefined;
}

// ---------- createI18n ----------

/**
 * Create an isolated i18n instance. Multiple instances share no state --
 * useful for multi-tenant SDKs, plugin sandboxes, and SSR (one per request).
 *
 * @param {object} [config]
 * @param {string} [config.locale='en']                       Initial locale.
 * @param {string|string[]} [config.fallback]                 Fallback chain.
 * @param {'key'|'warn'|'throw'} [config.missingKeyPolicy='key']
 * @param {(key:string, locale:string)=>string|void} [config.onMissingKey]
 * @param {Record<string, object>} [config.messages]          Locale -> dict map.
 */
export function createI18n(config) {
    const cfg = config || EMPTY_PARAMS;

    const _locale = signal(cfg.locale || "en");
    const _epoch  = signal(0);
    const _dicts = new Map();                    // locale -> Map<key, compiledFn>
    const _pluralRules = new Map();              // locale -> Intl.PluralRules (cardinal)
    const _ordinalRules = new Map();             // locale -> Intl.PluralRules (ordinal)
    const _readySignals = new Map();             // locale -> signal<bool>
    const _loadPromises = new Map();             // locale -> Promise<void>
    const _supersededLoads = new Set();          // locale -> an explicit define cancelled this in-flight load (I-05)
    const _fallback = [];
    let _missingKeyPolicy = cfg.missingKeyPolicy || "key";
    let _onMissingKey = cfg.onMissingKey || null;
    let _retiredLocales = 0;                      // cumulative unloadLocale removals
    let _warnCount = 0;                           // invalid-locale warnings emitted (I-19)
    let _warningsSuppressed = 0;                  // invalid-locale warnings silenced past WARN_BUDGET

    if (cfg.fallback) {
        if (typeof cfg.fallback === "string") _fallback.push(cfg.fallback);
        else for (let i = 0; i < cfg.fallback.length; i++) _fallback.push(cfg.fallback[i]);
    }

    function bumpEpoch() {
        _epoch.update(function (n) { return (n + 1) | 0; });
    }

    // HOT PATH: the first three lines (get + return-on-hit) are the read path a
    // plural/selectordinal render calls on every frame. Everything below `if (r)
    // return r;` is the cache-MISS branch only -- the bound (I-04) and the warn
    // budget (I-19) add ZERO instructions to the hit path. A miss already
    // constructs an ICU-backed Intl object, so the eviction it triggers is
    // cheap by comparison. Eviction is FIFO (oldest inserted), NOT LRU: LRU
    // needs recency bookkeeping on every hit, which is exactly the hot path we
    // may not touch. Entries are pure memos of (locale, type) -- reconstructing
    // any evicted one renders byte-identically -- so WHICH one is evicted is
    // observationally irrelevant (decisions/0003-locale-bounds.md, proved by
    // the eviction-equivalence test).
    function getRules(loc, ordinal) {
        const cache = ordinal ? _ordinalRules : _pluralRules;
        let r = cache.get(loc);
        if (r) return r;
        try {
            r = ordinal
                ? new Intl.PluralRules(loc, { type: "ordinal" })
                : new Intl.PluralRules(loc);
        } catch (err) {
            // Warn budget (I-19): warn-once-per-tag is a log-flood surface when
            // the tag is untrusted (Accept-Language). Cap the warnings per
            // instance and count the rest -- rate-limit on a fixed budget, not
            // on the varied input.
            if (_warnCount < WARN_BUDGET) {
                _warnCount = (_warnCount + 1) | 0;
                if (typeof console !== "undefined" && console.warn) {
                    console.warn(
                        `[lite-i18n] Intl.PluralRules("${loc}"${ordinal ? ", ordinal" : ""}) threw ${err.name}: ${err.message}. ` +
                        `Falling back to the environment default. Check the locale tag.`
                    );
                }
            } else {
                _warningsSuppressed = (_warningsSuppressed + 1) | 0;
            }
            r = ordinal
                ? new Intl.PluralRules(undefined, { type: "ordinal" })
                : new Intl.PluralRules();
        }
        // Bound (I-04): evict the oldest-inserted entry before growing past the
        // ceiling. Map iteration is insertion order, so keys().next() is the
        // FIFO victim. No throw -- reconstructing is identical, so a throw would
        // convert a leak into an outage for the 1025th visitor locale.
        if (cache.size >= LOCALE_CACHE_MAX) {
            cache.delete(cache.keys().next().value);
        }
        cache.set(loc, r);
        return r;
    }

    function internalDefine(loc, dict) {
        // Compile into a staging Map first so a bad template can't leave a
        // partial update. Prior behaviour: { good, bad, alsoGood } with a
        // SyntaxError in `bad` would leave `good` live and `alsoGood` missing.
        const staging = new Map();
        flattenInto(dict, "", staging);
        // Commit.
        let bucket = _dicts.get(loc);
        if (!bucket) {
            bucket = new Map();
            _dicts.set(loc, bucket);
        }
        for (const [k, v] of staging) bucket.set(k, v);
        // Flip ready signal if one was registered.
        const rs = _readySignals.get(loc);
        if (rs && !rs.peek()) rs.set(true);
        // Bump epoch only if this locale can affect current resolution.
        if (localeAffectsResolution(loc)) bumpEpoch();
    }

    function defineMessages(loc, dict) {
        if (typeof loc !== "string") throw new TypeError("defineMessages: locale must be a string");
        if (!dict || typeof dict !== "object") throw new TypeError("defineMessages: dict must be an object");
        // I-05 (v1.2.1): an explicit defineMessages is the synchronous, intentional
        // writer -- it WINS over any load already in flight for this locale. Mark
        // the load superseded AFTER internalDefine commits (a bad template throws
        // and must NOT cancel the load). The load's success handler then discards
        // its result with a named warn, and its promise resolves rather than
        // rejects. Ordering is decided; see decisions/0006-load-define-race.md.
        const hadLoad = _loadPromises.has(loc);
        internalDefine(loc, dict);
        if (hadLoad) _supersededLoads.add(loc);
    }

    function lookup(key, loc) {
        const primary = _dicts.get(loc);
        if (primary) {
            const e = primary.get(key);
            if (e !== undefined) return e;
        }
        const fbLen = _fallback.length;
        for (let i = 0; i < fbLen; i++) {
            const fb = _fallback[i];
            if (fb === loc) continue;
            const d = _dicts.get(fb);
            if (d) {
                const e = d.get(key);
                if (e !== undefined) return e;
            }
        }
        return undefined;
    }

    function handleMissing(key, loc) {
        if (_onMissingKey) {
            const r = _onMissingKey(key, loc);
            if (typeof r === "string") return r;
        }
        const policy = _missingKeyPolicy;
        if (policy === "throw") throw new MissingKeyError(key, loc);
        if (policy === "warn" && typeof console !== "undefined" && console.warn) {
            console.warn(`[lite-i18n] Missing key "${key}" for locale "${loc}"`);
        }
        return key;
    }

    function t(key, params) {
        const loc = _locale();                   // subscribe + read
        _epoch();                                // subscribe (defineMessages / setFallback)
        const entry = lookup(key, loc);
        if (entry !== undefined) return entry(params, loc, getRules);
        return handleMissing(key, loc);
    }

    function plural(key, count, params) {
        const loc = _locale();
        _epoch();
        const entry = lookup(key, loc);
        if (entry === undefined) return handleMissing(key, loc);
        // Merge count into params under the template's plural variable name.
        // compileString/compilePluralObj tag each entry with .pluralVar; when
        // absent (static template, or ambiguous multi-plural template), fall
        // back to "count" -- harmless when the template doesn't reference it.
        // One small alloc per call is acceptable; for hot-path use include
        // the variable in params yourself and call t(key, params) directly.
        const varName = entry.pluralVar || "count";
        const p = params ? { ...params, [varName]: count } : { [varName]: count };
        return entry(p, loc, getRules);
    }

    function setFallback(f) {
        _fallback.length = 0;
        if (typeof f === "string") _fallback.push(f);
        else if (Array.isArray(f)) for (let i = 0; i < f.length; i++) _fallback.push(f[i]);
        bumpEpoch();
    }

    function setMissingKeyPolicy(p) {
        if (p !== "key" && p !== "warn" && p !== "throw") {
            throw new TypeError(`setMissingKeyPolicy: unknown policy "${p}"`);
        }
        _missingKeyPolicy = p;
    }

    function setOnMissingKey(fn) {
        if (fn !== null && typeof fn !== "function") {
            throw new TypeError("onMissingKey: expected function or null");
        }
        _onMissingKey = fn;
    }

    function ready(loc) {
        let sig = _readySignals.get(loc);
        if (sig) return sig;
        // Fail CLOSED (not evict): a readiness signal carries subscriber
        // identity, so silently evicting one orphans a live effect. Throw a
        // NAMED package error with a per-instance blast radius instead of
        // letting lite-signal's shared pool throw CapacityError process-wide.
        if (_readySignals.size >= LOCALE_CACHE_MAX) {
            throw new LocaleCapacityError(loc, LOCALE_CACHE_MAX);
        }
        sig = signal(_dicts.has(loc));
        _readySignals.set(loc, sig);
        return sig;
    }

    function localeAffectsResolution(loc) {
        if (loc === _locale.peek()) return true;
        for (let i = 0; i < _fallback.length; i++) {
            if (_fallback[i] === loc) return true;
        }
        return false;
    }

    // I-12 eviction. Drop the compiled dict, both rules memos, and the ready
    // signal for `loc`. Order is deliberate: the signal is removed from the map
    // FIRST and only then set false. A subscriber still holds the reference, so
    // it observes the true->false transition either way -- but dropping first
    // means a re-entrant ready() fired from inside that notification re-mints a
    // fresh signal instead of receiving the one being retired.
    // Unloading the ACTIVE (or a fallback) locale is PERMITTED:
    // resolution falls through to the fallback chain and the epoch bumps so
    // every observer re-renders. Returns true iff a dict was actually removed.
    function unloadLocale(loc) {
        if (typeof loc !== "string") throw new TypeError("unloadLocale: locale must be a string");
        const affects = localeAffectsResolution(loc);
        const hadDict = _dicts.delete(loc);
        _pluralRules.delete(loc);
        _ordinalRules.delete(loc);
        const rs = _readySignals.get(loc);
        if (rs) {
            _readySignals.delete(loc);
            if (rs.peek()) rs.set(false);
        }
        if (hadDict) _retiredLocales = (_retiredLocales + 1) | 0;
        if (affects) bumpEpoch();
        return hadDict;
    }

    // I-12 reset. Release every defined message, compiled entry, cached Intl
    // rule, readiness signal and in-flight load, and zero the I-19 counters --
    // WITHOUT reallocating the instance or touching the locale/fallback/policy
    // configuration (use locale.set / setFallback for those). Bumps the epoch so
    // every observer re-renders against the empty dictionary.
    function clear() {
        _dicts.clear();
        _pluralRules.clear();
        _ordinalRules.clear();
        _loadPromises.clear();
        _supersededLoads.clear();
        for (const [, rs] of _readySignals) {
            if (rs.peek()) rs.set(false);
        }
        _readySignals.clear();
        _retiredLocales = 0;
        _warnCount = 0;
        _warningsSuppressed = 0;
        bumpEpoch();
    }

    function loadLocale(loc, loaderFn) {
        // Already loaded -> resolve immediately.
        if (_dicts.has(loc)) {
            const rs = _readySignals.get(loc);
            if (rs && !rs.peek()) rs.set(true);
            return Promise.resolve();
        }
        // Load in flight -> return the shared promise.
        const inflight = _loadPromises.get(loc);
        if (inflight) return inflight;
        // A fresh load is never superseded by a PAST define (the marks and the
        // promises are cleared together, so this is defensive, not load-bearing).
        _supersededLoads.delete(loc);
        // Defer the loader invocation. A sync throw inside loaderFn would
        // otherwise run the catch BEFORE _loadPromises.set below, meaning
        // the delete cleanup hits an empty map and the rejected promise then
        // gets cached permanently -- unrecoverable retry state.
        //
        // Promise.resolve().then(loaderFn) routes both sync throws and async
        // rejections through the .then reject handler, which runs on a
        // microtask, well after .set.
        const p = Promise.resolve().then(loaderFn).then(
            function (dict) {
                if (!dict || typeof dict !== "object") {
                    _loadPromises.delete(loc);
                    _supersededLoads.delete(loc);
                    throw new TypeError(`loadLocale("${loc}"): loader must return an object`);
                }
                // I-05: a defineMessages for this locale landed while the load was
                // in flight. The intentional writer already won -- discard the
                // load result (do NOT internalDefine), make the LOSING writer
                // observable, and RESOLVE (the caller asked to load; the locale is
                // loaded, just not from here).
                if (_supersededLoads.has(loc)) {
                    _supersededLoads.delete(loc);
                    _loadPromises.delete(loc);
                    if (typeof console !== "undefined" && console.warn) {
                        console.warn(
                            `[lite-i18n] loadLocale("${loc}"): result discarded -- a ` +
                            `defineMessages("${loc}") superseded this load while it was ` +
                            `in flight. The synchronous define wins.`);
                    }
                    return;
                }
                internalDefine(loc, dict);
                // Clear on success: _dicts.has(loc) fast-path covers dedup
                // for settled loads, so retaining the promise just leaks.
                _loadPromises.delete(loc);
            },
            function (err) {
                _loadPromises.delete(loc);
                _supersededLoads.delete(loc);
                throw err;
            }
        );
        _loadPromises.set(loc, p);
        return p;
    }

    function stats() {
        let keys = 0;
        for (const [, d] of _dicts) keys += d.size;
        return {
            locales: _dicts.size,
            keys,
            currentLocale: _locale.peek(),
            fallback: _fallback.slice(),
            pluralRulesCached: _pluralRules.size,
            ordinalRulesCached: _ordinalRules.size,
            readySignalsCached: _readySignals.size,
            retiredLocales: _retiredLocales,
            warningsSuppressed: _warningsSuppressed,
            loadsInFlight: _loadPromises.size,
        };
    }

    // Pre-load dictionaries passed via config -- runs after internalDefine is
    // in scope. Doesn't fire the epoch spuriously: the epoch signal starts at
    // 0 and no observer can have subscribed yet at construction time.
    if (cfg.messages) {
        for (const loc in cfg.messages) {
            internalDefine(loc, cfg.messages[loc]);
        }
    }

    // Public surface. Underscore-prefixed members are intentionally reachable
    // for Format.js and lite-devtools -- they are not covered by the semver
    // contract on named public API.
    return {
        locale: _locale,
        t,
        plural,
        defineMessages,
        loadLocale,
        ready,
        unloadLocale,
        clear,
        setFallback,
        setMissingKeyPolicy,
        onMissingKey: setOnMissingKey,
        stats,
        // Internal:
        _epoch,
        _getRules: getRules,
    };
}

// ---------- Default instance + top-level routing ----------

let _defaultI18n = createI18n();

// ESM live binding: `locale` is re-exported as `let` and reassigned when the
// default instance is swapped. Consumers who `import { locale }` see the new
// signal on their next reference. Consumers who destructure (`const { locale }
// = ...`) or `.peek/.set` capture the old signal -- swap default before use.
export let locale = _defaultI18n.locale;

/** Swap the instance used by top-level helpers. Useful for tests and SSR. */
export function setDefaultI18n(inst) {
    if (!inst || typeof inst.t !== "function") {
        throw new TypeError("setDefaultI18n: expected an i18n instance");
    }
    _defaultI18n = inst;
    locale = inst.locale;
}

/** Read the current default instance (used by Format.js). */
export function getDefaultI18n() {
    return _defaultI18n;
}

// Top-level API mirrors createI18n's surface, routed to the default instance.
// These re-route on every call so `setDefaultI18n` takes effect immediately.

export function t(key, params) { return _defaultI18n.t(key, params); }
export function plural(key, count, params) { return _defaultI18n.plural(key, count, params); }
export function defineMessages(loc, dict) { return _defaultI18n.defineMessages(loc, dict); }
export function loadLocale(loc, loaderFn) { return _defaultI18n.loadLocale(loc, loaderFn); }
export function ready(loc) { return _defaultI18n.ready(loc); }
export function unloadLocale(loc) { return _defaultI18n.unloadLocale(loc); }
export function clear() { return _defaultI18n.clear(); }
export function setFallback(f) { return _defaultI18n.setFallback(f); }
export function setMissingKeyPolicy(p) { return _defaultI18n.setMissingKeyPolicy(p); }
export function onMissingKey(fn) { return _defaultI18n.onMissingKey(fn); }
export function stats() { return _defaultI18n.stats(); }
