# CLAUDE.md

Guidance for Claude Code in this repository. This file is public. Keep it free of anything you
wouldn't want a reader to see.

## What this is

Neburyx is a graph investigation workbench that runs on top of an existing Neo4j database. It
explores a bounded network around an entity, explains each link with its source evidence, and stays
safe on very high-degree nodes. The repo is **pre-release**: the build tooling, an API server that serves the web build, the database migrations, `GET /v1/me`, the health probes, the container image and the Community compose file; no product features yet.

## Layout

| Path | Purpose |
|---|---|
| `apps/web` | Web client |
| `services/api` | Backend API |
| `packages/contracts` | API contract and generated client types |
| `packages/test-containers` | How tests and tools start a container (retries the port-binding timeout) |
| `packages/test-neo4j` | How the Neo4j tests reach a Neo4j Enterprise server of their own: the connection, a database per test file, the sweep of leftovers (see its README) |
| `domain-packs` | Ready-made mapping files, one directory per domain; YAML and Markdown only, no code (see its README) |
| `deploy/docker` | Container image build (`Dockerfile`; see its README) |
| `deploy/compose` | Community install: image + Postgres, loopback only (see its README) |
| `deploy/demo` | Demo environment: the product and two synthetic demo graphs, loopback only (see its README) |
| `tools/demo-graph` | Synthetic demo graph generator |
| `tools/dev` | The `pnpm dev` command: runs the app locally against your own Neo4j and Postgres, starting no container (see `docs/run-locally.md`) |
| `tools/renderer-spike` | Harness that draws one synthetic graph with two graph renderers and measures frame rate, node movement on incremental layout, grouping and keyboard access (see its README) |
| `tools/ux` | Browser tests (Playwright, Chromium) of the web app on a built copy with a small synthetic API: shells, keyboard paths, canvas behaviour, a benchmark guard (see its README) |
| `tools/driver-check` | By-hand check of how `neo4j-driver` and Neo4j behave on a transaction timeout and on a close mid-query (see its README) |
| `docs/` | Public technical documentation |

## Licensing

- Everything is Apache-2.0 (`LICENSE`, `NOTICE`).
- Don't add third-party code or dependencies without checking their licence is compatible with Apache-2.0.

## Rules that hold for all code

1. **Read-only** access to the customer's Neo4j. No write queries, ever, but one: the opt-in write probe of `test-source --write-probe`, which creates one empty node in a write transaction it always rolls back. No route, setting or screen reaches it; an architecture check confines it ([docs/architecture-checks.md](docs/architecture-checks.md)).
2. **One investigation per source.** Never combine sources silently.
3. **All source reads go through one gate**: resolve context, validate, authorize, execute, normalize,
   redact, audit. No code path reaches the database around it. An architecture check enforces it ([docs/architecture-checks.md](docs/architecture-checks.md)).
4. **No arbitrary query text reaches Neo4j.** Queries come from fixed, parameterised templates. Never
   build Cypher by concatenating user input.
5. **Never fetch a full neighborhood.** Expansion is paged and bounded. Counts are labelled exact,
   estimated, lower-bound or unknown. Never present a guessed number as exact.
6. **Boring to operate**: one container image, config-driven, no customer-specific code. Domain words live in
   `domain-packs/`, never in code; a check fails the build if a pack's entity type, label, relationship type or
   property key appears as a string literal in `services/api`, `apps/web` or `packages/contracts`.

## Data and secrets

- Synthetic data only. Never commit real customer, employer or personal data.
- Never commit secrets, keys or `.env` files (`.env.example` is fine).
- Never commit `.docx` files.
- Don't write names of real organizations or their internal tools in code, tests, fixtures,
  comments or docs.

## Build, test and run

Node 24 LTS (`.nvmrc`; with nvm, `nvm use`) and pnpm through Corepack, at the version pinned in
`package.json`. Commands run from the repo root:

