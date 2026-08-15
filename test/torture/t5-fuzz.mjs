/**
 * T5 -- differential fuzz against an oracle. RESERVED for I3.
 *
 * A naive, obviously-correct reference renderer (recursive descent, plain
 * string concatenation, Intl.PluralRules called directly, no caching, no fast
 * paths). Generate 100k random (template, params, locale) triples across all
 * five shapes plus nesting; assert the compiled renderer and the oracle agree
 * exactly. This is the tier that finds the bug nobody thought to name -- it
 * belongs with I3's define-time law so the oracle encodes a written contract
 * (the I-08 coercion rule) rather than today's accidents.
 *
 * Registered empty now. Prints nothing.
 */
export async function run() {}
