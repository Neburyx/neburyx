# deploy/docker

The container image: one image that holds the API, the built web app and the `migrate` command.

Build it from the repository root:

```bash
docker build -f deploy/docker/Dockerfile -t neburyx .
```

Start it with one of two commands (`api` is the default):

```bash
docker run --rm -e DATABASE_MIGRATION_URL=… -e DATABASE_APP_ROLE=… neburyx migrate
docker run --rm -p 127.0.0.1:8080:8080 -e DATABASE_URL=… neburyx api
```

- The image holds no credentials and no `neburyx.yaml`. Settings arrive as environment variables;
  the configuration file is mounted. It runs as the unprivileged `node` user and stops cleanly on
  `SIGTERM` and `SIGINT`.
- The API listens on `0.0.0.0:8080` inside the container. Publish the port on `127.0.0.1` only, as
  above: the app has no sign-in yet.
- `pnpm test:image` builds the image and checks it with a Postgres container (it needs Docker and
  takes a few minutes). CI also builds it for `linux/amd64` and `linux/arm64`:
  `docker buildx build --platform linux/amd64,linux/arm64 -f deploy/docker/Dockerfile --output type=oci,dest=neburyx.oci.tar .`
  then `node deploy/docker/check-platforms.mjs neburyx.oci.tar`.
