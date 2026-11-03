# tools/dev

The command behind `pnpm dev` and `pnpm dev:down`. It is a developer tool: it runs other programs with argument lists (never a shell) and imports nothing from the product. How to use it is in [docs/run-locally.md](../../docs/run-locally.md).

- `src/settings.ts`: the five generated settings of `.env`, and the check of an existing file.
- `src/up.ts`: the steps of `dev up` and `dev down`; `src/compose.ts` runs the demo compose file with `deploy/demo/compose.dev.yaml`.
- `src/environments.ts`: the short environment each child gets. The API never receives the administrator or migration password.
- `src/lock.ts`: the machine-wide lock; `src/supervisor.ts` restarts the API when its build output changes and tells a start that never becomes ready from a crash after it was ready.
- `external-postgres.sql`: the statements for pointing the setup at a Postgres you run.
