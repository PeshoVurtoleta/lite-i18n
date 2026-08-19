# 0006 -- an explicit define beats an in-flight load (I-05)

Status: accepted (session I3, v1.2.1)
Machine: node v26.3.1, v8 14.6.202.34-node.20, darwin arm64, Apple M4 Pro.

## The defect

`loadLocale(loc, loaderFn)` defers the loader onto a microtask and commits its
result in the success handler via a single `internalDefine(loc, dict)`. A
synchronous, intentional `defineMessages(loc, ...)` issued WHILE that load was in
flight was then silently overwritten when the load resolved. Measured on 1.2.0:

```
after define, before load resolves : FROM DEFINE
load promise                       : resolved
after load resolves                : FROM LOAD    <- the async writer won, silently
```

The promise RESOLVED. There was nothing to observe, log or assert on. This is
exactly how a translation reverts in production and nobody can reproduce it: the
explicit writer, later in program order, loses to an asynchronous one that was
already dispatched.

## The policy

The synchronous, intentional writer WINS. An explicit `defineMessages(loc, ...)`
for a locale with a load in flight CANCELS that load's commit. The load's promise
RESOLVES (the caller asked to load the locale; it is loaded, just not from the
loader), and the LOSING writer is OBSERVABLE: a named `console.warn` records that
the load result was discarded.

Rationale: a `defineMessages` call is unconditional programmer intent expressed
at a known point in program order. A load is a request whose result arrives at an
unpredictable time. When they collide, the intent that the programmer wrote by
hand, synchronously, is the one to honor -- and silently discarding EITHER writer
is the actual defect, so the discard is made visible rather than being made
"correct" by hiding it.

## The mechanism

Sited at the single commit call (`internalDefine` in loadLocale's success
handler):

- `defineMessages` marks the locale superseded -- `_supersededLoads.add(loc)` --
  but ONLY after `internalDefine` commits (a bad template throws and must NOT
  cancel the load) and ONLY if a load is actually in flight (`_loadPromises.has`).
- The success handler checks the mark: if set, it deletes the mark and the
  promise, emits the named warn, and RETURNS without calling `internalDefine`.
  The already-committed define stands; the promise resolves.
- The error handler and the fresh-load path both clear the mark so it can never
  leak across a later, uncontested load. Marks and promises are cleared together,
  so a stale mark is impossible (the fresh-load clear is defensive, not
  load-bearing). `clear()` empties `_supersededLoads`.

## The three orderings

- **define-then-load**: the define committed first, so `loadLocale` short-circuits
  on `_dicts.has(loc)` and NEVER runs the loader -- the define wins trivially, no
  warn.
- **load-then-define**: the core race. The define supersedes; the load resolves,
  discards, warns once.
- **both-in-flight**: a load superseded by a define, then a fresh load after the
  define -- the fresh load is not superseded (marks cleared with their promise)
  but short-circuits on the now-present dict. All three are pinned in
  `test/12-define-time-law.test.mjs`, plus the flipped I-05 reproduction in
  `test/09-known-issues.test.mjs`.

## Why resolve, not reject

The caller's contract is "ensure this locale is loaded". After the race the
locale IS loaded (from the define). Rejecting would force every `loadLocale`
caller to `.catch` a non-error condition. The load did its job; a different
writer just got there first, which the warn communicates without turning a
success into a failure.

## What this pins

- The synchronous define is visible immediately and stands after the load
  settles.
- The load promise resolves, does not reject.
- Exactly one named discard warning names the superseded locale.
- An uncontested load still commits normally, with no warn.
