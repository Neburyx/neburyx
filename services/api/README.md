# services/api

Backend API (TypeScript on Node, Fastify). Pre-release: it serves the built web app and answers
unknown `/v1` paths with 404; it has no endpoints yet.

Configuration comes from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `NEBURYX_HOST` | `127.0.0.1` | Address to listen on (an IP address or a host name). A non-loopback address outside a container logs a warning |
| `NEBURYX_PORT` | `8080` | Port to listen on (1 to 65535) |
| `NEBURYX_WEB_ROOT` | `apps/web/dist` in the repo | Folder of the built web app; it must hold a readable `index.html` |
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
