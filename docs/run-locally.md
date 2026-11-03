# Run it locally

One command brings the whole app up on your machine, against a synthetic demo graph, so you can try a change in a browser.

## What you need

- Node 24 (`.nvmrc`; with nvm, `nvm use`) and pnpm through Corepack (`corepack enable`).
- Docker with Compose v2. The demo stack uses about 4 GB of memory while the graphs load; give Docker more than that.
- Nothing listening on fixed ports: Docker chooses the host ports of the databases, and the tool chooses free ports for the API and the web app. Everything listens on `127.0.0.1` only.

## Start

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev`:

1. creates `.env` in the repository root with random passwords and a cursor key if there is none (mode `0600`, never committed, never overwritten, never edited; a damaged `.env` stops the command and names the key);
2. builds the demo graph tool, the contracts, the API and the web app;
3. starts Postgres and the two demo Neo4j containers from `deploy/demo` (project `neburyx-dev`), loads the demo graphs, and migrates the database;
4. writes `.dev/neburyx.yaml`, the mapping of the two demo sources made from the packs in `domain-packs/` with each source's address pointing at its container;
5. runs the API and the web dev server, with their compilers in watch mode.

It prints the addresses. Open the web app one; `GET /v1/sources` on the API lists both demo sources as `connected` and `synthetic`. A change to a source file of the contracts, the API or the web app reaches the running app without restarting the command.

The demo servers are Neo4j Community, which cannot list privileges, so `test-source` reports `Read-only: not verified` for them, and the demo logins are not read-only logins.

## Run again, stop, remove

- Run `pnpm dev` again: the existing `.env` is reused and the databases are started again. The demo graphs are loaded again each time.
- Only one copy runs at a time on a machine, from any checkout: a lock in the temporary folder refuses a second copy and names the checkout and the process. If it says the lock cannot be read, or a takeover was under way and none is, delete the file or folder it names.
- Ctrl-C stops the API, the web server and the compilers and leaves the containers running, so the next start is quick.
- `pnpm dev:down` (after stopping `pnpm dev`) removes the containers and volumes and the `.dev` folder, and keeps `.env`. Run with nothing running, it exits 0.

## Use a Postgres you already run

Set these in the shell before `pnpm dev` (not in a file you commit):

| Variable | Value |
|---|---|
| `NEBURYX_DEV_DATABASE_URL` | the app login's connection string, which the API uses |
| `NEBURYX_DEV_DATABASE_MIGRATION_URL` | the migration login's connection string |
| `NEBURYX_DEV_DATABASE_APP_ROLE` | the app login's role name |

With all three set, no Postgres container is started and the demo graphs are still started. With only some set, the command stops and names the missing ones. It never prints a connection string, an address or a password of your server.

The database and the two logins must exist first. [`tools/dev/external-postgres.sql`](../tools/dev/external-postgres.sql) creates a database `neburyx_dev`, a migration login that owns it and an app login, with the passwords as `psql` variables:

```bash
psql -v ON_ERROR_STOP=1 -v migration_password=… -v app_password=… -f tools/dev/external-postgres.sql
```

It needs Postgres 16 with the `pg_trgm` extension available, and a login to run it that is a superuser or has the `CREATEROLE` and `CREATEDB` attributes (the file grants that login the right to set the role of the new migration login, which Postgres 16 requires to give it the database); the product itself needs no superuser. `pnpm dev:down` never connects to your server.

## Checks that go with it

`pnpm test` includes a check that the root `.env.example` lists exactly the environment variables the API reads, each with a description. The tool itself is in `tools/dev`.
