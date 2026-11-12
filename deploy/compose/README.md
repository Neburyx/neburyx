# deploy/compose

The Community install: the Neburyx image and a Postgres container, reachable only from this machine.

The tag `local` that the command below sets is what `docker build -f deploy/docker/Dockerfile -t neburyx:local .` makes, from the repository root. To use the published image instead, skip the build and set `NEBURYX_IMAGE=ghcr.io/neburyx/neburyx` and `NEBURYX_TAG=0.1.0` in `.env` in place of `NEBURYX_TAG=local`.

```bash
cd deploy/compose
[ -e .env ] && echo ".env exists; not overwritten" || ( umask 077; cat > .env <<EOF
NEBURYX_DB_ADMIN_PASSWORD=$(openssl rand -hex 24)
NEBURYX_DB_MIGRATION_PASSWORD=$(openssl rand -hex 24)
NEBURYX_DB_APP_PASSWORD=$(openssl rand -hex 24)
NEBURYX_CURSOR_KEY=$(openssl rand -base64 32)
NEBURYX_TAG=local
EOF
)
cp config/neburyx.example.yaml config/neburyx.yaml
docker compose up --wait
```

The command that writes `.env` refuses to touch a `.env` that already exists: Postgres sets its role passwords only when its volume is first made, so new passwords written over a running install would lock the app out of its own database, and a new cursor key would make open pages say "Start again". Changing a password after the first start is not done by this command. Never commit `.env`.

If `up` stops with an error that names a service after a setting, for example `service "NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes" didn't complete successfully`, run `docker compose logs NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes` with that service's name: it says what is wrong with the setting and how to make a valid one.

To fill in `.env` by hand instead of the command above, run `cp .env.example .env` and `chmod 600 .env`, put three random passwords and the cursor key in it, and set `NEBURYX_TAG=local`, the tag that the build above makes.

- `db` is the official Postgres image. Its first start creates the database `neburyx`, a migration role
  that owns it and an app role.
- `migrate` runs `neburyx migrate` with the migration role and exits. `api` starts only after it has
  finished successfully, and connects with the app role. The `api` service never sees the migration
  password.
- The Community stack runs as it is. To switch the AI preview on, set `NEBURYX_PROFILE=enterprise` in `.env`: the compose file passes it to the `api` **and** the `migrate` services, and both read the same `config/neburyx.yaml` (the `migrate` service has the mapping mounted too, so that it applies the enterprise migrations). `NEBURYX_PROFILE=enterprise` together with `ai.preview: true` in `config/neburyx.yaml` switches the AI preview on; with only one of the two the `migrate` service stops first and says which is missing, and the `api` service never starts. A mapping that is missing or invalid stops `migrate` the same way. The same `.env` also takes `NEBURYX_AI_CACHE` and `NEBURYX_AI_CACHE_TTL` (prompt caching of the AI preview, see [Switch the AI preview on](../../docs/ai-preview.md)), `NEBURYX_DATABASE_CONNECT_TIMEOUT_MS` and `NEBURYX_READINESS_LIMIT_MS`; each is optional, and an empty value counts as not set.
- Export files are kept in the `neburyx-exports` volume, mounted at `/data/exports` (the image creates it for the `node` user with mode 0700). Set `NEBURYX_EXPORT_DIR` to keep them elsewhere. `docker compose down -v` removes them with the database.
- The API is published on `127.0.0.1` only (port 8080, or `NEBURYX_PORT`); Postgres is not published. The
  app has no sign-in yet, so do not change the published address.
- **Your mapping.** The `api` service reads the mapping file `config/neburyx.yaml` (next to `compose.yaml`; git ignores it), mounted read-only at `/etc/neburyx`. The shipped `config/neburyx.example.yaml` holds no sources. To keep your mapping elsewhere, set `NEBURYX_CONFIG_DIR` to that folder; the file in it must be called `neburyx.yaml`. Without the file the `api` service stops and names it.
- **Your source's login.** The mapping names the variables of each login (`auth.username_env`, `auth.password_env`). Put them in a file named `source.env` next to `.env`, mode `0600`, never committed. The file is optional and needs Docker Compose 2.24 or later; `docker compose config` prints its values, so do not share that output. See [docs/install.md](../../docs/install.md).
- To upgrade, set `NEBURYX_TAG` to the new tag and run `docker compose up --wait` again. Migrations run
  before the API starts.
- `NEBURYX_CURSOR_KEY` signs page cursors. Make one with `openssl rand -base64 32`, keep it in `.env` (never commit it) and keep the same key across restarts, so a page a person has open can still load its next page after the API restarts. `docker compose up` stops with a message naming the key if it is not set, and the API refuses a key that is not base64 of at least 32 bytes.
- `docker compose up` stops with a message naming any password or the key that is not set.
