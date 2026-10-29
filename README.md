# Neburyx

Neburyx is a graph investigation workbench that runs on top of an existing Neo4j database. It is
designed to stay up with little maintenance, to be safe on graphs with very high-degree nodes, and
to explain every link it shows.

**Status: pre-release.** There is no code here yet.

**Licence: not yet chosen.** No licence is granted until a `LICENSE` file is added.

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
