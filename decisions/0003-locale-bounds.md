# 0003 -- every per-locale cache is bounded, but the three bounds are NOT the same

Status: accepted (session I2, v1.2.0)
Machine: node v26.3.1, v8 14.6.202.34-node.20, darwin arm64, Apple M4 Pro.
All numbers below were reproduced against the working tree; the pre-fix numbers
are from `git show 5d271ef:I18n.js` (v1.1.4).

## The defect and the shape of the fix

Three per-locale structures grew without a bound and nothing ever released one.
The roadmap framed this as "one bug in three costumes" and recommended a single
uniform policy (fail closed, one ceiling). Reproducing the three showed they
fail in **opposite** directions, and a uniform policy is actively wrong for two
of them:

| Cache | Entry is | Failure pre-fix | Policy chosen | Why |
| --- | --- | --- | --- | --- |
| `_readySignals` | a subscribed lite-signal, **identity-bearing** | throws at ~1020 (pool), poisons the whole process | **fail closed** -- `LocaleCapacityError` at the ceiling | evicting one silently orphans a live effect: worse than the leak |
| `_pluralRules` / `_ordinalRules` | a **pure memo** of `(locale, type)` | silent, 3000 cached with a fallback chain, no throw | **FIFO eviction, no throw** | reconstructing is byte-identical, so a throw would convert a leak into an outage |
| `_dicts` | user-owned compiled state | silent, no eviction API at all | **explicit API only** (`unloadLocale` / `clear`) | never evict what the user defined; they must ask |

The split is decided by ONE question: **does the entry carry identity a caller
can hold?** A signal does (an effect subscribes to it). A memo does not (nobody
can tell one `Intl.PluralRules("pl")` from another). User dicts are neither --
they are owned, so only the owner retires them.

## Why `_readySignals` fails closed, and why the rejected designs are rejected

The documented ready-before-load idiom (README, llms.txt) subscribes to
`ready(loc)` **before** the locale exists -- that is the entire point of a
readiness gate:

```js
effect(() => { if (!ready("bg")()) { spinner.show(); return; } spinner.hide(); });
loadLocale("bg", () => import("./locales/bg.js").then(m => m.default));
```

Two designs were considered and rejected, each with the measurement that rejects
it:

