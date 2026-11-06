# Coding guidelines

How code is written in this repository, for the API, the web client, the shared packages and the
tools. All of it is TypeScript, so one set of rules covers both; the layer sections at the end add
what differs.

Match the file you are editing first. These rules decide the cases the surrounding code does not.

## Principles

1. **Boring beats clever.** Use the plain construct a new reader would expect.
2. **Make wrong states hard to write.** Put the rules in types and schemas, not in comments.
3. **Fail loudly at the edge, stay simple inside.** Validate input where it enters; trust validated
   values after that.
4. **Small steps.** One concern per change, with its tests.
5. **Honest numbers.** Never present a guess as exact (see the rules below).

## Rules from the product

These shape code directly. Breaking one is a bug, whatever the tests say.

- **Read-only.** No write query reaches the customer's Neo4j. No helper, option or flag makes that
  possible, except the one named path: the opt-in write probe of `test-source --write-probe`, which rolls its
  transaction back, is reached only by that command, and is confined by an architecture check.
- **Masking is done in the gate.** The redact stage (`services/api/src/gate/redact/`) masks the `pii` fields of a normalized result when the request asks, and `maskValue` is the one function that builds a mask. A template works on the original values inside the gate (its `normalize` runs before the redact stage); a route, the web client and any caller receive only the redacted output, and none builds a mask of its own.
- **One gate.** Every source read goes through the gate: resolve context, validate, authorize,
  execute, normalize, redact, audit. Nothing calls the adapter or the driver around it. Routes and
  services call the gate; an architecture test fails if anything calls the adapter outside it.
- **No query text from input.** Queries come from fixed, parameterised templates. Values are always
  parameters. The only interpolation allowed is a label, a relationship-type name or a property name
  taken from the validated mapping allowlist and backtick-quoted, done in one helper. Only a search
  template (the exact search, the related lookup and the type-ahead lookup) may repeat one fixed branch for each entry of a list of allowlisted targets (a label
  and a property of the `search` or the `reference` list); the branch text is fixed, the gate writes in only the quoted names, and the
  catalog checks the declaration. A name from a request is checked against the allowlist, never inserted as is. Never
  build Cypher or SQL by joining strings in any other way.
- **A read that needs an index finds out first.** A template names the indexes it needs; the gate reads
  the source's indexes at the start of the request and refuses, or leaves out, what has no online
  index before any data is read, because a database answers a missing index with a scan and not with
  an error. A login that cannot list indexes cannot be protected this way, and that is said.
- **Bounded fetches.** Never load a full neighborhood. Every read has a page size with a server-side
  maximum, a timeout and a budget. Limits come from config or a named constant, not a literal in the
  call.
- **Honest counts.** A count carries its quality: `exact`, `estimated`, `lowerBound` or `unknown`.
  Use the shared count type from `packages/contracts` (its value is absent when the quality is
  `unknown`), and never let a function return a bare number that a caller could show as exact.
- **One investigation per source.** Nothing merges results from two sources.
- **No domain words in code.** Entity and relationship names come from the mapping and the source
  profile. Code and UI components do not hard-code "account", "claim" or similar.
- **Config-driven, no customer-specific code.** Behaviour differences are configuration.
- **Synthetic data only** in code, tests, fixtures and comments.

## TypeScript

- **Strict mode** everywhere. Do not weaken `tsconfig` for one file.
- **No `any`.** Use `unknown` at a boundary and parse it with a Zod schema. If a library forces `any`,
  confine it to one wrapper function with a comment saying why.
- **No non-null assertion (`!`)** and no `as` assertions except `as const`. An assertion needs a
  reason a type guard or a schema parse cannot give; leave it with a short comment. `@ts-expect-error` with a reason is allowed; `@ts-ignore`
  is not.
- **One source for shapes.** Request, response and stored-document types are `z.infer` of the Zod
  schemas in `packages/contracts`. Do not hand-write a second type for the same thing.
- **Model states as discriminated unions**, and handle them with an exhaustive `switch` that ends in a
  `never` check. Prefer `{ status: 'ready'; data } | { status: 'error'; error }` over optional
  fields that may or may not be set together.
- **String-literal unions or `as const` objects, not `enum`.**
- **`readonly` by default** for fields, arrays and parameters that are not mutated.
- **Named exports.** Default exports only where a tool requires them. Keep barrel files to a
  package's public entry point.
- **Async.** Await or return every promise; a promise nobody awaits hides its failure. Pass an
  `AbortSignal` down to anything that can honour it. Do not mix `await` with `.then` chains.
- **Errors.** Services throw one application error type that carries a stable code from the error
  model and structured details; the API maps it to the response in one place. Codes are never
  strings made up at the throw site. Messages never contain query text or sensitive IDs, and every
  error response carries the request's trace ID. Unexpected errors are handled once, at the
  boundary. Never swallow an error; if you catch and continue, say why in a comment. Do not use
  exceptions for ordinary control flow (a lookup that may find nothing returns `undefined`).
