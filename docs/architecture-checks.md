# Architecture checks

Three checks run with the unit tests (`pnpm test`, and so in CI) and fail the build when code breaks a structural rule.
The first two live in `tools/workspace-checks/src/architecture/` and each reports the file, line and import that breaks the
rule. The third, [no domain words in code](#no-domain-words-in-code), lives in `tools/workspace-checks/src/domain-words/`
and reports the file, line and word. The [web client rules](#the-web-client) are a fourth group, in the same folder as the first two. A fifth, [test containers](#test-containers), reports a container started without the retry helper.

## No way around the gate

Every source read goes through the gate. Until the adapter exists, the check reads imports: a file in `services/`,
`packages/`, `apps/` or `ee/` may import these only where the table says.

| Import | Allowed in |
|---|---|
| the `neo4j-driver` package or a subpath | `services/api/src/sources/` |
| a module under `services/api/src/sources/` | `services/api/src/gate/` and `services/api/src/sources/` |
| the gate's executor modules: `gate/executor.ts`, `gate/execute.ts`, `gate/deps.ts`, and the two that take an executor to build a gate, `gate/gate.ts` and `gate/assemble.ts` | `services/api/src/gate/` and `services/api/src/sources/` |

- Test files (`*.test.*` in any scanned extension) and `services/api/src/testing/` are exempt, because they fake or seed the
  outside world. Production code may not import or re-export them.
- A re-export of a restricted module is allowed only in a restricted module, so `gate/types.ts` cannot pass `executeRead`
  on. Re-exports read: `export … from`, `export *`, an import followed by `export { x }`, `export default x`, `export = x`, an
  exported constant that is just the binding or a property of it, `module.exports = x`, and an exported type written with an
  inline `import('…')`.
- Routes use the `Gate` they are handed, through the types `Gate`, `GateRequest` and `GatePage`. Outside `gate/` and `sources/`, production code can reach the gate only through the module that exports `createSourceGate` (next section).
- A relative specifier names a file when it carries an extension (`./sources.js` is a file next to a folder `sources/`, not
  the folder), a folder when it ends in `/index` (with or without an extension), and either when it has no extension; the
  check reads an extensionless specifier whichever way is stricter for the rule at hand.
- Reads: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs`. Static imports, type-only imports, inline type
  imports (`import('…')` in a type, also `typeof import('…')`), `import x = require('…')`, `export … from`, and `import()`
  and `require()` with a literal specifier. A query or fragment on a relative specifier is ignored.

Plain values are made in `services/api/src/sources/plain-values.ts`, on the way out of the adapter: the gate and the normalizer never see a driver object, and a value the adapter does not know becomes `{ $type: 'unsupported' }`, not the raw value.

A profiled template (its Cypher starts with `PROFILE`, declared with `profile` and only for system templates) is a read like any other: it runs in a read transaction through the same executor, so the zones above are unchanged, and the plan comes back in the executor's outcome to the template's `normalize`.

When a new place must build the gate with the adapter, change the zones in `adapter.ts`, so the change is visible in review.

## The system principal and the system runner

`createSourceGate` builds the gate and the Neo4j executor from the mapping, and returns the user `Gate` (which has `run` only), a separate
system runner and a `close()`. Routes receive only the `Gate`; the system runner goes to the startup check and the scheduled ping. Two rules
keep the capabilities where they belong (`tools/workspace-checks/src/architecture/gate-capabilities.ts`):

| Import | Allowed in |
|---|---|
| the system-principal module, `gate/system-principal.ts` | `services/api/src/gate/` |
| the module that exports `createSourceGate`, `gate/source-gate.ts` | `services/api/src/gate/`, `services/api/src/start.ts` and `services/api/src/source-test/command.ts` (the `test-source` command builds its own gate and uses only the `Gate` it returns) |

Test files (`*.test.*`) and `services/api/src/testing/` are exempt, as above. A re-export of either module is never allowed, even from a file
that may import it, so `gate/types.ts`, `start.ts` and `source-test/command.ts` cannot pass the system principal or the system runner on. Both rules read the same
imports and re-exports as the adapter check, in the folders `services/`, `packages/`, `apps/` and `ee/`, and report the file, line and import.

## The write probe

The product reads. The one place that writes is the opt-in write probe of `neburyx test-source --write-probe`: it opens its own driver, runs `CREATE ()` in a write
transaction and always rolls it back (see the probe's module, `services/api/src/sources/write-probe.ts`). It does not go through the gate, so three rules confine it:

| Rule | Import | Allowed in |
|---|---|---|
| `adapter-access` | the one module under `services/api/src/sources/` that a file outside `gate/` and `sources/` may import: `sources/write-probe.ts` | `services/api/src/source-test/command.ts` (one exception in `adapter.ts`; every other `sources/` module is still reported there) |
| `write-probe` | `sources/write-probe.ts` | `services/api/src/source-test/command.ts` only. A file under `gate/` or `sources/` is reported too, and the command never re-exports it |
| `test-source-command` | the command module, `services/api/src/source-test/command.ts` | `services/api/src/cli.ts` only, with no re-export |

The tester takes the probe as an optional function whose type is declared in `source-test/probe.ts`, so it imports nothing from `sources/`; the route builds its tester without
one. Test files and `services/api/src/testing/` are exempt, as above, and static, type-only and dynamic imports and every form of re-export are read the same way.
`services/api/src/sources/readonly.test.ts` adds a scan: no file of the adapter names a write access mode or a managed or one-shot query method, and `commit` is among
those words; only the probe's module is exempt from the write access mode, and it is checked instead for the absence of `commit` and the managed and one-shot methods.

## Community never imports `ee/`

Any file outside `ee/` (including `tools/`) that imports a module under `ee/`, or the package names `ee` or `@neburyx/ee`
(or a subpath of either), fails the check. Code under `ee/` may import Community code. Other scopes (`@other/ee`) are not
this repository's `ee/`.

## What is scanned

The adapter check reads files under `services/`, `packages/`, `apps/` and `ee/`; the `ee/` check reads every file outside `ee/`.
The adapter, gate-capabilities, community and web-client checks do not parse a file whose text cannot hold what they look for: each has a pattern of the words a violation needs (a folder or module name, `cytoscape`, `fetch`, a query keyword) and a file holding none of them, and no escape sequence that could spell one (`\u0065`, `\x65`, an octal escape), is skipped. The real-tree tests of the first two and of the web-client check run in one file (`src/architecture/real-tree.test.ts`) that reads the tree once and parses a file for both import checks once; the limit on those tests is set from measurements, with the figures, in that file.
Both skip `node_modules/`, `dist/` and `.git/` folders and do not follow symbolic links (a scanned folder that is itself a
link is skipped); the `ee/` check also skips the check's own fixture repositories. A requested folder the repository does not
have is skipped; any other failure, such as a file or a parent folder that cannot be read, fails the check.

## What the checks cannot see

They read imports, not calls. They cannot see:

- a specifier built at run time, an absolute path or `file:` URL, or a path alias or package `exports` mapping that points
  into a restricted folder;
- a loader called some other way than `require('…')` or `import('…')` (for example `module.require(…)`, or `require`
  stored under another name);
- an executor or adapter handed to a function that declares only a structural type;
- a value forwarded some way other than the listed re-exports (a local copy exported later, a function that wraps a
  restricted one, a class that extends one).

Review covers those. The gate has one place that builds it, and the checks keep the modules that hold the executor closed.

## No domain words in code

No entity type, label, relationship type or property key of a shipped domain pack appears as a string literal in
`services/api`, `apps/web` or `packages/contracts`. Domain wording belongs in a pack under `domain-packs/`, so one image
serves any domain with no code change.

**What it reads.** Every `domain-packs/*/neburyx.yaml`: each entity `type`, `label` and `stable_id`; each relationship
`type`, `stable_id` and `observed_at`; every property named in `search`, `pii`, `filterable`, `reference`, `evidence` or
`key_properties`; the `state_property` and the `stop_list_property`; and the property names inside `title` placeholders.
Preset and rule ids and names, the vocabulary, source ids, addresses, credential variable names and link templates are not
identifiers. If no pack is found, a pack file is missing, is not valid YAML or has another shape, or a pack yields no
identifiers, the check fails and names the file; it never passes for nothing.

**What counts as a match.** A string literal, or a template literal with no substitutions, whose whole value equals an
identifier, compared exactly and with the same case. A phrase that only contains the word ("account settings") is not a match.
Quoted object keys, element accesses such as `row['x']`, JSX attribute values and import specifiers are string literals and
are matched; a JSX attribute value is read after its numeric and basic named character references (`&#100;`, `&amp;`) are decoded. Tests and fixtures are scanned too, so a test holds no pack name and reads names from the packs. The check reads
`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files in the three directories, skips `node_modules/`,
`dist/` and `.git/`, and does not follow symbolic links.

**When it fails.** Each line gives the file and line, the word, and what the word is in which pack. Rename the literal, move
the wording into a pack (and read it from there), or, for a word the product itself uses, add it to the allowlist with a reason.

**The allowlist.** `tools/workspace-checks/src/domain-words/allowlist.ts` lists a word and the reason for it. It holds only
words that are ordinary in code or part of the product's own vocabulary, such as a property called `name`. Its tests require
a reason on every entry, no repeats, that each word is an identifier of a shipped pack, and that the scanned code still uses
each word as a literal, so an entry that nothing uses has to be removed.

**What it cannot see.** Strings built at run time; comments; JSX text, which is where interface copy usually lives; template
parts that have substitutions; a word spelled or cased differently from the pack; and domain wording in interface copy beyond
identifiers. Review covers those.

## The web client

Rules for `apps/web/src`, checked in `tools/workspace-checks/src/architecture/web-client.ts` (file, line and reason are reported; test files are exempt from the first three):

| Rule | What fails the build |
|---|---|
| Reads go through the API client | a call to `fetch` with a path that starts with `/v1` outside `apps/web/src/api/` |
| No second type for an API shape | an `interface` or an object-shaped `type` alias, in `apps/web/src` including the client folder, whose name is also an export of `@neburyx/contracts` or ends in `Response`, `Request`, `Payload`, `Body` or `Dto`. A type derived with `z.infer` from a contracts schema, one imported from contracts, and a client-only type (transport options, a failure union, component props) pass |
| No query text | an upper-case Cypher clause keyword (`MATCH`, `OPTIONAL MATCH`, `MERGE`, `CREATE`, `RETURN`, `WITH`, `UNWIND`, `SET`, `REMOVE`, `DETACH`, `DELETE`, `CALL`, `LOAD CSV`) followed by a space and a parenthesis, bracket, brace, identifier or number, in a string, a template or a JSX text |
| No database client | a dependency of `apps/web` on a graph or database client (a package name that contains `neo4j`, `cypher`, `bolt`, `postgres`, `kysely`, `mongodb`, `mysql`, `sqlite`, `redis` or `valkey`, or is `pg`) |

The checks are by name and shape, so a duplicate of a contracts type under an unrelated name, or query text assembled from fragments or written in lower case, is for review. Imports from `ee/` and domain words in `.tsx` files are covered by the checks above; ESLint's rules apply to `.tsx` files too.

## Test containers

Every container that a test or a tool starts with `testcontainers` is started inside `startWithRetry` of `packages/test-containers`
(`tools/workspace-checks/src/architecture/containers.ts`). testcontainers waits a fixed 30 s for a container's host port to be
bound and has no setting for it, so a stall of the Docker daemon fails a start; the helper starts again after exactly that
error (three attempts in all) and removes the containers of a failed attempt first. The check reads every file under
`services/`, `apps/`, `packages/`, `tools/` and `ee/`, tests included, and reports the file and line of a `.start()` call on
`new …Container(…)` (or on a variable that holds one, found by its scope and by later assignments) that is not inside a `startWithRetry(…)` call.