| Task | Command |
|---|---|
| Install | `corepack enable`, then `pnpm install --frozen-lockfile` |
| Build | `pnpm build` |
| Type-check | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Unit tests | `pnpm test` |
| Contract test | `pnpm test:contract` |
| Integration tests (a Postgres container; needs Docker) | `pnpm test:integration` |
| Neo4j tests, the adapter's and the demo graph tool's (run against a Neo4j Enterprise 5.26 server you own, not in CI; `NBX_EE_URI`, `NBX_EE_USER` and `NBX_EE_PASSWORD` in the environment or in `~/.config/neburyx/dev-neo4j.env`; each file makes and drops its own `nbx-test-` database; see `packages/test-neo4j/README.md`) | `pnpm test:neo4j` |
| Supernode suite alone (anchors of 1,000, 10,000 and 100,000 relationships built once in a `nbx-test-` database of the Neo4j server that `test:neo4j` uses; payload bounds, count labels, stable load-more, the cost of each page, written to the file `NBX_SUPERNODE_RECORD` names; also run by `test:neo4j`; takes about 12 minutes on the dev 5.26 server; see `docs/benchmarks/README.md`) | `pnpm test:supernodes` |
| Build a pack's demo graph into a demo Neo4j (see `tools/demo-graph/README.md`) | `pnpm demo-graph build --pack banking-fraud --uri bolt://localhost:7687` |
| Image tests (builds the image and runs it; needs Docker, takes minutes) | `pnpm test:image` |
| Compose tests (brings the Community stack up and upgrades it, and brings the demo stack up; need Docker, take minutes) | `pnpm test:compose` |
| Run the app locally against your own Neo4j and Postgres, with the API and web app in watch mode (reads the settings file `~/.config/neburyx/dev.env`, or the one `NEBURYX_DEV_CONFIG` names; starts no container and never calls Docker; see `docs/run-locally.md`) | `pnpm dev` |
| Run the demo (the product and two synthetic demo graphs; see `deploy/demo/README.md`) | `cd deploy/demo && cp .env.example .env`, fill it in, then `docker compose up --wait` |
| Browser (UX) tests, after `pnpm build`, `pnpm --filter @neburyx/web build:ux` and `pnpm --filter @neburyx/renderer-spike build:node` (Chromium; `NEBURYX_UX_CHROME` may name an installed Chrome) | `pnpm test:ux` |
| Driver timeout check (starts Neo4j containers; needs Docker, takes about ten minutes; not in CI) | `pnpm check:driver` |
| Supernode benchmark (builds synthetic nodes of 1,000, 10,000 and 100,000 relationships in a database of its own on the Neo4j Enterprise server that `test:neo4j` uses, times a page of the paged expand through the gate and writes `docs/benchmarks/supernode.md` and `.json`; takes hours; not in CI; see `docs/benchmarks/README.md`) | `pnpm bench:supernode` |
| Render `docs/benchmarks/supernode.md` again from the stored `supernode.json` (no server) | `pnpm bench:render` |
| Regenerate `packages/contracts/openapi.json` | `pnpm --filter @neburyx/contracts generate` |

To run the API with the built web app (after `pnpm build` and `neburyx migrate`; `DATABASE_URL` is the app role's connection string):

```bash
DATABASE_URL=… NEBURYX_WEB_ROOT=apps/web/dist node services/api/dist/main.js
```

To test a configured source (after `pnpm build`, `neburyx migrate` and one start of the API; it prints the server version, a mapping summary, whether the login can write, whether the mapping fits the source (labels, relationship types, indexes, stable ids) and how the server counts the neighbors of each entity type (cheap, not cheap or could not tell), and exits `0` for pass and warn, `1` for fail, `2` for a usage error): `DATABASE_URL=… NEBURYX_CONFIG=… node services/api/dist/cli.js test-source --name <source>`. `--write-probe` also tries one write in a transaction it rolls back, to confirm that a login cannot write; use it in a test environment, never against a source you cannot afford to touch.

To create or upgrade the database (after `pnpm build`): `DATABASE_MIGRATION_URL=… DATABASE_APP_ROLE=… node services/api/dist/cli.js migrate`.

The API listens on `127.0.0.1:8080` unless `NEBURYX_HOST` and `NEBURYX_PORT` say otherwise, and logs a
warning if started outside a container on a non-loopback address.

CI runs lint, type-check, unit tests, the contract test, the integration tests, the build, the image build (both platforms), the compose test and the browser tests (`ux`) as separate jobs (`.github/workflows/ci.yml`). The demo
environment is in `deploy/demo`.

## Conventions

- Keep changes small and focused. One concern per commit, with a plain-language message.
- Write code to [docs/coding-guidelines.md](docs/coding-guidelines.md): TypeScript rules, when to
  comment and when not to, tests, and what differs between the API and the web client.
- Add tests with code. Cover the failure paths of the gate and the paging behaviour on high-degree nodes.
- Public docs describe what the product does and how to run it. Don't put roadmap dates, pricing or
  internal planning in them.
- Match the spelling and style of the file you're editing.

## Git

- Commit only when asked. Do not push unless asked.
- Don't rewrite pushed history, and don't change global git config.
