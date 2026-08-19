# 0005 -- argument-block nesting is capped at compile time (I-07)

Status: accepted (session I3, v1.2.1)
Machine: node v26.3.1, v8 14.6.202.34-node.20, darwin arm64, Apple M4 Pro.

## The defect

Nested argument blocks (`{g, select, ... {n, plural, ...}}`) compile through a
mutually-recursive tokenizer: `tokenizeMessage`/`tokenizeSub` -> `parseArgument`
-> `compilePluralToken`/`compileSelectToken` -> `tokenizeSub` -> ... Nothing
bounded the recursion. Measured on 1.2.0:

```
depth   8  accepted        depth  200  accepted
depth  40  accepted        depth 2000  accepted
depth 5000  RangeError: Maximum call stack size exceeded   <- at DEFINE time
```

The only thing that rejected a runaway message was V8's own stack, and when it
did the error named no key, no locale and no package. A dictionary built from a
translation file (or a fuzzed export) can carry this, and the failure was
anonymous -- unactionable in a log.

## The fix

Cap at compile time at `MAX_TEMPLATE_DEPTH = 32` and throw a NAMED
`MessageDepthError extends SyntaxError` carrying the offending `key` and the
`depth` reached. Depth is threaded through the tokenizer: a top-level block is
depth 1, a block found inside a sub-template is `depth + 1`, and
`parseArgument` throws BEFORE descending once `depth > 32`. So the parser never
recurses deep enough to reach the stack RangeError -- the throw fires at the 33rd
level, ~150x below the observed stack limit.

## Why 32

32 is far above any real message. A two-axis plural (gender x count) is depth 2;
a three-axis message is exotic at depth 3. 32 leaves an order of magnitude of
headroom for a legitimately deep template while sitting far below the stack, so
the cap only ever fires on a runaway. The boundary is exact and pinned: depth 32
is accepted, depth 33 is the first rejected (`test/12-define-time-law.test.mjs`,
torture T3).

## Why SyntaxError subclass

Every other compile-time template failure throws `SyntaxError` (unmatched brace,
missing `other`, unknown selector, unsupported ICU shape). `MessageDepthError`
extends it so `catch (e) { if (e instanceof SyntaxError) ... }` still groups all
define-time failures, while `e.name === "MessageDepthError"` and the `.key` /
`.depth` fields let a caller pinpoint the runaway. It is exported from `I18n.js`
and declared in `I18n.d.ts`, mirroring `LocaleCapacityError`.

## Byte-identical dict after the throw

`internalDefine` compiles into a staging `Map` first and only copies into the
live bucket on success (the atomicity guarantee introduced for the fail-loud
corpus). A `MessageDepthError` is thrown during `flattenInto`, before any commit,
so the live dict is untouched. This is ASSERTED, not assumed: T3 and
`test/12-define-time-law.test.mjs` both define a good key, attempt a depth bomb,
and check `stats()` is byte-identical and every prior key renders unchanged.

## What this pins

- A depth bomb throws `MessageDepthError`, never `RangeError`.
- The error names the key and carries a depth > 32.
- Depth 32 accepted, depth 33 rejected -- the boundary is exact.
- The dict is byte-identical after the throw.
