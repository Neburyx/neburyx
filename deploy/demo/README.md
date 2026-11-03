# deploy/demo

A compose setup that runs Neburyx against two synthetic demo graphs, one for each domain pack (`banking-fraud` and `insurance-claims`), so that you can evaluate the product without a graph of your own. It uses synthetic data only.

```bash
docker build -f deploy/docker/Dockerfile -t neburyx .   # from the repository root: there is no published image yet
cd deploy/demo
cp .env.example .env     # then fill in the passwords and the cursor key (the file says how)
docker compose up --wait
```

Open `http://127.0.0.1:8080`. `GET /v1/sources` lists the two demo sources, each `connected` and `synthetic`.

- **What starts.** Postgres and the product (the same services as `deploy/compose`, reused rather than copied), two Neo4j Community containers (one per pack), a loader for each that builds the demo graph with `tools/demo-graph`, and a step that writes the one mapping file the API reads from the packs' own files. The API starts only after the migration, the mapping step and both loaders have finished.
- **Loopback only.** Only the API is published, on `127.0.0.1` (port 8080, or `NEBURYX_PORT`). Neo4j and Postgres publish nothing. The app has no sign-in yet, so do not change the published address.
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