- **Time and numbers.** Timestamps are ISO-8601 UTC strings at boundaries and `Date` or a library type
  inside; do not parse dates with ad hoc regexes. Times shown to people say UTC. Use integers for
  counts and sizes. Do not compare floats for equality.
- **Changing shared things.** Follow the [API conventions](api-conventions.md) for concurrency and retries: an `ETag` and
  `expectedVersion` on updates, an idempotency key on creates that a retry could repeat.
- **Text.** The product is English-only for now; do not add an i18n layer, but keep user-facing
  strings in one place per feature rather than scattered through logic.
- **Dependencies point inward.** Pure logic does not import I/O. Inject collaborators (adapter,
  clock, config) through parameters or constructors, so tests pass fakes without module patching.

## Writing the code

- **Names say what a thing is or does.** Functions start with a verb (`parseCursor`, `loadPage`).
  Booleans read as a question (`isStale`, `hasMore`, `canExpand`). Types are nouns. No single-letter
  names outside tiny lambdas or loop indices. Common abbreviations only (`id`, `url`, `db`, `ref`).
  Files are `kebab-case`.
- **One reason to change per module, one job per function.** If a function needs "and" to describe,
  split it. As a guide, a function that does not fit on a screen (about 40 lines) deserves a look.
- **Early return** over nested `if`. Keep nesting to about three levels.
- **No magic values.** A literal that is a limit, a timeout, a code or a key gets a named constant, or
  comes from config.
- **Pure core, effects at the edge.** Compute with pure functions; read, write and log in thin outer
  layers. This is also what makes tests cheap.
- **Duplicate twice, abstract on the third.** Do not build an abstraction for one caller. Do not copy
  a block a third time.
- **Delete, do not comment out.** Version control remembers.
- **No dead flags or unused parameters** "for later".
- **Logging.** Structured, with stable event names. Never log property values from the source, names,
  tokens, cursors, request bodies or connection strings. Entity IDs and template parameters stay
  out of logs by default; correlate with the trace ID and internal UUIDs.
- **Secrets** come from the environment or the secret store. Never in code, fixtures, logs or errors.

## Comments

**Default: no comment.** Clear names, small functions and types carry the meaning. Comment only where
the code is complex enough that a careful reader would get it wrong or lose real time. The code
says **what** it does; a comment says **why**. If a comment is needed to explain *what*, rename or
extract instead. An unnecessary comment is a defect: it costs reading time and goes stale.

**For people and AI tools writing code:** do not add comments by default. No file headers, no
docblock on every function, no line-by-line narration, no comment on code you did not change, no
comment that describes the edit you just made. Before you write one, ask whether a better name or a
smaller function removes the need. If it does, do that instead.

**Write a comment only when:**

- The reason is not obvious: a trade-off, a workaround for a library or database behaviour, or a
  performance constraint. Say what would break if it were "simplified".
- A safety or product rule shapes the code, and removing the line looks harmless. For example, why
  labels are taken from the allowlist, or why a count is `lowerBound`.
- A value or order matters in a way the type does not show (units, ordering guarantees, "null sorts
  last", inclusive or exclusive bounds).
- The logic is genuinely complex: a non-trivial algorithm, a regular expression, bit or time
  arithmetic, a concurrency or ordering subtlety. One or two lines on the idea, with an example for
  a regular expression.
- An exported function's behaviour cannot be read from its name and types (units, failure modes,
  side effects). One short TSDoc line. Do not add TSDoc to a function whose name and types already
  say it.
- A deliberate gap remains: `TODO:` with what is missing and the condition for doing it. No names, no
  ticket or planning IDs.
- A pointer to a public document replaces a long explanation (an architecture decision number, a
  section of the public docs).

**Do not write a comment that:**

- Repeats the code (`// increment i`, `// returns the user`) or a type signature.
- Narrates history or authorship ("added for the filters work", "changed from X", names, dates).
  Version control has that.
- Holds commented-out code.
- Marks sections with banners or ASCII rules, or labels blocks that a function name would label.
- Refers to planning or private identifiers (roadmap, epic, story, requirement or open-decision IDs).
- Apologises ("hacky", "quick fix") instead of fixing, or explains a bug it could just prevent.
- Is a long essay. If it needs paragraphs, the design belongs in a doc, with a one-line pointer.

