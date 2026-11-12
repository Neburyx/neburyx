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
| `NEBURYX_PROFILE` | unset (`community`) | `enterprise` switches the Enterprise and AI code path on, but only together with `ai.preview: true` in the mapping file; the server refuses to start when only one of the two is set, and for any other value |
| `NEBURYX_CURSOR_KEY` | unset | Key that signs page cursors: base64 text of at least 32 random bytes (`openssl rand -base64 32`). Unset, the API makes a key for the process and logs one warning: cursors then do not survive a restart and are not valid across API copies, so set it for any deployment that restarts or runs more than one copy. A key that is set and is not valid stops the start with `invalid configuration: NEBURYX_CURSOR_KEY`. The key is never logged |
| `NEBURYX_EXPORT_DIR` | `/data/exports` | Where export files are kept: an absolute path to a directory this process can write. It is created with mode 0700 if missing; a directory that other accounts can read, a file, or one the process cannot write stops the start with `invalid configuration: NEBURYX_EXPORT_DIR` and the problem. Files are written with mode 0600 and are never served by path |
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
200 `{ "status": "ready", "checks": { "database": "ok", "migrations": "ok" }, "sources": { "reachable": 1, "unreachable": 0, "unknown": 0 } }` when the API can reach
Postgres and every migration it ships has been applied, and 503 with `"status": "not_ready"` otherwise
(`database`: `unreachable`; `migrations`: `pending` or `unknown`). It asks Postgres on each call and gives up
after 2 seconds. `sources` counts the configured sources by what the last ping of each found: it is information and never changes the status, so a source that is down does not take the API out of a load balancer; it names no source, because the probe is public (`GET /v1/sources` has the state of each one). The count comes from a cache and the probe never reads a source. A response never carries a connection string, host, user or file name. The API sees which
migrations are applied through a function that `neburyx migrate` creates and grants to the app role; the
migration history tables stay closed to it.

**Jobs.** Background tasks run inside the API process, on graphile-worker and the same Postgres. The tasks the API
registers are listed in `src/jobs/tasks.ts` (none yet); each has a name, a handler and an optional cron
schedule. With no task registered the API opens no queue connection. On shutdown the runner stops taking
jobs and waits for the running one within the API's shutdown limit. A failed job is retried by
graphile-worker's defaults; the API's log names the failed task and never the job's payload or error text.
Two tasks with the same name, or a schedule that is not a cron expression, stop start-up with a message
naming the task.

**The Neo4j adapter.** `src/sources/` is the only production code that imports `neo4j-driver`. `createNeo4jExecutor` builds the
gate's read executor from the validated mapping: one connection pool per source, created on the first call and sized by the
source's budgets, with encryption decided by the scheme of its address. Credentials are read at the first call from the
environment variables the mapping names. A call answers `rows` (never more than the row limit), `timeout`, or
`unavailable`; any other driver error is thrown without the query, a parameter or a row in it. Sessions use read access
mode and every read runs in an explicit read transaction; Neo4j does not promise to reject a write sent that way, so the
source's own privileges and the fixed read templates matter too.

**Read slots.** Every read of a source takes two slots before it runs: one of the user's slots on that source
(`user_concurrency`, default 2, at most 8), then one of the source's slots (`source_concurrency`, default 32, at most 256,
set to what the customer's Neo4j can carry). One wait covers both: `queue_wait_ms` (default 2,000, at most 5,000), never longer
than the time left to the request's deadline. A read that has no slot within the wait answers `SOURCE_BUSY` (503, retryable) and
nothing is read; a read that got its user's slot and not the source slot gives the user's slot back. Waiting reads are served
in the order they came. The slots live in the API process (`src/seams/read-slots.ts`, behind the gate's coordinator); each
process that builds a gate has its own, so a `test-source` run has slots of its own, apart from the running server's.

**Circuit breaker.** Behind the read slots, a breaker per source opens when `breaker_failures` (default 5, 1 to 100) reads time out within `breaker_window_ms` (default 60,000) and stays open for `breaker_cooldown_ms` (default 30,000; both times 1,000 to 600,000 ms); an open breaker refuses a read before it asks for a slot with `SOURCE_UNAVAILABLE`, the reason `repeated-timeouts` and a retry-after, then one trial read decides. See [docs/circuit-breaker.md](../../docs/circuit-breaker.md).

One read is one of these, and takes one pair of slots: a search group or one more page of it (exact, related, evidence, or the
starts-with group of a type-ahead search, which has no more pages); the facet read; an entity load; a degree preview that is not answered from the cache (a cached one reads
nothing and takes no slot); one expansion, for all its neighbor types, whose pages are read one after another under the one
lease; and the schema read the product makes for a search, an entity load, a preview or an expansion. A request never asks for a
slot while it holds one: its schema read ends before its data read asks. A search reads its first group alone and then up to three
reads at once (the other groups and the facet read, or the starts-with read of a type-ahead search), so with `user_concurrency` 2
one of them waits for a slot. The facet read is the heaviest single read: up to 50 count probes in one read, about 42 ms for the
server to compile each probe (measured on the demo graph), and an evidence branch that reads every relationship carrying the
value. The product's own reads (schema reads, pings, start-up and first-contact checks) take source slots and not a user's slot.
The write probe of `test-source --write-probe` is not a read through the gate and takes no slot.

A read keeps its slots until its connection is back: the answer is sent as soon as the rows are in, and the slots are freed when
the session has closed, or the close was given up after the source's `timeout_ms` (logged as `source.cleanup_slow`). The connection
pool holds twice `source_concurrency` connections, one running and one closing for each slot (the next page of an expansion starts
while the session of the page before is still closing), so a read that has its slots does not wait for a connection; after a
close that was given up, the pool is the backstop. A lease whose release is lost frees itself after the time left to the request's deadline plus the source's
`timeout_ms`.

**Request rate.** Apart from the slots, a person may make `requests_per_minute` requests to a source in any 60 seconds
(default 120, a whole number from 1; a source sets its own in `budgets`). The window slides: it holds the time of each request
that was admitted in the last 60 seconds. The request over the limit answers `RATE_LIMITED` (429, retryable) before anything is
read, with `details.retryAfterMs`, the time until the oldest counted request is 60 seconds old, and a `Retry-After` header in
whole seconds; a request sent after that wait is admitted. A refused request is not counted, so waiting that long is always
enough. It paces and never caps: nothing is counted over a day or a session. The count is kept per person and per source in the
API process, so each process that serves requests has its own, and a restart empties it. These nine requests count, one each
however many reads they make: opening an entity (by path or by lookup), a search and each further page of one, a degree preview,
the coverage count, an expansion, opening an investigation, and `POST /v1/sources/:id/test`. A request counts once the person is
known to be allowed to read the source and its body is valid, so an unknown source, a source the person may not read and a
malformed request answer as they did and are not counted. The list of investigations, an investigation read, the person, the
sources and their profiles, the health probes and the product's own reads (schema reads, pings, start-up checks, the
`test-source` command) are not counted. Changing `requests_per_minute` changes the source's `configHash`, as every budget does.

**Neo4j tests.** `pnpm test:neo4j` runs the `*.neo4j.test.ts` files against a Neo4j Enterprise 5.26 server that you own, not in CI
(`packages/test-neo4j/README.md` has the three variables, the login it needs and what the tests create). Each file makes
its own database and drops it. Sources are read with a login of the run that can only read that database, so a report
says what it says for a read-only login. Without the variables the command fails and names them; it never skips. Neo4j
2026 and the Community edition are not tested.