1. **Shared permanently-false singleton** (the roadmap's recommendation). A
   single signal subscribed by every observer: flipping it for `bg` re-fires
   `de`'s effect, and it cannot stay false or `bg` never becomes ready. Measured
   on the current tree, two gated locales with only `bg` loaded: `ready("bg")
   !== ready("de")` (distinct) and loading `bg` does NOT re-fire `de`. The
   allocation the singleton tries to avoid **is the identity that makes the API
   work.** Pinned by four named tests in `test/11-locale-bounds.test.mjs`
   ("distinct signal identity", "stable signal identity", "flips false -> true
   ... only for the loaded locale", "loading A does NOT re-fire an observer
   gated on B").

2. **LRU eviction of `_readySignals`.** Evicting a signal a live effect is
   subscribed to silently orphans that effect -- the spinner never hides because
   the signal that would flip it was dropped. A leak converted into a stuck UI.

So `_readySignals` throws a NAMED `LocaleCapacityError` (naming the locale and
the ceiling) at `LOCALE_CACHE_MAX`. It is a **package** error with a
**per-instance** blast radius, distinct from lite-signal's process-wide
`CapacityError`. Fail closed, never evict.

## Why the Intl caches evict, and the eviction-equivalence proof

`_pluralRules` / `_ordinalRules` are pure memos: the value is fully determined by
`(locale, type)`, so a reconstructed entry is **observationally identical** to
the evicted one. That is what licenses eviction over a throw -- and it is
PROVEN, not assumed. `test/11-locale-bounds.test.mjs`
("eviction-equivalence ...") renders Polish (one/few/many/other -- a rich table)
at several counts, force-evicts the `pl` entry by filling the cache past the
ceiling with other locales, re-renders, and asserts the output is byte-identical.
If reconstruction ever diverged, the policy split would be an opinion; the test
makes it a fact.

Applying the roadmap's blanket "fail closed" here would make a long-running SSR
process throw on its 1025th visitor locale -- a leak turned into an outage. The
uniform ceiling is the trap this session existed to avoid.

### FIFO, not LRU -- forced by the hot path

`getRules` is on the hot path: a plural/selectordinal render calls it on every
frame, and its first three lines (`cache.get(loc)` + return-on-hit) are that
path. True LRU requires touching a recency structure on every cache **hit** --
i.e. adding work to the hot path, which the session's law forbids. So eviction is
**FIFO** (insertion order): the miss branch, which already constructs an ICU
object, drops the oldest entry with `cache.delete(cache.keys().next().value)`
before `cache.set`. The hit path is byte-identical to 1.1.4 (proven: the six Q2
ceilings are unmoved -- static 0, slot 23, plural 46, select 0, selectordinal 46,
`plural()` 100, all bit-identical to `baseline.json`). Because the entries are
pure memos, WHICH one FIFO drops is observationally irrelevant, so FIFO buys the
hot-path guarantee at zero correctness cost. Random eviction and generational
clearing were the brief's other sanctioned recency-free options; FIFO was chosen
because it holds the cache at exactly the ceiling and makes the
eviction-equivalence test deterministic (the oldest victim is known).

## The ceiling arithmetic -- per-instance bound vs a process-wide pool

`LOCALE_CACHE_MAX = 256` is **per-instance**. lite-signal's node pool is
**process-wide**, capacity 1024, shared with every other lite-* package. Only
`_readySignals` draws on that pool (one node per readiness signal);
`_pluralRules` / `_ordinalRules` are plain `Map`s of Intl objects and consume no
pool nodes. Measured:

- A bare `createI18n()` costs **2 pool nodes** (`_locale` + `_epoch`).
- Because `ready()` fails **closed** rather than churning, one instance mints at
  most `LOCALE_CACHE_MAX` readiness nodes over its ENTIRE life -- it never
  evicts-and-recreates a readiness signal. So one instance's pool footprint is
  bounded at `2 + 256 = 258` and **does not scale with the number of locale
  strings observed** (T8 asserts exactly this against lite-signal's own
  `activeNodes` gauge: a 500-locale run and a 5000-locale run leave the same
  footprint).

**The bound alone does NOT close I-03, and this is stated plainly.** Four
instances each filling a 256 ceiling is `4 x 258 = 1032 > 1024`: the process
still dies, each instance staying under its own limit. A per-instance bound that
lets four tenants exhaust the pool has not fixed the ecosystem bug. Two things
resolve it, and both ship:

1. **`resolveLocale(requested, supported)`** is the fix at the CALL SITE. It
   turns an unbounded stream of untrusted locale strings into a bounded set
   drawn from the app's own supported list, so `ready()` never reaches the
   ceiling in the first place. A correctly-written app calls `ready()` only with
   resolved locales -- a handful, not thousands -- and 256 is then pure
   backstop. Shipping the bound without the negotiator would tell users their
   input is dangerous and hand them nothing; they ship together.
2. **The crash is now survivable.** Pre-fix, hitting the pool threw
   `CapacityError` and then `createI18n()` itself threw -- every signal in every
   lite-* package in the process, dead. Post-fix, an instance that mis-uses
   `ready()` throws its OWN `LocaleCapacityError` at 258 nodes, long before the
   pool is exhausted, and the rest of the process keeps working (T4/T8 assert a
   fresh `createI18n()` renders after 10k abusive locales). The blast radius went
   from process-wide to instance-wide.

Why 256 and not higher: it must leave headroom for the rest of the process (this
package is not the pool's only consumer, and at 2 nodes/instance it is not even
the largest). 256 lets a single instance's legitimate locale set be large while
keeping `ceiling + instance` an order of magnitude under the pool, so a
single well-behaved instance never trips it and a single misbehaving one trips
its OWN error, not the pool's.

A NOTE ON POOL RECLAMATION (honest limitation): lite-signal nodes are reclaimed
by explicit `dispose`, not GC. `unloadLocale` and `clear` drop the readiness
signal from the map (so `stats().readySignalsCached` falls) and set it false so
subscribers see the transition, but they do NOT dispose the underlying
node, because disposing a signal a subscriber may still hold is unsafe. So a
`clear()`-then-repopulate loop consumes fresh pool nodes each cycle. This is
bounded per cycle (<= 256) and acceptable for the reset-and-move-on use case
`clear()` targets; a future session that needs cycle-stable pool reclamation must
first settle safe signal disposal in lite-signal. The torture tiers dispose the
signals they mint (they attach no subscribers) so the single-process run stays
within the pool.

## I-19 -- the warn budget

`getRules` catches an invalid tag, warns, and caches the environment-default
rules under the bad key. The old source reasoned the cache "stops repeated
constructor attempts, so this is naturally rate-limited." True per tag -- and the
tag set is exactly what an attacker varies (`Accept-Language`). Measured pre-fix:
500 distinct invalid tags -> 500 `console.warn` calls, a log-flood surface.

Decision: a per-instance `WARN_BUDGET = 32`. The first 32 distinct invalid-tag
warnings print; the rest are silently counted in `stats().warningsSuppressed`.
Rate-limit on a fixed budget, not on the varied input. The budget is checked in
the same cache-miss catch branch that already exists, so it costs the hot path
nothing. Pinned by `test/11-locale-bounds.test.mjs` ("I-19 ... capped ... the
rest are counted") and exercised at 10k scale in T4.

## What unloading the ACTIVE locale does

`unloadLocale(loc)` is **permitted** on the active locale (and on a fallback
locale). It drops the dict, both rules memos and the readiness signal, and:

- **removes the readiness signal from the map and then sets it false**, so a
  subscriber -- which still holds the reference -- observes the `true -> false`
  transition, while a re-entrant `ready()` fired from inside that notification
  re-mints a fresh signal rather than receiving the retired one (pinned by the
  `[true, false]` observer sequence in `test/11-locale-bounds.test.mjs`);
- **bumps the epoch** if the unloaded locale was active or in the fallback chain,
  so every `t()` observer re-renders. Resolution then falls through the fallback
  chain; with no fallback, keys resolve to the missing-key policy. Pinned:
  "unloading the ACTIVE locale falls through to the fallback and re-renders".

This is the honest contract for a reset: every key from that locale is gone, and
the graph re-renders to reflect it, rather than silently serving stale strings.

`clear()` is the whole-instance form: it releases every dict, compiled entry,
cached rule, readiness signal and in-flight load, zeroes the retired/suppressed
counters, and bumps the epoch. It deliberately does NOT change the active locale,
fallback chain or missing-key policy -- those are configuration, not content
(use `locale.set` / `setFallback`). A load already dispatched cannot be cancelled
(it is a live promise), so a loader that settles after `clear()` re-defines its
locale as an ordinary write; guarding that async write against a concurrent reset
is the I-05 write-race, owned by I3 -- not papered over here.

## Fence against reflexive reversal

A later session must NOT:

- **Apply a uniform policy to all three caches.** The split is load-bearing:
  `_readySignals` fails closed because its entries have subscriber identity;
  the Intl caches evict because theirs are pure memos; `_dicts` is
  user-owned. Collapsing them re-opens exactly one of the two failure modes
  (an SSR outage on the 1025th locale, or a silently-orphaned live effect).
- **Replace FIFO on the Intl caches with true LRU "for better hit rates."** LRU
  touches a recency structure on every cache HIT -- the hot path. The six Q2
  ceilings would move. If a future session needs recency, it must prove it stays
  off the hit path (or pick another recency-free policy) under a fresh Q2
  measurement.
- **Re-introduce the shared-singleton `ready()`** or **LRU-evict
  `_readySignals`.** Both break the documented ready-before-load idiom; the four
  identity tests exist to fail CI if either lands.
- **Assume the per-instance ceiling closes I-03 on its own.** It does not (4
  instances at 256 oversubscribe the 1024 pool). `resolveLocale` at the call
  site is the actual fix; the ceiling is the backstop.
