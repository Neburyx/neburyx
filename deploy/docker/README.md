# deploy/docker

The container image: one image that holds the API, the built web app, the `migrate` command, the `test-source` command and the `source rebind` command.

Build it from the repository root:

```bash
docker build -f deploy/docker/Dockerfile -t neburyx .
```

Start it with one of four commands (`api` is the default):

```bash
docker run --rm -e DATABASE_MIGRATION_URL=… -e DATABASE_APP_ROLE=… neburyx migrate
docker run --rm -p 127.0.0.1:8080:8080 -e DATABASE_URL=… neburyx api
docker run --rm -e DATABASE_URL=… -e NEBURYX_CONFIG=… -v …:… neburyx test-source --name <source> [--write-probe]
docker run --rm -e DATABASE_URL=… -e NEBURYX_CONFIG=… -v …:… neburyx source rebind <source> --confirm <source>
```

- `test-source` tests one configured source as the local identity and prints the server version, whether it is supported, a summary of the mapping, whether the login can write (from its privileges where the server lists them, otherwise "not verified") and whether the mapping fits the source: the labels, relationship types, indexes and stable ids it names must exist, and a failure is exit `1`. It also prints, for each entity type that has a mapped relationship, whether the server counts its neighbors from the degree of the node (cheap), by expanding (not cheap) or in a way it could not tell, and the server version that was found on; these results never change the outcome. When the API starts, a mapping that does not fit a source it can reach stops the start with a message that names the problem; a source that is down at the start is checked when it first answers, and a failing check marks it unavailable with the reason. A finding refuses no read by itself: what it does not name is read as usual, and a missing or unready index refuses only the reads that need it. It exits `0` for pass and warn, `1` for fail and for a configuration or database problem, and `2` for a usage error or a source name that is not configured. It needs the same `DATABASE_URL` and mapping file as the API, the credentials the mapping names, and an API that has started once. With `--write-probe` it also opens a write transaction on the source, runs one statement that creates an empty node, and rolls the transaction back, to confirm that a login cannot write; use it in a test environment, never against a source you cannot afford to touch. It prints a line on stderr before it does.
- `source rebind` confirms a source that was pointed at another database on purpose, so that its investigations open normally again. It needs a `test-source` run on the new connection first, reads nothing from the source and prints no address or login; see [docs/source-rebind.md](../../docs/source-rebind.md).
- The image holds no credentials and no `neburyx.yaml`. Settings arrive as environment variables;
  the configuration file is mounted. It runs as the unprivileged `node` user and stops cleanly on
  `SIGTERM` and `SIGINT`.
- The API listens on `0.0.0.0:8080` inside the container. Publish the port on `127.0.0.1` only, as
  above: the app has no sign-in yet.
- `pnpm test:image` builds the image and checks it with a Postgres container (it needs Docker and
  takes a few minutes). CI also builds it for `linux/amd64` and `linux/arm64`:
  `docker buildx build --platform linux/amd64,linux/arm64 -f deploy/docker/Dockerfile --output type=oci,dest=neburyx.oci.tar .`
  then `node deploy/docker/check-platforms.mjs neburyx.oci.tar`.
