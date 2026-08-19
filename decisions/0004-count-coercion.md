# 0004 -- the plural count is normalized once, and null is not zero (I-08)

Status: accepted (session I3, v1.2.1)
Machine: node v26.3.1, v8 14.6.202.34-node.20, darwin arm64, Apple M4 Pro.
All rows below were measured against the working tree.

## The defect

A plural block dispatches in two stages (I18n.js, `renderTokens` type-2 and the
`compilePluralObj` render closure):

1. an EXACT bucket -- `exact.get(nVal)` -- a `Map` keyed by `+em[1]`, i.e. by
   **number** (`=0` -> key `0`, `=1` -> key `1`);
2. a CATEGORY fallback -- `Intl.PluralRules.select(nVal)` -> `zero one two few
   many other`.

Pre-fix the two stages saw the RAW parameter, so its JS type decided the
sentence:

| template `{count, plural, =1 {EXACT ONE} one {CATEGORY ONE} other {MANY}}` | `count` | 1.2.0 rendered |
| --- | --- | --- |
| number `1` | `EXACT ONE` (exact hit) |
| string `'1'` | `CATEGORY ONE` -- `exact.get('1')` MISSES the number key `1`, `select('1')` coerces to `one` |
| `'1e3'` | `MANY` |
| `''` | `MANY` |
| `null` | `MANY` |
| `2n` (BigInt) | **throws** `TypeError: Cannot convert a BigInt value to a number` out of Intl's ToNumber, before `.select` |

One logical value, two sentences, chosen by a type the translator cannot see: a
form input hands you `'1'`, a counter hands you `1`. And a BigInt threw mid-render,
in production, with no key/locale/package in the message.

## The fix: coerce ONCE, before both stages

`coerceCount(v)` normalizes the selector a single time, and BOTH `exact.get` and
`select` consume its result:

```
number   -> v                       (NaN stays NaN)
bigint   -> Number(v)               (2n renders like 2; the raw TypeError is unreachable)
string   -> +v if it parses, else v ('1'->1, '0'->0, '1e3'->1000, ' 5 '->5)
blank    -> v (unchanged)           (empty OR all-whitespace stays OUT of the number bucket)
other    -> v                       (null/undefined/boolean/object unchanged)
```

## Why a bare `Number()` is WRONG -- null is not zero

The obvious "one ToNumber" is a suite-law violation. `Number(null)` is `0` and
`Number('')` is `0`, so with an `=0` bucket present a bare coercion renders the
ZERO sentence for a nullish count. Measured against
`{count, plural, =0 {ZERO} one {ONE} other {MANY}}`:

| count | 1.2.0 | bare `Number()` would give | shipped `coerceCount` |
| --- | --- | --- | --- |
| `0` | ZERO | ZERO | ZERO |
| `'0'` | MANY (the bug) | ZERO (intended) | **ZERO** (fixed) |
| `null` | MANY | **ZERO (law violation)** | **MANY** (law honored) |
| `''` | MANY | **ZERO (law violation)** | **MANY** (law honored) |
| `undefined` | MANY | MANY | MANY |

`null` is not zero, and neither is a blank string. An unknown/absent/blank count
is not the same statement as "exactly zero", so it must MISS the author-written
`=N` exact buckets and never trigger the `=0 {...}` literal the translator wrote
-- that literal is the law-governed surface. It then falls to the CLDR category
selector, which is Intl's domain: `Intl.PluralRules` applies its OWN coercion and
picks `other` in a locale with no `zero` category (e.g. English) or the locale's
`zero` category otherwise (e.g. Arabic, where Intl coerces `null`/`''` to `0` and
`0` is category `zero`); `undefined` -> NaN -> `other` in every locale. That
locale-driven category choice is correct and expected -- the fix is only that the
author's numeric `=0` bucket is never hit by a blank count. The normalizer is
therefore a typeof/nullish branch PLUS a blank-scan PLUS a ToNumber, not a bare
ToNumber.

## Why BigInt COERCES rather than throws a named error

The planner licensed either: coerce `Number(2n)` OR throw a named error carrying
the key. Coercion was chosen because:

- It makes `count: 2n` render exactly like `count: 2`, extending the
  count/string identity to the numeric-BigInt case instead of turning one
  numeric type into a hard error.
- The 1.1.4 I-17 decision narrowed the `MessageParams` type to drop `bigint`
  *because coercion was entangled with this very `=N`-vs-category split*
  (decisions/0002 sibling note, I18n.d.ts). I-08 UNTANGLES it, so the reason not
  to coerce is gone; `bigint` returns to the published union.
- The named error would have to carry the message KEY, which `renderTokens` does
  not receive -- threading it in would add an argument to the recursive hot
  render path for a case that coercion resolves at zero hot-path cost.

The raw `TypeError` is unreachable either way; that is the only hard requirement.
For a huge BigInt, `Number()` yields a finite value that Intl buckets into a
stable high-count category (`other` or `many`, per locale) -- no plural category
meaningfully distinguishes counts above 2^53.

## Fail-loud surface after the fix

`Intl.PluralRules.select()` never throws for `NaN`/`null`/`undefined`/`''`/
`'1e3'` -- it returns a CLDR category for each (`other` in English; the locale's
`zero` for `null`/`''`/`0` in a `zero`-category locale such as Arabic;
`undefined` -> NaN -> `other` everywhere). The only dispatch-time throw was
BigInt, now coerced.
So no input to `t()` throws out of Intl. (A `Symbol` count would still throw from
Intl's ToNumber, but a Symbol is not a count and is out of scope for I-08; it is
pinned as a `TypeError` in `08-torture.test.mjs`, unchanged.)

## Hot path

`coerceCount` runs on EVERY plural/selectordinal render. For the common case (a
`number`) it is one `typeof` and one comparison before returning the value
unchanged -- the value was already handed to `Intl.PluralRules`, which coerced it
anyway, so net cost is ~zero. Measured against I0's Q2 ceilings
(`test/torture/baseline.json`, scavenges/1M under the pinned semi-space): `plural`
and `selectordinal` stay within their committed ceilings (50); no ceiling moved.

## What this pins

- `count` and `String(count)` render identically for every plural template
  (torture T1 parity sweep, `test/12-define-time-law.test.mjs`).
- `null`/`''`/`undefined` never render an `=0` bucket.
- A BigInt renders, never throwing out of Intl.
- No input to `t()` throws from inside Intl.
