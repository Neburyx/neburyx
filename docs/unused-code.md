# Finding unused code

[knip](https://knip.dev) (ISC licence) reports files, exports, types and dependencies that nothing uses. It runs across the whole workspace in `pnpm lint` and as its own job in CI, and any finding fails both.

## Run it

```bash
pnpm knip
```

It needs `pnpm install` and nothing else; it reads the source, so no build is needed first. `pnpm knip --production` leaves the test files out, which shows what the shipped code uses.

## Where the entry points are

`knip.jsonc` at the root has one `workspaces` entry for every package, the root included. knip finds most entry points itself: the `main` and `exports` of a package, the test files and the configs of vitest, vite and Playwright. The config adds the rest:

- scripts that a root script, a workflow or a person runs by path (`tools/ci`, `deploy`, `tools/ux/scripts`);
- modules that tests build or read by path (`apps/web/src/dev/controls`, `tools/dev/src/testing`);
- `ee/ask/src/index.ts`, which the image and the dev entry scripts load through `dist`, a path knip cannot follow.

## Add a package

Add a `workspaces` entry for it to `knip.jsonc`, even an empty `{}`. `tools/workspace-checks` fails when a package has no entry, or an entry has no package.

## Ignore something

Prefer to fix it: remove the `export`, delete the code, or add the entry point. When a finding has to stay, add the narrowest ignore that covers it (`ignoreIssues` for one file and kind of finding, `ignoreDependencies` or `ignoreBinaries` inside the package's own entry) and put a `//` comment with the reason above it. `tools/workspace-checks` fails an ignore with no comment, and a blanket `ignoreExportsUsedInFile`.

A type that a declared return type names must stay exported even when nothing imports it; mark it with `/** @public reason */`.
