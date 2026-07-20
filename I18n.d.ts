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

/** Parameters passed to `t` and `plural`. Values are stringified on splice. */
export type MessageParams = Record<string, string | number | bigint | boolean>;

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
    /** Number of Intl.PluralRules instances cached (one per locale used with plurals). */
    pluralRulesCached: number;
    /** Number of Intl.PluralRules ordinal instances cached (selectordinal). */
    ordinalRulesCached: number;
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

    /** Reactive readiness signal for a locale. `true` once the dict is registered. */
    ready(locale: string): Signal<boolean>;

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

/** Create an isolated i18n instance. */
export function createI18n(config?: I18nConfig): I18n;

/** Swap the instance used by top-level helpers (`t`, `plural`, `locale`, ...). */
export function setDefaultI18n(inst: I18n): void;

/** Read the current default instance (used internally by `Format.js`). */
export function getDefaultI18n(): I18n;

// ---------- Top-level helpers (default instance) ----------

/** Current locale of the default instance. ESM live binding -- reassigned by `setDefaultI18n`. */
export let locale: Signal<string>;

export function t(key: string, params?: MessageParams): string;
export function plural(key: string, count: number, params?: MessageParams): string;
export function defineMessages(locale: string, dict: MessageDict): void;
export function loadLocale(locale: string, loaderFn: () => Promise<MessageDict>): Promise<void>;
export function ready(locale: string): Signal<boolean>;
export function setFallback(fallback: string | string[]): void;
export function setMissingKeyPolicy(policy: MissingKeyPolicy): void;
export function onMissingKey(fn: ((key: string, locale: string) => string | void) | null): void;
export function stats(): I18nStats;
