# deploy/demo

A compose setup that runs Neburyx against two synthetic demo graphs, one for each domain pack (`banking-fraud` and `insurance-claims`), so that you can evaluate the product without a graph of your own. It uses synthetic data only.

```bash
docker build -f deploy/docker/Dockerfile -t neburyx .   # from the repository root: there is no published image yet
cd deploy/demo
cp .env.example .env     # then fill in the passwords and the cursor key (the file says how)
docker compose up --wait
```

Instead of `cp .env.example .env` and filling it in, write a complete `.env` with random values in one step:

```bash
[ -e .env ] && echo ".env exists; not overwritten" || ( umask 077; cat > .env <<EOF
NEBURYX_DB_ADMIN_PASSWORD=$(openssl rand -hex 24)
NEBURYX_DB_MIGRATION_PASSWORD=$(openssl rand -hex 24)
NEBURYX_DB_APP_PASSWORD=$(openssl rand -hex 24)
NEBURYX_CURSOR_KEY=$(openssl rand -base64 32)
DEMO_NEO4J_PASSWORD=$(openssl rand -hex 24)
EOF
)
```

The command refuses to touch a `.env` that already exists: Postgres sets its role passwords only when its volume is first made, so new passwords written over a running install would lock the app out of its own database, and a new cursor key would make open pages say "Start again". Changing a password after the first start is not done by this command. Never commit `.env`. If `docker compose up` stops at a service named after a setting, such as `NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes`, that setting breaks the rule in the name; `docker compose logs` on that service says how to make a valid one. The demo's Neo4j password must be at least 8 characters.

Open `http://127.0.0.1:8080`. `GET /v1/sources` lists the two demo sources, each `connected` and `synthetic`.

- **What starts.** Postgres and the product (the same services as `deploy/compose`, reused rather than copied), two Neo4j Community containers (one per pack), a loader for each that builds the demo graph with `tools/demo-graph`, and a step that writes the one mapping file the API reads from the packs' own files. The API starts only after the migration, the mapping step and both loaders have finished.
- **Loopback only.** Only the API is published, on `127.0.0.1` (port 8080, or `NEBURYX_PORT`). Neo4j and Postgres publish nothing. The app has no sign-in yet, so do not change the published address.
- **Memory.** Each Neo4j container is given a fixed 1 GB heap and a 256 MB page cache. The containers of the whole stack together used at most 3,911 MiB and 4,471 MiB at their peak in two runs that sampled every 3 seconds while the graphs were loading and the tests ran; allow more than that for Docker.
- **Synthetic data.** Both graphs hold generated data and each source is flagged `synthetic`. Both Neo4j containers share the login in `.env`.
- **Read-only is not verified here.** Neo4j Community cannot list privileges, so `test-source` reports `Read-only: not verified` for both demo sources, and the demo logins are ordinary logins that can write. The product only reads, but this demo does not prove the login cannot write. A source on a server that lists privileges reports what it found.
- **Check a source.** With the stack running:

  ```bash
  docker compose run --rm --no-deps api test-source --name banking-demo
  docker compose run --rm --no-deps api test-source --name insurance-demo
  ```

  Each prints the server version, the mapping summary, the read-only line and the degree lines for each entity type, and exits `0` for pass and warn. Keep `--no-deps`: without it Compose starts the loaders again, which resets the graphs.
- **Start again.** Loading is for a fresh or a stopped stack: stop it first (`docker compose stop`), then run `docker compose up --wait`. Running `up` on a stack that is already running starts the finished loaders again and resets the graphs under the running API.
- **Rebuild the loader.** The loader image is built from this checkout the first time. After a change to a pack or to `tools/demo-graph`, run `docker compose build` (and then stop the stack and start it again).
- **Remove everything.** `docker compose down -v` removes the containers and the volumes.