Keep comments short (aim for one or two lines, wrapped at the surrounding code's width), in plain
sentences, and keep them true: change a comment in the same edit as the code it describes. Match the
comment density of the file you are in, unless that file over-comments; then do not add to it.

Tests follow the same rule: the test name states the behaviour; comment only the non-obvious reason
for a fixture or an odd assertion.

## Tests

- **Tests ship with the code.** A change is not done without them.
- **Two levels.** Unit and contract tests run fast with no containers. Integration tests (Postgres, and Valkey
  where used, via testcontainers; real Neo4j on a server you own, see `packages/test-neo4j`) cover the gate, adapters, migrations and
  coordination.
- **Failure paths first.** Cover bad input, tampered or expired cursors, oversized pages, timeouts,
  cancellation, busy and rate-limited states, and a source that is down, before the happy path.
- **Test behaviour at the module's edge**, not its internals. A refactor should not break tests.
- **Never mock or bypass the gate.** Unit tests of anything that reads from a source run the real gate
  with a fake adapter; integration tests run it against real databases. Fake the outside world
  (clock, network, model), not your own pipeline.
- **Deterministic.** Seeded data, fake timers, no real sleeps, no reliance on test order.
- **Synthetic fixtures** only, kept small and named for what they show.
- **Name tests as sentences** about behaviour ("refuses a cursor from another source").
- **Each behaviour the change promises maps to at least one test** or, for UI states, to a component
  test or a screen you have checked.
- **A bug fix starts with a failing test** that reproduces it.
- Avoid large snapshots; assert the fields that matter.

## Security and dependencies

- Validate every input at the edge with a Zod schema; reject unknown fields where the contract says to.
- Encode output for its context. No `dangerouslySetInnerHTML`, no `eval`, no dynamic `require`.
- Add a dependency only when it earns its place: check it is maintained, pin the version, and confirm
  its licence is compatible with Apache-2.0. Prefer the platform and what is already in the
  workspace.
- Do not add code from outside the repo without checking where it came from and its licence.

## Backend (`services/api`)

- **Layers.** Routes are thin: parse with the Zod schema, call a service, map the result or error to
  the response. Services hold the logic and call the gate. Only the adapter talks to the driver. SQL
  goes through the repositories in `db/`.
- **Templates.** Query templates live in one place with a parameter schema each. Adding a template
  means adding its schema, its allowlist entries and its negative tests together.
- **Database.** Migrations are plain SQL and forward-only. A migration must stay backward compatible
  for one minor version (add before you remove), because upgrades and rollbacks are tested from the
  previous release. Each migration is exercised by the install and upgrade tests.
- **Paging.** Keyset paging with a stable total order (state how nulls sort). Cursors are opaque and
  signed, and carry what is needed to refuse reuse from another source, user or filter set.
- **Budgets and cancellation.** Every read runs under the source's server-side transaction timeout,
  which is the main way a read is stopped. Also pass an `AbortSignal` where the library honours it,
  and treat a client abort as best effort. A cancelled or failed request never merges anything
  partial into what the user is working on; a result that is deliberately partial is labelled as
  such.
- **Errors.** Use the error model's codes. Each endpoint documents the codes it can return, and a
  test triggers each one.
- **Config.** Validate configuration at start-up and fail fast with a message that names the key, not
  the value.
- **Jobs and workers.** Same gate, same rules. Tasks are idempotent and safe to retry.

## Web client (`apps/web`)

- **Components.** Function components and hooks. Keep components small; move logic that does not
  render into plain functions or hooks you can test alone.
- **Four kinds of state, kept apart.** Server data (from the API) is cached by source, user, policy
  version, filters and parameters. Investigation state, presentation state (positions, selection,
  panel sizes) and job state are separate and are not copied into one another. Derive values; do not store them. Avoid `useEffect` for anything you
  can compute during render.
- **The server decides.** The client does not recompute counts, permissions or limits. It shows what
  the API returns, with the quality label next to any count that is not `exact` (for example "≥ 1,200").
- **API client** comes from `packages/contracts`. No hand-written response types or ad hoc `fetch`
  to `/v1`.
- **The renderer stays behind `GraphCanvas`.** Nothing outside that wrapper imports renderer APIs, so
  the choice stays reversible.
- **Every request-driven surface handles** loading, empty, error, partial, cancelled, busy and
  rate-limited where they apply, and a failure never clears what is already on screen. A stale
  response must not overwrite a newer one.
- **Accessibility is part of done.** Everything is reachable and operable by keyboard, focus is
  visible, controls have names, colour is never the only signal, and dialogs trap and restore focus.
  In component tests, find elements by role and accessible name rather than by test IDs; that checks
  this too.
- **Copy** comes from the agreed design. Domain words come from the source profile, not from literals.
  The UI says "relationship", not "edge".
- **Performance.** Measure before memoising. The graph is bounded (hundreds of elements, not
  thousands); keep it that way rather than optimising for scale the product does not allow.
- **Styling** reuses the colours, sizes and components already in the client; do not add one-off
  values inline. When the client has a shared set of design tokens, use those.

## Before you call code done

- [ ] Type-check, lint and the tests pass, and I ran them (say which, not "should pass").
- [ ] Every behaviour the change promises is proved by a test or a checked screen.
- [ ] Failure paths are tested, not just the happy path.
- [ ] No read bypasses the gate; no query text is built from input; fetches are bounded; counts carry
      their quality.
- [ ] No `any`, `!`, `@ts-ignore`, `console.log`, commented-out code or leftover debug.
- [ ] No secrets, real data or private identifiers in code, tests, comments, commit message or branch
      name.
- [ ] Every comment is there because the code is complex or the reason is not obvious, explains why,
      is short, and is still true. No comment was added by default.
- [ ] A new dependency (if any) is justified, pinned and licence-checked.
- [ ] The change is only what was asked for; follow-ups are written down, not slipped in.
