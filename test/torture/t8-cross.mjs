/**
 * T8 -- cross-surface conformance. RESERVED for I2.
 *
 * Format.js <-> I18n.js: the WeakMap(opts)-keyed convenience cache and the
 * per-locale factory cache under locale churn and instance swap; setDefaultI18n
 * while a bound formatter is live. And the lite-signal pool budget: assert an
 * instance's total signal consumption is bounded and does not scale with the
 * number of locale strings observed (the I-03 gate, expressed as a budget
 * rather than as a crash). I2 lands the bound this tier gates.
 *
 * Registered empty now. Prints nothing.
 */
export async function run() {}
