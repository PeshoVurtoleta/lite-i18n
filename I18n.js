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

// ---------- Token types ----------
// 0: literal string
// 1: {key} interpolation slot
// 2: {var, plural, ...} inline plural block
// Sub-templates inside plural variants use only types 0 and 1; the ICU '#'
// shortcut compiles to {type: 1, key: <plural variable>}.

const CLDR_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);
const EXACT_RE = /^=(\d+)$/;

// ---------- Errors ----------
export class MissingKeyError extends Error {
    constructor(key, locale) {
        super(`Missing translation key "${key}" for locale "${locale}"`);
        this.name = "MissingKeyError";
        this.key = key;
        this.locale = locale;
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

/** Tokenize a top-level message template.
 *
 *  ICU quoted-string escape mode:
 *    '{ ... '        -- content between apostrophes is literal
 *    '} ... '        -- same, opens on '} too
 *    '{'             -- three chars: opens quote, {, closes quote  -> literal '{'
 *    '{name}'        -- literal '{name}' (whole slot escaped)
 *    ''              -- literal apostrophe
 *  Any apostrophe NOT followed by { } or ' is a literal apostrophe. */
function tokenizeMessage(template) {
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
            const pm = /^\s*(\w+)\s*,\s*plural\s*,\s*([\s\S]+)$/.exec(inner);
            if (pm) {
                tokens.push(compilePluralToken(pm[1], pm[2]));
            } else {
                const key = inner.trim();
                // A slot key is a bare identifier. If the inner contains a
                // comma, this is a full-ICU construct (select, number, date,
                // etc.) that lite-i18n does not implement -- fail loudly at
                // compile time instead of silently rendering "".
                if (key.indexOf(",") !== -1) {
                    throw new SyntaxError(
                        `Unsupported ICU argument "{${inner}}". lite-i18n supports {slot} and {var, plural, ...}. ` +
                        `For number/date/list/relative-time formatting use the Format entry (formatNumber, formatDate, ...).`
                    );
                }
                tokens.push({ type: 1, key });
            }
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
function tokenizeSub(template, pluralVariable) {
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
            const key = template.slice(i + 1, close).trim();
            if (key.indexOf(",") !== -1) {
                throw new SyntaxError(
                    `Unsupported ICU argument "{${key}}" inside plural sub-template. ` +
                    `lite-i18n supports {slot}; nested plurals and inline select/number/date are not implemented.`
                );
            }
            tokens.push({ type: 1, key });
            i = close + 1;
            continue;
        }
        literal += template[i];
        i++;
    }
    if (literal) tokens.push({ type: 0, str: literal });
    return tokens;
}

/** Compile an inline plural block: `variable {selector {sub} selector {sub} ...}`. */
function compilePluralToken(variable, body) {
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
                if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) {
                    sel += body[i];
                    i++;
                } else break;
            }
        }
        if (!sel) throw new SyntaxError(`Expected plural selector at position ${i} in: ${body}`);
        while (i < len && body.charCodeAt(i) <= 32) i++;
        if (body.charCodeAt(i) !== 123) {
            throw new SyntaxError(`Expected '{' after plural selector "${sel}"`);
        }
        const close = findMatchingBrace(body, i);
        const subTokens = tokenizeSub(body.slice(i + 1, close), variable);
        const em = EXACT_RE.exec(sel);
        if (em) {
            exact.set(+em[1], subTokens);
        } else if (CLDR_KEYS.has(sel)) {
            variants.set(sel, subTokens);
        } else {
            throw new SyntaxError(
                `Unknown plural selector "${sel}" in {${variable}, plural, ...}. ` +
                `Valid selectors: zero, one, two, few, many, other, or =N.`
            );
        }
        i = close + 1;
    }
    if (!variants.has("other")) {
        throw new SyntaxError(`Plural block for "${variable}" missing required "other" variant`);
    }
    return { type: 2, variable, exact, variants };
}

// ---------- Renderer ----------

// The plural rules cache lives on the instance -- this renderer receives the
// instance-scoped getter so different instances don't cross-pollute caches.
//
// Slot rendering coalesces nullish values (undefined, null) to "" via ??.
// It also rejects prototype-chain reads via Object.hasOwn so a slot named
// {constructor} or {__proto__} can't leak Object.prototype internals into
// the output. Both checks are one well-predicted branch per slot.
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
        } else {
            const nVal = params[t.variable];
            const ex = t.exact.get(nVal);
            if (ex !== undefined) {
                out += renderTokens(ex, params, locale, getRules);
            } else {
                const rules = getRules(locale);
                const sel = rules.select(nVal);
                const variant = t.variants.get(sel) || t.variants.get("other");
                out += renderTokens(variant, params, locale, getRules);
            }
        }
    }
    return out;
}

// ---------- Compilation ----------

// A compiled entry is always a function (params, locale) => string. We route
// static strings through a closure too so the lookup site has a monomorphic
// call shape.

