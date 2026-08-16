# 0002 -- every selector read is own-property-only (I-01), and what that pins

Status: accepted (session I1, v1.1.4)
Machine: node v26.3.1, darwin arm64, Apple M4 Pro. Trap sequences below were
measured against the working tree with a logging Proxy (see
`test/torture/t2-identity.mjs`).

## The defect and the fix

Type-1 slots read through `Object.hasOwn(params, key)` (I18n.js, type-1 branch).
The three SELECTOR reads did not -- they were bare `params[key]`:

| Site | 1.1.3 line | 1.1.4 code |
| --- | --- | --- |
| type-2 plural / selectordinal variable | `const nVal = params[t.variable]` | `Object.hasOwn(params, vkey) ? params[vkey] : undefined` |
| type-3 select variable | `const key = params[t.variable]` | `Object.hasOwn(params, vkey) ? params[vkey] : undefined` |
| plural-object `count` | `const nVal = p.count` | `Object.hasOwn(p, "count") ? p.count : undefined` |

So a single `Object.prototype.gender = "male"` changed which SENTENCE rendered:
`t('{gender, select, male {He} ... other {They}}', {})` returned `"They"` clean
and `"He"` polluted. `.count = 1` turned `" items"` into `" item"` -- and because
`#` compiles to a guarded type-1 slot, the polluted plural rendered a sentence
with NO number in it, a worse artifact than an unguarded number would have been.
It hit plural-object entries too (the TMS-export shape), a fourth reader the
roadmap's two-site write-up missed.

### Why this is a fix with no new policy

An absent own property already meant "resolve to `other`": before the fix, a
call with no `gender` key returned `undefined` from the bare read, and
`variants.get(undefined) || variants.get("other")` selected `other`. After the
fix, `Object.hasOwn` false yields `undefined` at exactly the same point, so the
`other` fallback fires identically. The ONLY behaviour that changes is the one
that must: an INHERITED property no longer counts as present. Every own-property
call renders byte-identically to before. The T2 matrix and the two rewritten
`08-torture.test.mjs` pollution tests both failed on 1.1.3 and pass on 1.1.4;
the pre-fix failure output is on the record in the session report.

## The Proxy contract (the observable change that must be pinned)

`Object.hasOwn(o, k)` invokes the `getOwnPropertyDescriptor` trap. So routing a
selector read through `hasOwn` inserts a `gopd` before the `get` that was there
before. Measured trap sequences, with a Proxy whose target owns the property:

| Template | 1.1.3 traps (pre-fix) | 1.1.4 traps (post-fix) | result |
| --- | --- | --- | --- |
| `"Hi, {name}"` | `gopd:name -> get:name` | `gopd:name -> get:name` | `"Hi, PX"` |
| `{gender, select, ...}` | `get:gender` | `gopd:gender -> get:gender` | `"He"` |
| `{count, plural, ...}` | `get:count -> gopd:count -> get:count` | `gopd:count -> get:count -> gopd:count -> get:count` | `"1 item"` |

(The plural row has two `gopd,get` pairs post-fix: one for the variable read,
one for the `#` slot inside the chosen variant. The slot row is unchanged
because it was already guarded.)

The decided contract:

- A Proxy that exposes the property as OWN -- `getOwnPropertyDescriptor` returns
  a descriptor -- is HONOURED at every read site, exactly as a plain object is.
- A Proxy whose `getOwnPropertyDescriptor` returns `undefined` now selects
  `other` (or renders `""` for a slot), even if its `get` trap would have
  returned a value. Pre-fix, the selector sites read the `get` value directly.

This is forced by consistency with slots, not free choice: the guarantee is
"own properties only, at every read site," and `Object.hasOwn` is the mechanism
slots already used. The trap-sequence change is the price of making that
guarantee total, and it is pinned in `t2-identity.mjs` so a later refactor
that (say) hoists the read back to a bare `params[key]` fails a named test
rather than silently changing the Proxy contract.

## I-17 -- the BigInt decision: NARROW the type, do not coerce

`I18n.d.ts` declared `MessageParams = Record<string, string | number | bigint |
boolean>`. The runtime disagrees with that promise: a bigint in a `{slot}`
renders fine (`10n -> "10"` via string concat), but a bigint reaching a
plural/selectordinal variable throws `TypeError: Cannot convert a BigInt value
to a number` out of `Intl.PluralRules.select`. Shipping the type and the throw
together is the fail-open case.

Two options: coerce with `Number(...)` at the selector, or narrow the type.

**Decision: narrow the type.** `MessageParams` is now
`Record<string, string | number | boolean>` (bigint removed). Reasons:

1. **Coercion is entangled with out-of-scope I-08.** Coercing the plural
   selector value would also change the `=N`-exact-vs-category dispatch for
   STRING counts (`count: "1"` currently misses the number-keyed `=1` map but
   matches the `one` category). I-08 is explicitly out of scope this session
   ("pin what it does today, leave it"). A `Number(...)` at the selector cannot
   be added without also moving I-08's answer, so it is forbidden here by
   transitivity.
2. **It is a hot-body change avoided.** Coercing adds a `ToNumber` on the type-2
   plural path, whose Q2 ceiling is committed (46 scavenges/1M). Narrowing the
   declaration costs zero runtime instructions -- the six Q2 ceilings are
   provably unmoved.
3. **Fail closed.** A type that promises `bigint` on a path that throws is
   fail-open. A type that omits it is sound: the runtime is more permissive than
   the declaration in the slot case (bigint renders), which is the safe
   direction. Callers convert explicitly: `t(k, { n: Number(big) })`. The
   runtime keeps throwing on a bigint count, pinned by
   `test/08-torture.test.mjs` ("own BigInt value" row) and the pre-existing
   `plural with BigInt throws` test.

## Fence against reflexive reversal

A later session must NOT:

- Replace any of the three `Object.hasOwn` selector guards with a bare
  `params[key]` "for speed." The guard reads an own property and allocates
  nothing; `select` still measures 0 scavenges/1M after the fix (Q2, T6). It is
  not a hot-path cost, it is a correctness invariant. `t2-identity.mjs` and T9
  control 6 (which reverts the select guard and asserts T2 catches it) exist to
  fail CI if it is removed.
- Re-add `bigint` to `MessageParams` without ALSO deciding I-08 and coercing at
  the selector under a fresh Q2 measurement. The type and the runtime must not
  disagree again; whichever way I-08 lands, the bigint answer moves with it.
