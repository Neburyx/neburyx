# Architecture checks

Two checks run with the unit tests (`pnpm test`, and so in CI) and fail the build when code breaks a structural rule.
They live in `tools/workspace-checks/src/architecture/`. Each reports the file, line and import that breaks the rule.

## No way around the gate

Every source read goes through the gate. Until the adapter exists, the check reads imports: a file in `services/`,
`packages/`, `apps/` or `ee/` may import these only where the table says.

| Import | Allowed in |
|---|---|
| the `neo4j-driver` package or a subpath | `services/api/src/sources/` |
| a module under `services/api/src/sources/` | `services/api/src/gate/` and `services/api/src/sources/` |
| the gate's executor modules: `gate/executor.ts`, `gate/execute.ts`, `gate/deps.ts` | `services/api/src/gate/` and `services/api/src/sources/` |

- Test files (`*.test.*` in any scanned extension) and `services/api/src/testing/` are exempt, because they fake or seed the
  outside world. Production code may not import or re-export them.
- A re-export of a restricted module is allowed only in a restricted module, so `gate/types.ts` cannot pass `executeRead`
  on. Re-exports read: `export … from`, `export *`, an import followed by `export { x }`, `export default x`, `export = x`, an
  exported constant that is just the binding or a property of it, `module.exports = x`, and an exported type written with an
  inline `import('…')`.
- Routes use the gate through `createGate` and the types `Gate`, `GateRequest` and `GatePage`.
- A relative specifier names a file when it carries an extension (`./sources.js` is a file next to a folder `sources/`, not
  the folder), a folder when it ends in `/index` (with or without an extension), and either when it has no extension; the
  check reads an extensionless specifier whichever way is stricter for the rule at hand.
- Reads: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs`. Static imports, type-only imports, inline type
  imports (`import('…')` in a type, also `typeof import('…')`), `import x = require('…')`, `export … from`, and `import()`
  and `require()` with a literal specifier. A query or fragment on a relative specifier is ignored.

When a new place must build the gate with the adapter, change the zones in `adapter.ts`, so the change is visible in review.

## Community never imports `ee/`

Any file outside `ee/` (including `tools/`) that imports a module under `ee/`, or the package names `ee` or `@neburyx/ee`
(or a subpath of either), fails the check. Code under `ee/` may import Community code. Other scopes (`@other/ee`) are not
this repository's `ee/`.

## What is scanned

The adapter check reads files under `services/`, `packages/`, `apps/` and `ee/`; the `ee/` check reads every file outside `ee/`.
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
