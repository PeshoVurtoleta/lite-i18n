# 0007 -- the linter re-parses ICU-lite instead of sharing the compiler (coupling E)

Status: accepted (session I4, v1.3.0)
Machine: node v26.3.1, v8 14.6.202.34-node.20, darwin arm64, Apple M4 Pro.

## The decision

The `./lint` entry (`Lint.js`) re-derives ICU-lite structure -- slot names, the
plural/select variable, the token type, the CLDR keyword selectors, the `=N`
exact keys -- from the raw template string, in its own parser. It does NOT call
the compiler and the compiler is not changed to export its parser.

This is option 2 of BRIEF coupling E. Option 1 -- extract the tokenizer into a
shared internal module that both `I18n.js` and `Lint.js` import -- was rejected
for this session.

## Why not the shared module (option 1)

Option 1 has one real virtue: zero drift by construction, because both sides read
the same grammar. But it pays for that virtue on the wrong path:

- It refactors the core's compile path. `tokenizeMessage` / `tokenizeSub` /
  `parseArgument` / `compilePluralToken` / `compileSelectToken` are a
  mutually-recursive cluster wired directly into `defineMessages`. Moving them
  into a shared module is a hot-path-adjacent change with NO runtime feature
  behind it, in the session immediately before I5 (tRich), which the roadmap
  names as the one most sensitive to the compile path moving. The suite law is
  "bytes in a hot body, not instructions"; option 1 spends churn on the compiler
  to serve a build-time tool.
- The grammar is small and frozen. Four constructs (slot, plural, selectordinal,
  select), balanced-brace with an ICU quoted-string mode, `=N` exact buckets. I3
  wrote the last define-time law (the depth cap, the coercion, the nesting
  reconciliation); after I3 the grammar is not expected to move again before I6
  freezes it into a published format. A second reader of a frozen grammar is
  tractable to keep in step.

## What bounds the drift instead

The re-parse's only risk is that it and the compiler disagree about what a
template means. That risk is not left to inspection -- it is a correctness gate:

- **Render-observation parity (dogfood).** For the whole fixture corpus,
  `test/13-lint.test.mjs` asserts `extractSlots(message)` equals the slot set the
  COMPILER actually honours, observed by rendering: a param the compiler reads
  changes `t()`'s output when varied; one it ignores does not. The honoured set
  is derived empirically per fixture (probe every identifier in the template),
  so a slot the re-parse invents (over-extraction) or misses (under-extraction)
  fails the gate. This is the "dogfood in CI" task promoted from smoke test to
  correctness.
- **Mirrored primitives.** `findMatchingBrace`, the quoted-string escape mode,
  the selector alphabet, `isPluralObj`, and the `{var, kind, body}` head regex
  are copied from `I18n.js` with the same char-code logic, not re-invented, so
  the two parsers start from the same rules rather than merely the same intent.

If that parity gate ever proves fragile -- if a grammar change slips past it and
the re-parse drifts in production -- the counter-decision is to adopt option 1
and this record is the place to overturn it. It has not, so it stands.

## What this pins

- `Lint.js` imports nothing from `I18n.js`; the `.` graph never reaches `Lint.js`
  (asserted on the resolved module graph in `test/13-lint.test.mjs`), so importing
  the runtime ships zero linter bytes.
- The compiler's parse and every `.` public export are unchanged this session.
- The re-parse agrees with the compiler on the corpus by render-observation, not
  by assertion of intent.
