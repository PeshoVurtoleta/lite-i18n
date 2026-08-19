// @zakkster/lite-i18n
// Zero-GC reactive internationalization built on @zakkster/lite-signal.

import type { Signal } from "@zakkster/lite-signal";

/** CLDR plural category. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/** Missing-key policy. Fallback chain is walked regardless of this setting. */
export type MissingKeyPolicy = "key" | "warn" | "throw";

/** A dict value can be a template string, a plural-object entry, or a nested dict. */
export type MessageValue = string | PluralObject | MessageDict;

export interface PluralObject {
    zero?: string;
    one?: string;
    two?: string;
    few?: string;
    many?: string;
    other: string;
    /** Exact-match variants: `=0`, `=1`, etc. */
    [exact: `=${number}`]: string;
}

export interface MessageDict {
    [key: string]: MessageValue;
}

/**
 * Parameters passed to `t` and `plural`. Values are stringified on splice.
 *
 * `bigint` is accepted (I-08, v1.2.1). It renders in a `{slot}` (stringified)
 * and, reaching a plural/selectordinal variable, is normalized via `Number()`
 * before `Intl.PluralRules.select` so `count: 2n` renders like `count: 2` and
 * never throws out of Intl. This reverses the I-17 (v1.1.4) narrowing, which was
 * blocked on the `=N`-vs-category string-count asymmetry that I-08 resolved:
 * numeric strings normalize too (`'1'` matches `=1` like `1`), while `null`,
 * `undefined` and `''` stay in the `other` path -- `null` is not zero.
 */
export type MessageParams = Record<string, string | number | boolean | bigint>;

export interface I18nConfig {
    /** Initial locale. Default `"en"`. */
    locale?: string;
    /** Fallback locale or chain, walked when a key is missing in the current locale. */
    fallback?: string | string[];
    /** How to handle a key that resolves nowhere. Default `"key"` (return the key literal). */
    missingKeyPolicy?: MissingKeyPolicy;
    /** Optional hook -- return a string to override the default missing-key result. */
    onMissingKey?: (key: string, locale: string) => string | void;
    /** Locale-keyed dictionaries. Equivalent to calling `defineMessages` for each. */
    messages?: Record<string, MessageDict>;
}

export interface I18nStats {
    /** Number of locales with at least one registered dict. */
    locales: number;
    /** Total compiled entries across all locales. */
    keys: number;
    /** Current active locale (untracked read). */
    currentLocale: string;
    /** Fallback chain snapshot. */
    fallback: string[];
    /** Number of Intl.PluralRules instances cached. Bounded by `LOCALE_CACHE_MAX` (FIFO eviction). */
    pluralRulesCached: number;
    /** Number of Intl.PluralRules ordinal instances cached (selectordinal). Bounded by `LOCALE_CACHE_MAX`. */
    ordinalRulesCached: number;
    /** Number of readiness signals cached. Bounded by `LOCALE_CACHE_MAX` (fails closed, throws `LocaleCapacityError`). */
    readySignalsCached: number;
    /** Cumulative count of locales removed via `unloadLocale`. Reset to 0 by `clear`. */
    retiredLocales: number;
    /** Invalid-locale warnings silenced past the per-instance budget (I-19). Reset to 0 by `clear`. */
    warningsSuppressed: number;
    /** Number of `loadLocale` calls currently in flight. */
    loadsInFlight: number;
}

/** An i18n instance created via `createI18n`. Instances share no state. */
export interface I18n {
    /** Current locale as a lite-signal. Read reactively via `locale()`, mutate via `locale.set(...)`. */
    readonly locale: Signal<string>;

    /**
     * Reactive translation lookup. Subscribes to the current locale AND the
     * messages epoch, so callers inside effects/computeds re-run when either
     * changes.
     *
     * The compiled entry runs a stable token loop; the only allocation per
     * call is the returned string.
     */
    t(key: string, params?: MessageParams): string;

    /**
     * Convenience wrapper around `t` for plural-object dict entries. Merges
     * `{ count }` into `params` and delegates. For hot loops, prefer
     * `t(key, params)` with `count` already in `params`.
     */
    plural(key: string, count: number, params?: MessageParams): string;

    /** Register (or extend) the dictionary for a locale. Idempotent, cumulative. */
    defineMessages(locale: string, dict: MessageDict): void;

    /**
     * Load a locale dictionary via a user-provided loader. Race-safe: repeat
     * calls for an in-flight locale share the same promise; already-loaded
     * locales resolve immediately. On success `defineMessages` runs and the
     * `ready(locale)` signal flips to `true`.
     */
    loadLocale(locale: string, loaderFn: () => Promise<MessageDict>): Promise<void>;

