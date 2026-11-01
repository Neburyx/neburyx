# services/api

Backend API (TypeScript on Node, Fastify). Pre-release: it serves the built web app, answers
`GET /v1/me` and answers unknown `/v1` paths with 404.

Configuration comes from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `NEBURYX_HOST` | `127.0.0.1` | Address to listen on (an IP address or a host name). A non-loopback address outside a container logs a warning |
| `NEBURYX_PORT` | `8080` | Port to listen on (1 to 65535) |
| `NEBURYX_WEB_ROOT` | `apps/web/dist` in the repo | Folder of the built web app; it must hold a readable `index.html` |
| `NEBURYX_CONFIG` | unset | Path of the `neburyx.yaml` mapping. When set, the file is read and checked at start-up and the server stops with a message naming the problem and its place in the file if it is invalid. The file is a strict subset of YAML 1.2: block or flow mappings, sequences and scalars; plain, single-quoted and double-quoted strings; and comments. Refused, with the line and column and never the value: a directive other than `%YAML 1.2`, tags, anchors, aliases, merge keys, block scalars, keys that are not plain text, duplicate keys, more than one document, and any parser error or warning. When unset, the server starts with no sources |
| `DATABASE_URL` | required | Postgres connection string of the app role (`postgres://` or `postgresql://`) |
| `NEBURYX_CONTAINER` | unset | Set to `true` inside a container so the exposure warning is skipped |

A start-up failure prints a message that names the variable, never its value, and exits 1.

**Errors.** Every failed request answers in the shape defined in `packages/contracts`:
`{ "error": { "code", "message", "retryable", "traceId", "details"? } }`. The message is the fixed
text of the code; text carried by a thrown error is never sent. A route throws `AppError` with a
code (and optional `details` with the fields that code allows).

**Tracing and logs.** Every response carries an `X-Trace-Id` header, equal to `traceId` in an error
body. Logs are JSON, carry the same ID, and hold no request data: no query string, body, headers,
path values or error text.

**Database.** `neburyx migrate` (built to `dist/cli.js`) creates or upgrades the Postgres database from
the plain SQL files in `migrations/` and installs the job queue's tables. It takes the migration
role's connection string in `DATABASE_MIGRATION_URL` and the name of the role the API will use in
`DATABASE_APP_ROLE`, which it grants ordinary read and write rights on the tables and nothing
structural. Several copies can run at once; they take turns. See `migrations/README.md` for how to
add a migration. The API itself never reads `DATABASE_MIGRATION_URL`.

**First start.** The API needs a database that `neburyx migrate` has already prepared. On start it
creates the single `deployment` row (edition `community`, identity mode `none`) and the `local`
administrator user if they are missing, and leaves them alone afterwards; copies that start at the
same time agree on one of each. It exits 1 with `the database could not be reached` or
`the database has not been migrated` when it cannot do that, and prints nothing else about the
connection.

**`GET /v1/me`** returns the calling principal (`id`, `displayName`, `role`), the `edition`, the
`identityMode` and the permitted `sources` (an empty list for now). The response schema is in
`packages/contracts/openapi.json`. A database error answers `INTERNAL_ERROR`.

**Commands.** `dist/cli.js` runs `api` (the default) or `migrate`. In the container image these are
the two ways to start it (`docker run … neburyx api`, `docker run … neburyx migrate`); see
`deploy/docker/README.md`. The `api` command stops cleanly on `SIGTERM` and `SIGINT`.

**Probes.** `GET /healthz` answers `{ "status": "ok" }` while the process runs. `GET /readyz` answers
200 `{ "status": "ready", "checks": { "database": "ok", "migrations": "ok" } }` when the API can reach
Postgres and every migration it ships has been applied, and 503 with `"status": "not_ready"` otherwise
(`database`: `unreachable`; `migrations`: `pending` or `unknown`). It asks Postgres on each call and gives up
after 2 seconds. A response never carries a connection string, host, user or file name. The API sees which
migrations are applied through a function that `neburyx migrate` creates and grants to the app role; the
migration history tables stay closed to it.

**Jobs.** Background tasks run inside the API process, on graphile-worker and the same Postgres. The tasks the API
registers are listed in `src/jobs/tasks.ts` (none yet); each has a name, a handler and an optional cron
schedule. With no task registered the API opens no queue connection. On shutdown the runner stops taking
jobs and waits for the running one within the API's shutdown limit. A failed job is retried by
graphile-worker's defaults; the API's log names the failed task and never the job's payload or error text.
Two tasks with the same name, or a schedule that is not a cron expression, stop start-up with a message
naming the task.
