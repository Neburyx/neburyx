# Neburyx

Neburyx is a graph investigation workbench that runs on top of an existing Neo4j database. It is
designed to stay up with little maintenance, to be safe on graphs with very high-degree nodes, and
to explain every link it shows.

**Status: pre-release.** The workspace builds, type-checks, lints and tests, but there are no product features yet.

**Licence:** Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)), except the `ee/` directory, which is
not covered by it and is reserved for a separate commercial licence.

## Layout

| Path | Purpose |
|---|---|
| `apps/web` | Web client |
| `services/api` | Backend API |
| `ee/` | Modules under a separate commercial licence (placeholder) |
| `packages/contracts` | API contract and generated client types |
| `deploy/docker` | Container image build |
| `deploy/demo` | Demo environment on a synthetic graph |
| `tools/demo-graph` | Synthetic demo graph generator |
| `docs/` | Public technical documentation |

This repository contains no internal or private material, and uses synthetic data only.

## Development

Needs Node 24 (see `.nvmrc`) and pnpm, which Corepack provides at the version pinned in
`package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```
