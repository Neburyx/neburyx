# Run it locally

One command runs the app on your machine in watch mode, against a Neo4j and a Postgres that you run yourself. It starts no container and never calls Docker.

For a trial that needs no setup of your own, use the demo environment instead: [`deploy/demo`](../deploy/demo/README.md) brings up the product and two synthetic demo graphs.

## What you need

- Node 24 (`.nvmrc`; with nvm, `nvm use`) and pnpm through Corepack (`corepack enable`).
- A Neo4j you can reach, a mapping file for it, and a login for it. Use a read-only login.
- A Postgres 16 with the `pg_trgm` extension available, with the database and two logins set up as described below.
- Nothing listening on fixed ports: the tool chooses free ports for the API and the web app. Both listen on `127.0.0.1` only.

## The settings file

`pnpm dev` reads its settings from a file outside the repository: `~/.config/neburyx/dev.env`, or the file that `NEBURYX_DEV_CONFIG` names (an absolute path). Make it readable by you only:

```bash
mkdir -p ~/.config/neburyx
touch ~/.config/neburyx/dev.env
chmod 600 ~/.config/neburyx/dev.env
```

It holds `KEY=value` lines; a line that starts with `#` is a comment. All five keys are required:

```
# The mapping file of the source you want to explore.
NEBURYX_DEV_MAPPING=<absolute path of the mapping file>
# An env file holding the logins the mapping names with username_env and password_env.
NEBURYX_DEV_MAPPING_ENV=<absolute path of that env file>
# The app login's connection string, which the API uses.
NEBURYX_DEV_DATABASE_URL=<connection string>
# The migration login's connection string.
NEBURYX_DEV_DATABASE_MIGRATION_URL=<connection string>
# The app login's role name.
NEBURYX_DEV_DATABASE_APP_ROLE=<role name>
```

- A non-empty value in the environment wins over the file's: `NEBURYX_DEV_DATABASE_APP_ROLE=other pnpm dev` uses `other`.
- The file is required. If it is missing, if a key is in neither the file nor the environment, if the file holds a key the tool does not know, or if its mode is wider than `0600`, `pnpm dev` stops before it builds or starts anything and says which. It never falls back to anything else, and it never prints a value from the file.
- The env file in `NEBURYX_DEV_MAPPING_ENV` has the same mode rule. What it may hold, and what the tool refuses, is in [`tools/dev/README.md`](../tools/dev/README.md).

## Set up the Postgres once

The database and the two logins must exist first. [`tools/dev/external-postgres.sql`](../tools/dev/external-postgres.sql) creates a database `neburyx_dev`, a migration login that owns it and an app login, with the passwords as `psql` variables:

```bash
psql -v ON_ERROR_STOP=1 -v migration_password=… -v app_password=… -f tools/dev/external-postgres.sql
```

It needs a login to run it that is a superuser or has the `CREATEROLE` and `CREATEDB` attributes (the file grants that login the right to set the role of the new migration login, which Postgres 16 requires to give it the database); the product itself needs no superuser. The data on your Postgres is never removed by this tool.

Give the connection strings and the mapping's `uri` an address rather than a name that takes a while to resolve: the API's readiness check allows 2 seconds, and a `.local` name can take about 5 seconds to resolve on macOS.

## Start

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev`:

1. reads and checks the settings file;
2. builds the contracts, the enterprise packages, the API and the web app;
3. migrates the database with the migration login;
4. runs the API with the app login and the logins of your mapping, and the web dev server, with their compilers in watch mode.

To run the AI preview, set `NEBURYX_PROFILE=enterprise` in your shell and the preview settings in your mapping file ([Switch the AI preview on](ai-preview.md)): the command then loads the enterprise code (built in step 2) and applies the migrations of the preview. Set neither and it starts as a Community build.

It prints the addresses. Open the web app one; `GET /v1/sources` on the API lists the sources of your mapping. A change to a source file of the contracts, the API or the web app reaches the running app without restarting the command. The command does not check that the source login is read-only; use `test-source` for that (see the repository's `CLAUDE.md`).

## Stop

- Ctrl-C stops the API, the web server and the compilers. Nothing else was started, so nothing is left behind.
- Only one copy runs at a time on a machine, from any checkout: a lock in the temporary folder refuses a second copy and names the checkout and the process. If it says the lock cannot be read, or a takeover was under way and none is, delete the file or folder it names.

## If you used an earlier version

Earlier versions of `pnpm dev` started demo containers (the Docker Compose project `neburyx-dev`) and kept generated passwords in a `.env` in the repository root. Neither is used any more, and the command no longer removes them. If you have them, remove the project's containers and volumes with Docker's own commands (they carry the label `com.docker.compose.project=neburyx-dev`), and delete the old `.env` and `.dev` folder in the repository root.

## Checks that go with it

`pnpm test` includes a check that the root `.env.example` lists exactly the environment variables the API reads, each with a description. The tool itself is in `tools/dev`.
