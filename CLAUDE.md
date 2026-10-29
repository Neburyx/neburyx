# CLAUDE.md

Guidance for Claude Code in this repository. This file is public. Keep it free of anything you
wouldn't want a reader to see.

## What this is

Neburyx is a graph investigation workbench that runs on top of an existing Neo4j database. It
explores a bounded network around an entity, explains each link with its source evidence, and stays
safe on very high-degree nodes. The repo is **pre-release**: layout and licence files only, no code yet.

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

No code exists yet, so there are no commands. When the stack is chosen and the skeleton lands, list
here: install, run, test, lint, and how to start the demo environment.

## Conventions

- Keep changes small and focused. One concern per commit, with a plain-language message.
- Add tests with code. Cover the failure paths of the gate and the paging behaviour on high-degree nodes.
- Public docs describe what the product does and how to run it. Don't put roadmap dates, pricing or
  internal planning in them.
- Match the spelling and style of the file you're editing.

## Git

- Commit only when asked. Do not push unless asked.
- Don't rewrite pushed history, and don't change global git config.
