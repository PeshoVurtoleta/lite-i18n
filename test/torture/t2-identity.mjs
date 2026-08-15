/**
 * T2 -- the identity matrix (this package's A-07). RESERVED for I1.
 *
 * For every read site, cross every property provenance (own / inherited /
 * null-proto / Proxy get-trap). This is where I-01 lives: the select selector
 * (I18n.js:358) and the plural/selectordinal variable (:346) are bare
 * `params[t.variable]` reads with no Object.hasOwn guard, so Object.prototype
 * decides which variant renders. I1 (v1.1.4) fixes it with one hasOwn per
 * selector read and fills this tier with the complete matrix.
 *
 * Registered empty now so I1 has a slot to write into. Prints nothing.
 */
export async function run() {}
