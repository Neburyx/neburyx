# tools/dev

The command behind `pnpm dev` and `pnpm dev:down`. It is a developer tool: it runs other programs with argument lists (never a shell) and imports nothing from the product. How to use it is in [docs/run-locally.md](../../docs/run-locally.md).

- `src/settings.ts`: the five generated settings of `.env`, and the check of an existing file.
- `src/up.ts`: the steps of `dev up` and `dev down`; `src/compose.ts` runs the demo compose file with `deploy/demo/compose.dev.yaml`.
- `src/environments.ts`: the short environment each child gets. The API never receives the administrator or migration password.
- `src/lock.ts`: the machine-wide lock; `src/supervisor.ts` restarts the API when its build output changes and tells a start that never becomes ready from a crash after it was ready.
- `external-postgres.sql`: the statements for pointing the setup at a Postgres you run.
- `src/mapping.ts`: the two settings below, the checks of the env file, and whether a run starts no container.

## Run against a mapping of your own

By default `pnpm dev` loads two synthetic demo graphs. To run the app against a mapping you wrote, for a Neo4j you can reach, set both of these in the shell before `pnpm dev`:

| Variable | Value |
|---|---|
| `NEBURYX_DEV_MAPPING` | the absolute path of the mapping file |
| `NEBURYX_DEV_MAPPING_ENV` | the absolute path of an env file holding the logins the mapping names with `username_env` and `password_env` |

```bash
NEBURYX_DEV_MAPPING=/path/to/mapping.yaml NEBURYX_DEV_MAPPING_ENV=/path/to/logins.env pnpm dev
```

With both set:

- no demo graph container is started or loaded, the demo graph tool is not built, and no mapping is combined; the API's `NEBURYX_CONFIG` is your file. Local Postgres, the API and the web app start as before;
- only the API process gets the values of the env file, never the compilers, the web server, the migration or Docker, and the API gets no demo login. They are not printed or written to `.dev` or to any log;
- the command refuses to start, before it builds or starts anything, if only one of the two is set (it names the missing one), if a path is not absolute or the file is missing, if the env file's mode is wider than 0600 (run `chmod 600` on it; a symlink is judged by the file it points to), if it holds no settings, if it gives a variable an empty value, or if it sets a name the tool sets itself (`PATH`, `HOME`, `TMPDIR`, `LANG`, `NODE_*`, `DATABASE_*`, `NEBURYX_*`, `DEMO_NEO4J_*`);
- with the three `NEBURYX_DEV_DATABASE_*` settings too (see [docs/run-locally.md](../../docs/run-locally.md)), the command uses no container and no Docker: it makes no `docker` call, builds no image and needs no Docker daemon. Stopping it with Ctrl-C leaves nothing behind. `pnpm dev:down` in that shell removes nothing, makes no connection to any server and says so, because nothing was started; the data on your Postgres is never removed by this tool. If those settings are not all set when you run `pnpm dev:down`, it removes the demo containers of project `neburyx-dev` as before, so unset them in the shell first only if you do want that;
- the `sources:` line it prints says the sources are those of your mapping. The command does not check that their logins are read-only; use `test-source` for that (see the repository's `CLAUDE.md`).

The env file is read as `NAME=value` lines: the value is everything after the first `=`, trimmed, with one pair of matching quotes removed; a `#` starts a comment only at the start of a line (`PASS=abc # note` makes the value `abc # note`); a line without `=` is skipped; an `export ` prefix is not accepted.

Give a source's `uri` an IP address rather than a name that takes a while to resolve: by default a read waits at most 2 seconds (`queue_wait_ms`) for a connection to the source, opening it included, and a `.local` name can take longer on macOS.

With neither set, `pnpm dev` is unchanged.
