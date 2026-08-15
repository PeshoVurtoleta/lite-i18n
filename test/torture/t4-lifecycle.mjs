/**
 * T4 -- lifecycle abuse. RESERVED for I2.
 *
 * ready() for 10k distinct locales (the I-03 gate -- must not consume an
 * unbounded share of the lite-signal pool); loadLocale rejecting, retrying,
 * racing a defineMessages (I-05); unloadLocale / clear() (I-12, which do not
 * exist yet). Each case gets a decided policy: throw, documented no-op, or
 * documented undefined. I2 (v1.2.0) lands the eviction API this tier witnesses.
 *
 * Registered empty now. Prints nothing. The I-03 and I-05 reproductions ship
 * this session as todo tests in test/09-known-issues.test.mjs.
 */
export async function run() {}
