# deploy/compose

The Community install: the Neburyx image and a Postgres container, reachable only from this machine.

```bash
cd deploy/compose
cp .env.example .env     # then put three random passwords and the cursor key in it
cp config/neburyx.example.yaml config/neburyx.yaml
docker compose up --wait
```

Instead of `cp .env.example .env` and filling it in, write a complete `.env` with random values in one step (the tag `local` is what `docker build -f deploy/docker/Dockerfile -t neburyx:local .` makes, from the repository root, until an image is published):

```bash
[ -e .env ] && echo ".env exists; not overwritten" || ( umask 077; cat > .env <<EOF
NEBURYX_DB_ADMIN_PASSWORD=$(openssl rand -hex 24)
NEBURYX_DB_MIGRATION_PASSWORD=$(openssl rand -hex 24)
NEBURYX_DB_APP_PASSWORD=$(openssl rand -hex 24)
NEBURYX_CURSOR_KEY=$(openssl rand -base64 32)
NEBURYX_TAG=local
EOF
)
```

The command refuses to touch a `.env` that already exists: Postgres sets its role passwords only when its volume is first made, so new passwords written over a running install would lock the app out of its own database, and a new cursor key would make open pages say "Start again". Changing a password after the first start is not done by this command. Never commit `.env`. If `docker compose up` stops at a service named after a setting, such as `NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes`, that setting breaks the rule in the name; `docker compose logs` on that service says how to make a valid one.

- `db` is the official Postgres image. Its first start creates the database `neburyx`, a migration role
  that owns it and an app role.
- `migrate` runs `neburyx migrate` with the migration role and exits. `api` starts only after it has
  finished successfully, and connects with the app role. The `api` service never sees the migration
  password.
- Export files are kept in the `neburyx-exports` volume, mounted at `/data/exports` (the image creates it for the `node` user with mode 0700). Set `NEBURYX_EXPORT_DIR` to keep them elsewhere. `docker compose down -v` removes them with the database.
- The API is published on `127.0.0.1` only (port 8080, or `NEBURYX_PORT`); Postgres is not published. The
  app has no sign-in yet, so do not change the published address.
- **Your mapping.** The `api` service reads the mapping file `config/neburyx.yaml` (next to `compose.yaml`; git ignores it), mounted read-only at `/etc/neburyx`. The shipped `config/neburyx.example.yaml` holds no sources. To keep your mapping elsewhere, set `NEBURYX_CONFIG_DIR` to that folder; the file in it must be called `neburyx.yaml`. Without the file the `api` service stops and names it.
- **Your source's login.** The mapping names the variables of each login (`auth.username_env`, `auth.password_env`). Put them in a file named `source.env` next to `.env`, mode `0600`, never committed. The file is optional and needs Docker Compose 2.24 or later; `docker compose config` prints its values, so do not share that output. See [docs/install.md](../../docs/install.md).
- To upgrade, set `NEBURYX_TAG` to the new tag and run `docker compose up --wait` again. Migrations run
  before the API starts.
- `NEBURYX_CURSOR_KEY` signs page cursors. Make one with `openssl rand -base64 32`, keep it in `.env` (never commit it) and keep the same key across restarts, so a page a person has open can still load its next page after the API restarts. `docker compose up` stops with a message naming the key if it is not set, and the API refuses a key that is not base64 of at least 32 bytes.
- `docker compose up` stops with a message naming any password or the key that is not set.
