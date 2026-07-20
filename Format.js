// @zakkster/lite-i18n/format
// Reactive Intl formatters. Each formatter subscribes to its instance's
// `locale` signal, so effects re-run automatically when the locale switches.
//
// Two shapes per formatter:
//
//   1. Convenience: `formatNumber(value, opts?, i18n?)`. Uses a WeakMap keyed
//      on the opts object -> Map<locale, Intl.Formatter>. Zero-alloc when the
//      caller hoists opts to a module-level const (the recommended pattern);
//      otherwise a fresh Intl instance is built per unique opts identity, and
//      the whole bucket becomes GC-eligible when that opts object dies.
//
//   2. Factory: `numberFormat(opts?, i18n?)` returns a reactive `(value) =>
//      string` function that closes over its own per-locale cache. Zero-alloc
//      steady state -- the canonical hot-path form.
//
// Both forms accept an optional trailing `i18n` argument to bind against a
// specific instance from `createI18n(...)`.

import { getDefaultI18n } from "./I18n.js";

/** Build a per-formatter-type cache: WeakMap(opts) -> Map<locale, Intl.Formatter>,
 *  plus a shared bucket for the undefined-opts case.
 *
 *  Growth note: buckets retain one Intl instance per unique locale seen for
 *  the process lifetime. Fine for a bounded locale set (the common case: a
 *  handful of supported locales). If your process feeds arbitrary
 *  locale strings (per-user overrides, request-scoped BCP-47 tags) into the
 *  same factory, this grows without bound -- prefer per-request createI18n
 *  instances so the caches die with the request. */
function makeCache(IntlCtor) {
    const optsBuckets = new WeakMap();
    const noOptsBucket = new Map();
    return function get(opts, locale) {
        if (opts === undefined || opts === null) {
            let f = noOptsBucket.get(locale);
            if (f === undefined) {
                f = new IntlCtor(locale);
                noOptsBucket.set(locale, f);
            }
            return f;
        }
        let bucket = optsBuckets.get(opts);
        if (bucket === undefined) {
            bucket = new Map();
            optsBuckets.set(opts, bucket);
        }
        let f = bucket.get(locale);
        if (f === undefined) {
            f = new IntlCtor(locale, opts);
            bucket.set(locale, f);
        }
        return f;
    };
}

// Some environments (older Node, embedded runtimes, restricted browsers) may
// ship a partial Intl. Instead of capturing an undefined constructor and
// failing with "IntlCtor is not a constructor" at first use, wrap the
// getters so first use throws a named, actionable error.
function makeGuardedCache(ctor, name) {
    if (typeof ctor === "function") return makeCache(ctor);
    return function () {
        throw new Error(
            `[lite-i18n] ${name} is not available in this environment. ` +
            `${name} is part of the Intl object; if you're targeting older ` +
            `Node/browsers, polyfill it (e.g. @formatjs/intl-listformat or ` +
            `@formatjs/intl-relativetimeformat) before importing this entry.`
        );
    };
}

const getNumber       = makeGuardedCache(Intl.NumberFormat,       "Intl.NumberFormat");
const getDate         = makeGuardedCache(Intl.DateTimeFormat,     "Intl.DateTimeFormat");
const getList         = makeGuardedCache(Intl.ListFormat,         "Intl.ListFormat");
const getRelativeTime = makeGuardedCache(Intl.RelativeTimeFormat, "Intl.RelativeTimeFormat");

// ---------- Convenience form ----------

/** @param {number|bigint} value @param {Intl.NumberFormatOptions} [opts] @param {object} [i18n] */
export function formatNumber(value, opts, i18n) {
    const inst = i18n || getDefaultI18n();
    const loc = inst.locale();
    return getNumber(opts, loc).format(value);
}

/** @param {Date|number} value @param {Intl.DateTimeFormatOptions} [opts] @param {object} [i18n] */
export function formatDate(value, opts, i18n) {
    const inst = i18n || getDefaultI18n();
    const loc = inst.locale();
    return getDate(opts, loc).format(value);
}

/** @param {Iterable<string>} items @param {Intl.ListFormatOptions} [opts] @param {object} [i18n] */
export function formatList(items, opts, i18n) {
    const inst = i18n || getDefaultI18n();
    const loc = inst.locale();
    return getList(opts, loc).format(items);
}

/** @param {number} value @param {Intl.RelativeTimeFormatUnit} unit
 *  @param {Intl.RelativeTimeFormatOptions} [opts] @param {object} [i18n] */
export function formatRelativeTime(value, unit, opts, i18n) {
    const inst = i18n || getDefaultI18n();
    const loc = inst.locale();
    return getRelativeTime(opts, loc).format(value, unit);
}

// ---------- Factory form (zero-alloc steady state) ----------
//
// Each factory closes over a per-locale cache local to the returned fn. No
// WeakMap lookup on the hot path -- direct Map.get(locale). The locale read
// still subscribes the caller's effect so re-runs propagate on switch.

export function numberFormat(opts, i18n) {
    const inst = i18n || getDefaultI18n();
    const locSig = inst.locale;
    const cache = new Map();                     // locale -> Intl.NumberFormat
    return function (value) {
        const loc = locSig();
        let f = cache.get(loc);
        if (f === undefined) {
            f = opts ? new Intl.NumberFormat(loc, opts) : new Intl.NumberFormat(loc);
            cache.set(loc, f);
        }
        return f.format(value);
    };
}

export function dateFormat(opts, i18n) {
    const inst = i18n || getDefaultI18n();
    const locSig = inst.locale;
    const cache = new Map();
    return function (value) {
        const loc = locSig();
        let f = cache.get(loc);
        if (f === undefined) {
            f = opts ? new Intl.DateTimeFormat(loc, opts) : new Intl.DateTimeFormat(loc);
            cache.set(loc, f);
        }
        return f.format(value);
    };
}

export function listFormat(opts, i18n) {
    const inst = i18n || getDefaultI18n();
    const locSig = inst.locale;
    const cache = new Map();
    return function (items) {
        const loc = locSig();
        let f = cache.get(loc);
        if (f === undefined) {
            f = opts ? new Intl.ListFormat(loc, opts) : new Intl.ListFormat(loc);
            cache.set(loc, f);
        }
        return f.format(items);
    };
}

export function relativeTimeFormat(opts, i18n) {
    const inst = i18n || getDefaultI18n();
    const locSig = inst.locale;
    const cache = new Map();
    return function (value, unit) {
        const loc = locSig();
        let f = cache.get(loc);
        if (f === undefined) {
            f = opts ? new Intl.RelativeTimeFormat(loc, opts) : new Intl.RelativeTimeFormat(loc);
            cache.set(loc, f);
        }
        return f.format(value, unit);
    };
}

// ---------- Bulk binder ----------

/** Return an object of all four formatters bound to a specific i18n instance.
 *  Convenience when you're threading a non-default instance through a component tree. */
export function createFormatters(i18n) {
    return {
        formatNumber: (v, opts) => formatNumber(v, opts, i18n),
        formatDate:   (v, opts) => formatDate(v, opts, i18n),
        formatList:   (items, opts) => formatList(items, opts, i18n),
        formatRelativeTime: (v, unit, opts) => formatRelativeTime(v, unit, opts, i18n),
        numberFormat: (opts) => numberFormat(opts, i18n),
        dateFormat:   (opts) => dateFormat(opts, i18n),
        listFormat:   (opts) => listFormat(opts, i18n),
        relativeTimeFormat: (opts) => relativeTimeFormat(opts, i18n),
    };
}