    /**
     * Reactive readiness signal for a locale. `true` once the dict is registered.
     * Distinct, stable signal identity per locale. Fails closed: throws
     * `LocaleCapacityError` once `LOCALE_CACHE_MAX` distinct locales have been
     * queried -- bound your locale set with `resolveLocale` first.
     */
    ready(locale: string): Signal<boolean>;

    /**
     * Release the compiled dict, both Intl-rules memos and the readiness signal
     * for a locale (the signal is removed from the cache, THEN set `false`, so a
     * subscriber still holding the reference observes the transition while a
     * re-entrant `ready()` fired from inside that notification re-mints a fresh
     * signal). Unloading the active/fallback locale is permitted: resolution
     * falls through the fallback chain and the epoch bumps so every observer
     * re-renders. Returns `true` iff a dict was removed.
     */
    unloadLocale(locale: string): boolean;

    /**
     * Reset the instance to empty: release every dict, compiled entry, cached
     * Intl rule, readiness signal and in-flight load, and zero the retired/
     * suppressed counters. Does NOT change the active locale, fallback chain or
     * missing-key policy. Bumps the epoch so every observer re-renders.
     */
    clear(): void;

    /** Replace the fallback chain. Bumps the reactivity epoch. */
    setFallback(fallback: string | string[]): void;

    /** Update the missing-key policy at runtime. Does not bump the epoch. */
    setMissingKeyPolicy(policy: MissingKeyPolicy): void;

    /** Register (or clear with `null`) a hook that runs before the missing-key policy. */
    onMissingKey(fn: ((key: string, locale: string) => string | void) | null): void;

    /** Live snapshot of instance state. Untracked. */
    stats(): I18nStats;
}

export class MissingKeyError extends Error {
    readonly key: string;
    readonly locale: string;
    constructor(key: string, locale: string);
}

/**
 * Thrown by `ready()` when the per-instance readiness-signal cache is full.
 * A package error with a per-instance blast radius -- distinct from lite-signal's
 * process-wide `CapacityError`.
 */
export class LocaleCapacityError extends Error {
    readonly locale: string;
    readonly ceiling: number;
    constructor(locale: string, ceiling: number);
}

/**
 * Thrown at define time (I-07, v1.2.1) when a message nests argument blocks
 * deeper than 32 levels. Extends `SyntaxError` (it groups with every other
 * compile-time template failure) but carries the offending `key` and the `depth`
 * reached, replacing the bare `RangeError: Maximum call stack size exceeded` the
 * uncapped tokenizer used to throw. The dict is byte-identical after the throw.
 */
export class MessageDepthError extends SyntaxError {
    readonly key: string;
    readonly depth: number;
    constructor(key: string, depth: number);
}

/**
 * Per-instance ceiling for every per-locale cache keyed on an untrusted string
 * (`_readySignals`, `_pluralRules`, `_ordinalRules`). Sized well under
 * lite-signal's process-wide 1024-node pool.
 */
export const LOCALE_CACHE_MAX: number;

/**
 * Resolve a requested locale against an app's supported list via BCP 47 prefix
 * matching (exact -> request truncation -> reverse prefix, all case-insensitive).
 * Returns the matching `supported` entry, or `undefined` for no match / empty
 * list / malformed request. The call-site fix that bounds the per-locale caches.
 */
export function resolveLocale(requested: string, supported: string[]): string | undefined;

/** Create an isolated i18n instance. */
export function createI18n(config?: I18nConfig): I18n;

/** Swap the instance used by top-level helpers (`t`, `plural`, `locale`, ...). */
export function setDefaultI18n(inst: I18n): void;

/** Read the current default instance (used internally by `Format.js`). */
export function getDefaultI18n(): I18n;

// ---------- Top-level helpers (default instance) ----------

/**
 * Package version. Part of the suite's version sync (package.json, the `VERSION`
 * const in `I18n.js`, `llms.txt`, and this declaration). Kept in the `.d.ts` so
 * `tsc` consumers see the same symbol the runtime exports (I-16, v1.1.4).
 */
export const VERSION: string;

/** Current locale of the default instance. ESM live binding -- reassigned by `setDefaultI18n`. */
export let locale: Signal<string>;

export function t(key: string, params?: MessageParams): string;
export function plural(key: string, count: number, params?: MessageParams): string;
export function defineMessages(locale: string, dict: MessageDict): void;
export function loadLocale(locale: string, loaderFn: () => Promise<MessageDict>): Promise<void>;
export function ready(locale: string): Signal<boolean>;
export function unloadLocale(locale: string): boolean;
export function clear(): void;
export function setFallback(fallback: string | string[]): void;
export function setMissingKeyPolicy(policy: MissingKeyPolicy): void;
export function onMissingKey(fn: ((key: string, locale: string) => string | void) | null): void;
export function stats(): I18nStats;
