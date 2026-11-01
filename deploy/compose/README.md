# deploy/compose

The Community install: the Neburyx image and a Postgres container, reachable only from this machine.

```bash
cd deploy/compose
cp .env.example .env     # then put three random passwords in it
docker compose up --wait
```

- `db` is the official Postgres image. Its first start creates the database `neburyx`, a migration role
  that owns it and an app role.
- `migrate` runs `neburyx migrate` with the migration role and exits. `api` starts only after it has
  finished successfully, and connects with the app role. The `api` service never sees the migration
  password.
- The API is published on `127.0.0.1` only (port 8080, or `NEBURYX_PORT`); Postgres is not published. The
  app has no sign-in yet, so do not change the published address.
- To upgrade, set `NEBURYX_TAG` to the new tag and run `docker compose up --wait` again. Migrations run
  before the API starts.
- `docker compose up` stops with a message naming any password that is not set.