function compileString(template) {
    // Pure literal fast-path. Skip only when the template has none of the
    // characters that could introduce syntax: '{' opens slots/plurals, '#'
    // is the plural shorthand, and "'" may open an ICU quoted section.
    if (template.indexOf("{") === -1 &&
        template.indexOf("#") === -1 &&
        template.indexOf("'") === -1) {
        return function () { return template; };
    }
    const tokens = tokenizeMessage(template);
    // If tokenizer collapsed to a single literal, specialize.
    if (tokens.length === 1 && tokens[0].type === 0) {
        const s = tokens[0].str;
        return function () { return s; };
    }
    return function (params, locale, getRules) {
        return renderTokens(tokens, params || EMPTY_PARAMS, locale, getRules);
    };
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
function compilePluralObj(obj) {
    const exact = new Map();
    const variants = new Map();
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = obj[k];
        // isPluralObj already guarantees string values, but assert defensively --
        // this is the last line between a bad shape and a runtime TypeError.
        if (typeof v !== "string") continue;
        const sub = tokenizeSub(v, "count");
        const em = EXACT_RE.exec(k);
        if (em) exact.set(+em[1], sub);
        else variants.set(k, sub);
    }
    if (!variants.has("other")) {
        throw new SyntaxError(`Plural-object entry missing required "other" variant`);
    }
    return function (params, locale, getRules) {
        const p = params || EMPTY_PARAMS;
        const nVal = p.count;
        const ex = exact.get(nVal);
        if (ex !== undefined) return renderTokens(ex, p, locale, getRules);
        const rules = getRules(locale);
        const sel = rules.select(nVal);
        const variant = variants.get(sel) || variants.get("other");
        return renderTokens(variant, p, locale, getRules);
    };
}

const EMPTY_PARAMS = Object.freeze({});

/** Flatten a nested dict into a Map<dot.path, compiledEntry>. */
function flattenInto(dict, prefix, out) {
    const keys = Object.keys(dict);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = dict[k];
        const path = prefix ? prefix + "." + k : k;
        if (typeof v === "string") {
            out.set(path, compileString(v));
        } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            if (isPluralObj(v)) {
                out.set(path, compilePluralObj(v));
            } else {
                flattenInto(v, path, out);
            }
        }
        // Everything else (numbers, arrays, null, undefined) is skipped silently.
    }
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
    const _pluralRules = new Map();              // locale -> Intl.PluralRules
    const _readySignals = new Map();             // locale -> signal<bool>
    const _loadPromises = new Map();             // locale -> Promise<void>
    const _fallback = [];
    let _missingKeyPolicy = cfg.missingKeyPolicy || "key";
    let _onMissingKey = cfg.onMissingKey || null;

    if (cfg.fallback) {
        if (typeof cfg.fallback === "string") _fallback.push(cfg.fallback);
        else for (let i = 0; i < cfg.fallback.length; i++) _fallback.push(cfg.fallback[i]);
    }

    function bumpEpoch() {
        _epoch.update(function (n) { return (n + 1) | 0; });
    }

    function getPluralRules(loc) {
        let r = _pluralRules.get(loc);
        if (r) return r;
        try {
            r = new Intl.PluralRules(loc);
        } catch (err) {
            // Warn ONCE per bad locale -- the cache below stops repeated
            // constructor attempts, so this is naturally rate-limited.
            if (typeof console !== "undefined" && console.warn) {
                console.warn(
                    `[lite-i18n] Intl.PluralRules("${loc}") threw ${err.name}: ${err.message}. ` +
                    `Falling back to the environment default. Check the locale tag.`
                );
            }
            r = new Intl.PluralRules();
        }
        _pluralRules.set(loc, r);
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
        const active = _locale.peek();
        if (loc === active) {
            bumpEpoch();
            return;
        }
        for (let i = 0; i < _fallback.length; i++) {
            if (_fallback[i] === loc) { bumpEpoch(); return; }
        }
    }

    function defineMessages(loc, dict) {
        if (typeof loc !== "string") throw new TypeError("defineMessages: locale must be a string");
        if (!dict || typeof dict !== "object") throw new TypeError("defineMessages: dict must be an object");
        internalDefine(loc, dict);
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
        if (entry !== undefined) return entry(params, loc, getPluralRules);
        return handleMissing(key, loc);
    }

    function plural(key, count, params) {
        const loc = _locale();
        _epoch();
        const entry = lookup(key, loc);
        if (entry === undefined) return handleMissing(key, loc);
        // Merge count into params without mutating the caller's object.
        // One small alloc per call is acceptable here -- for hot-path use
        // include `count` in params yourself and call t(key, params) directly.
        const p = params ? { ...params, count } : { count };
        return entry(p, loc, getPluralRules);
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
        sig = signal(_dicts.has(loc));
        _readySignals.set(loc, sig);
        return sig;
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
                    throw new TypeError(`loadLocale("${loc}"): loader must return an object`);
                }
                internalDefine(loc, dict);
                // Clear on success: _dicts.has(loc) fast-path covers dedup
                // for settled loads, so retaining the promise just leaks.
                _loadPromises.delete(loc);
            },
            function (err) {
                _loadPromises.delete(loc);
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
        setFallback,
        setMissingKeyPolicy,
        onMissingKey: setOnMissingKey,
        stats,
        // Internal:
        _epoch,
        _getPluralRules: getPluralRules,
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
export function setFallback(f) { return _defaultI18n.setFallback(f); }
export function setMissingKeyPolicy(p) { return _defaultI18n.setMissingKeyPolicy(p); }
export function onMissingKey(fn) { return _defaultI18n.onMissingKey(fn); }
export function stats() { return _defaultI18n.stats(); }
