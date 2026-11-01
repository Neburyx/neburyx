# CLAUDE.md

Guidance for Claude Code in this repository. This file is public. Keep it free of anything you
wouldn't want a reader to see.

## What this is

Neburyx is a graph investigation workbench that runs on top of an existing Neo4j database. It
explores a bounded network around an entity, explains each link with its source evidence, and stays
safe on very high-degree nodes. The repo is **pre-release**: the build tooling and an API server that serves the web build; no product features yet.

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

## Licensing

- Everything is Apache-2.0 (`LICENSE`, `NOTICE`) **except `ee/`**, which is reserved for a separate
  commercial licence and has no code yet.
- Never import `ee/` code from Community code. Community code must build and run without `ee/`.
  Enterprise features plug in through interfaces defined in Community code.
- Don't add third-party code or dependencies without checking their licence is compatible with Apache-2.0.

## Rules that hold for all code

1. **Read-only** access to the customer's Neo4j. No write queries, ever.
2. **One investigation per source.** Never combine sources silently.
3. **All source reads go through one gate**: resolve context, validate, authorize, execute, normalize,
   redact, audit. No code path reaches the database around it.
4. **No arbitrary query text reaches Neo4j.** Queries come from fixed, parameterised templates. Never
   build Cypher by concatenating user input.
5. **Never fetch a full neighborhood.** Expansion is paged and bounded. Counts are labelled exact,
   estimated, lower-bound or unknown. Never present a guessed number as exact.
6. **Boring to operate**: one container image, config-driven, no customer-specific code.

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
| Regenerate `packages/contracts/openapi.json` | `pnpm --filter @neburyx/contracts generate` |

To run the API with the built web app (after `pnpm build`):

```bash
NEBURYX_WEB_ROOT=apps/web/dist node services/api/dist/main.js
```

To create or upgrade the database (after `pnpm build`): `DATABASE_MIGRATION_URL=… DATABASE_APP_ROLE=… node services/api/dist/cli.js migrate`.

The API listens on `127.0.0.1:8080` unless `NEBURYX_HOST` and `NEBURYX_PORT` say otherwise, and logs a
warning if started outside a container on a non-loopback address.

CI runs lint, type-check, unit tests, the contract test, the integration tests and the build as separate jobs (`.github/workflows/ci.yml`). There is no demo
environment yet. Add its commands here when it exists.

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
