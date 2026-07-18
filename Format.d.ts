// @zakkster/lite-i18n/format
// Reactive Intl formatters -- number, date, relative-time, list.

import type { I18n } from "./I18n.js";

// ---------- Convenience form ----------
// Each call subscribes to the instance's locale signal.

export function formatNumber(
    value: number | bigint,
    opts?: Intl.NumberFormatOptions,
    i18n?: I18n
): string;

export function formatDate(
    value: Date | number,
    opts?: Intl.DateTimeFormatOptions,
    i18n?: I18n
): string;

export function formatList(
    items: Iterable<string>,
    opts?: Intl.ListFormatOptions,
    i18n?: I18n
): string;

export function formatRelativeTime(
    value: number,
    unit: Intl.RelativeTimeFormatUnit,
    opts?: Intl.RelativeTimeFormatOptions,
    i18n?: I18n
): string;

// ---------- Factory form (zero-alloc steady state) ----------

/** Returns a reactive `(value) => string`. Subscribes to locale on each call. */
export function numberFormat(
    opts?: Intl.NumberFormatOptions,
    i18n?: I18n
): (value: number | bigint) => string;

export function dateFormat(
    opts?: Intl.DateTimeFormatOptions,
    i18n?: I18n
): (value: Date | number) => string;

export function listFormat(
    opts?: Intl.ListFormatOptions,
    i18n?: I18n
): (items: Iterable<string>) => string;

export function relativeTimeFormat(
    opts?: Intl.RelativeTimeFormatOptions,
    i18n?: I18n
): (value: number, unit: Intl.RelativeTimeFormatUnit) => string;

// ---------- Bulk binder ----------

export interface BoundFormatters {
    formatNumber(value: number | bigint, opts?: Intl.NumberFormatOptions): string;
    formatDate(value: Date | number, opts?: Intl.DateTimeFormatOptions): string;
    formatList(items: Iterable<string>, opts?: Intl.ListFormatOptions): string;
    formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, opts?: Intl.RelativeTimeFormatOptions): string;
    numberFormat(opts?: Intl.NumberFormatOptions): (value: number | bigint) => string;
    dateFormat(opts?: Intl.DateTimeFormatOptions): (value: Date | number) => string;
    listFormat(opts?: Intl.ListFormatOptions): (items: Iterable<string>) => string;
    relativeTimeFormat(opts?: Intl.RelativeTimeFormatOptions): (value: number, unit: Intl.RelativeTimeFormatUnit) => string;
}

export function createFormatters(i18n: I18n): BoundFormatters;
