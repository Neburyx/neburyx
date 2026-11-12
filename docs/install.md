# Install Neburyx Community

This guide installs Neburyx Community on your own machine with Docker Compose, connects it to your own Neo4j with a read-only login, and covers the operations that follow: rotating a login, retention, upgrading and rolling back. To try it first with no graph of your own, use the [demo environment](../deploy/demo/README.md).

Every command runs from `deploy/compose` in the repository unless it says otherwise.

## What you need

- Docker with Docker Compose 2.24 or later (`docker compose version`). The settings files in this guide are optional files, which older Compose versions refuse.
- A Neo4j 5 server and a login for it (see [Connect your Neo4j](#connect-your-neo4j)).
- Port 8080 free on this machine, or another port that you set as `NEBURYX_PORT`.
- A mapping file that describes your graph. [The domain packs](../domain-packs/README.md) explain how to write one.

Get the repository's files:

```bash
git clone https://github.com/Neburyx/neburyx neburyx
cd neburyx
```

The image is published as `ghcr.io/neburyx/neburyx`. To use it, skip the build below and, in the next section, set `NEBURYX_IMAGE=ghcr.io/neburyx/neburyx` and `NEBURYX_TAG=0.1.0` in `.env` in place of `NEBURYX_TAG=local`. Or build the image from the repository, from its root:

```bash
docker build -f deploy/docker/Dockerfile -t neburyx:local .
```

You set the tag `local` as `NEBURYX_TAG` in the next section. Each version you build later gets its own tag.

## Install

1. Make the mapping file:

   ```bash
   cd deploy/compose
   cp config/neburyx.example.yaml config/neburyx.yaml
   ```

   Git ignores it, so your mapping is never committed.

2. Write the settings file. This one command makes `.env` with random passwords and a cursor key, and sets the tag `local` that the build step above makes:

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

   The command refuses to touch a `.env` that already exists: Postgres sets its role passwords only when its volume is first made, so new passwords written over a running install would lock the app out of its own database, and a new cursor key would make open pages say "Start again". Changing a password after the first start is not done by this command. Never commit `.env`.

   To fill it in by hand instead of the command above, run `cp .env.example .env` and `chmod 600 .env`, then make the values with `openssl rand -hex 24` (run it three times, one for each password; letters and digits only, because the passwords are put into connection strings) and `openssl rand -base64 32` (the cursor key). Set `NEBURYX_TAG=local` as well, if that is the tag you built.

   The cursor key signs the cursors of paged lists. Keep the same key across restarts: with it, a page that a person has open can still load its next page after the API restarts; without it, that page says "Start again". Never commit it.

3. Start it:

   ```bash
   docker compose up --wait
   ```

   `up` stops before the database or the app starts if a password or the cursor key is missing or breaks its rule: the error at the end of its output names the service that failed. If `up` stops with an error that names a service after a setting, for example `service "NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes" didn't complete successfully`, run `docker compose logs NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes` with that service's name: it says what is wrong with the setting and how to make a valid one.

4. Check that it is ready:

   ```bash
   curl http://127.0.0.1:8080/readyz
   ```

   It answers `{"status":"ready",…}`. Open `http://127.0.0.1:8080` in a browser. With the `sources: []` mapping you copied there are no sources yet; the next sections add one.

## Loopback only

The install publishes the API on `127.0.0.1` only: other machines cannot reach it, and Postgres publishes nothing. The app has no sign-in yet, so **do not change the published address**. Neburyx cannot see how Docker publishes its port, so it cannot warn you if you change it.

Confirm it:

```bash
docker compose port api 8080
```

It prints `127.0.0.1:8080` (or your `NEBURYX_PORT`). Any other address, such as `0.0.0.0`, means the app is open to your network: run `docker compose down`, put the compose file back as shipped and start again.

## Connect your Neo4j

A source is one Neo4j database, named in the mapping file. Neburyx reads it and never writes to it.

### The mapping file

Edit `config/neburyx.yaml`, or keep your mapping in another folder and set `NEBURYX_CONFIG_DIR` in `.env` to that folder; the file in it must be called `neburyx.yaml`. The folder is mounted read-only. [The domain packs](../domain-packs/README.md) describe how to write the mapping. This is the smallest one that loads:

```yaml
sources:
  - id: my-graph
    uri: "bolt://neo4j.internal.example:7687"
    database: neo4j
    auth: { kind: basic, username_env: MY_GRAPH_USER, password_env: MY_GRAPH_PASSWORD }
    entities:
      - type: account
        label: Account
        stable_id: accountId
```

- `uri` is read **inside the `api` container**. `localhost` there is the container, not your machine. Give an address that the container can reach, and give an address, not a name that is slow to resolve (see [The readiness limit](#the-readiness-limit)).
- The login is never in the mapping. `username_env` and `password_env` name two variables, which you set in the next step.

### The source login

Put the two variables in a file named `source.env` next to `.env`:

```bash
cat > source.env <<'EOF'
MY_GRAPH_USER=neburyx_reader
MY_GRAPH_PASSWORD=replace-with-the-password
EOF
chmod 600 source.env
```

Never commit it (git ignores it). `docker compose config` prints the values of this file once it exists, so never paste or share its output. Apply the change:

```bash
docker compose up --wait
```

`GET /v1/sources` on the API lists the source. If `source.env` is missing, or a variable it needs is not set, the API still starts, logs `source.credentials_missing` for that source and does not read it.

### A login that can only read

Give Neburyx a login that can read and nothing else. On a Neo4j that has roles, that is a role with access to the database, the right to traverse and read its graph, and the rights to list its indexes and constraints so the index checks can run. A Neo4j administrator makes it with the statements below, run on the Neo4j server in the database `system`. They grant read privileges only (replace `<database>` and the password):

```
CREATE ROLE neburyx_read_only;
GRANT ACCESS ON DATABASE <database> TO neburyx_read_only;
GRANT MATCH {*} ON GRAPH <database> TO neburyx_read_only;
GRANT SHOW INDEX ON DATABASE <database> TO neburyx_read_only;
GRANT SHOW CONSTRAINT ON DATABASE <database> TO neburyx_read_only;
CREATE USER neburyx_reader SET PASSWORD 'replace-with-the-password' CHANGE NOT REQUIRED;
GRANT ROLE neburyx_read_only TO neburyx_reader;
```

Neburyx never writes, but it does not take the login's word for it: `test-source` checks what the login can do. A login that holds any privilege beyond access, traverse, read, match, execute, load, and listing indexes and constraints is reported as one that can write.

### Check the source

```bash
docker compose run --rm --no-deps api test-source --name my-graph
```

It prints the server version, a summary of the mapping, whether the login can write, whether the mapping fits the source, and how the server counts the neighbors of each entity type. Read the `Read-only:` line:

| Line | What it means |
|---|---|
| `Read-only: privileges inspected` | The server listed the login's privileges and none of them writes. |
| `Read-only: not verified` | The server cannot list privileges, or the list could not be read. Nothing is claimed about the login. |
| `Read-only: write probe` | You ran `--write-probe`, which tries one write in a transaction that is always rolled back. Use it only in a test environment, never on a source you cannot afford to touch. |

The exit code is `0` for pass and warn, `1` for fail (and for a configuration or database problem), and `2` for a usage error or a source name that is not in the mapping.

If it does not work:

| Exit code | What to do |
|---|---|
| `0` | The source passed or warned. Read the `Mapping checks:` lines for any warning. |
| `1` | The check failed, or the configuration or the database could not be read. Read the `Reason:` line: a refused sign-in means the values in `source.env`; an unreachable source means the `uri` (an address the container can reach); a mapping finding names the part of the mapping to fix. |
| `2` | A usage error, or a source name that is not in the mapping file. Check the name after `--name` against the `id` in `config/neburyx.yaml`. |

### What the demo does not verify

The Community demo prints `Read-only: not verified` for both of its sources. Neo4j Community cannot list privileges, and the demo's logins are ordinary logins that can write. The product only reads, but the demo does not prove that a login cannot write, and this guide claims nothing more for it. A source on a server that lists privileges reports what it found.

### The readiness limit

`/readyz` allows 2 seconds for its check of the database, and that includes the time to resolve the host name. A name that is slow to resolve (a `.local` name can take about 5 seconds on macOS) makes `/readyz` report the database unreachable even though it is up. Give the source `uri` and the connection strings an address instead of such a name.

## Rotate a source's login

Rotating the login of a source needs a restart of the `api` container, because it reads the login when it starts.

1. On your Neo4j, create the new login with the same role as the old one (see [A login that can only read](#a-login-that-can-only-read)).
2. Put the new values in `source.env`.
3. Recreate the container: `docker compose up --wait --force-recreate api`.
4. Check it: `docker compose run --rm --no-deps api test-source --name my-graph`. A wrong value shows as `Outcome: fail` with `Reason: The source refused the sign-in.`
5. Only then revoke the old login on your Neo4j.

The cursor key is kept, so a page that a person has open still loads its next page after the recreate.

## If a source is pointed at another database

If you change a source's `uri` or `database` in the mapping, its investigations open read-only until you confirm the change, so that none quietly shows another graph. After you test the new connection with `test-source`, confirm it:

```bash
docker compose run --rm --no-deps api source rebind my-graph --confirm my-graph
```

What a person sees meanwhile, and what the command checks, is in [source-rebind.md](source-rebind.md).

## Retention

How long deleted investigations stay restorable and how long export files are kept are set by an optional `retention` block in the mapping file:

```yaml
retention:
  deleted_investigations_days: 30
  exports_days: 7
```

The defaults are 30 and 7 days, and each takes 1 to 365. A value that is out of range or of the wrong type stops the API at start and names the key. A change applies to what is deleted after the API restarts. See [configuration.md](configuration.md).

## Upgrade

Each version you build has its own tag. To upgrade, build the new tag, keep the previous one, set `NEBURYX_TAG` in `.env` to the new tag and run:

```bash
docker compose up --wait
```

The database migrations run before the API starts. With the AI preview switched on, they include the enterprise migrations, which are applied last and recorded in their own history; the `migrate` service then needs the same `NEBURYX_PROFILE` and `NEBURYX_CONFIG` as the `api` service (see [the compose README](../deploy/compose/README.md)). If an enterprise migration fails, the others of that run stay applied.

## Roll back by one tag

Set `NEBURYX_TAG` back to the previous tag and run `docker compose up --wait` again. The older image's migrate step accepts a database that has migrations it does not ship: it applies only what is pending, prints `nothing to apply` when nothing is, and never undoes a migration.

- Going back one tag is supported. Going back further is not: the command cannot tell how far back an image is, so it accepts any, but compatibility is promised for the previous tag only.
- A migration file of the older image that is not applied yet but sorts before one that is applied is refused: the run stops, names the file and applies nothing, because it would run after migrations that on every other database run after it.
- v0.1 is the first tag, so there is no previous tag to go back to yet.

## Stop and remove

`docker compose down` stops and removes the containers and keeps the database and the export files. `docker compose down -v` also removes them. Do not use `-v` to upgrade or roll back.
