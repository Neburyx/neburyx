# tools/dev

The command behind `pnpm dev`. It is a developer tool: it runs other programs with argument lists (never a shell) and imports nothing from the product. It starts no container and never calls Docker. How to use it is in [docs/run-locally.md](../../docs/run-locally.md).

- `src/config.ts`: reads the settings file (`NEBURYX_DEV_CONFIG`, or `~/.config/neburyx/dev.env`), lets the environment win, and refuses a missing file, a missing or unknown key and a mode wider than `0600`.
- `src/mapping.ts`: the checks of the env file that holds the source logins.
- `src/external.ts`: the three database settings.
- `src/up.ts`: the steps of the command: check the settings, take the lock, build, migrate, supervise.
- `src/environments.ts`: the short environment each child gets. The API never receives the migration login.
- `src/lock.ts`: the machine-wide lock; `src/supervisor.ts` restarts the API when its build output changes and tells a start that never becomes ready from a crash after it was ready.
- `external-postgres.sql`: the statements that set up the Postgres.

## What it refuses

Before it takes the lock, builds or starts anything, the command stops with a message that names the problem when:

- the settings file is missing, or `NEBURYX_DEV_CONFIG` is not an absolute path, or there is no `HOME` to find the default file;
- a key of `NEBURYX_DEV_MAPPING`, `NEBURYX_DEV_MAPPING_ENV`, `NEBURYX_DEV_DATABASE_URL`, `NEBURYX_DEV_DATABASE_MIGRATION_URL` or `NEBURYX_DEV_DATABASE_APP_ROLE` is in neither the file nor the environment, or has an empty value;
- the file holds a key that is not one of those five;
- the file's mode is wider than `0600` (run `chmod 600` on it; a symlink is judged by the file it points to);
- a path is not absolute or the file it names is missing, or the env file's mode is wider than `0600`, it holds no settings, it gives a variable an empty value, or it sets a name the tool sets itself (`PATH`, `HOME`, `TMPDIR`, `LANG`, `NODE_*`, `DATABASE_*`, `NEBURYX_*`).

No message holds a value read from the settings file or the env file; they name the file's path or the key. Nothing is written to disk by the tool.

## What it runs

- Only the API process gets the values of the env file, never the compilers, the web server or the migration. They are not printed or written anywhere.
- The migration gets the migration login and the app role and nothing else. The API gets the app login, the mapping, the source logins and a cursor key made at random once per run.
- The `sources:` line it prints says the sources are those of your mapping. The command does not check that their logins are read-only; use `test-source` for that (see the repository's `CLAUDE.md`).

The env file is read as `NAME=value` lines: the value is everything after the first `=`, trimmed, with one pair of matching quotes removed; a `#` starts a comment only at the start of a line (`PASS=abc # note` makes the value `abc # note`); a line without `=` is skipped; an `export ` prefix is not accepted. The settings file is read the same way.

Give a source's `uri` an IP address rather than a name that takes a while to resolve: by default a read waits at most 2 seconds (`queue_wait_ms`) for a connection to the source, opening it included, and a `.local` name can take longer on macOS.
