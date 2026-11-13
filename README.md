# Neburyx

Neburyx is a graph investigation workbench that runs on top of an existing Neo4j database. It is for
analysts who investigate fraud, claims and similar networks.

**Status:** under active development. Try it on the synthetic demo data first.

**Licence:** Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).

**Contributing:** read [CONTRIBUTING.md](CONTRIBUTING.md) first; every commit of a pull request carries a DCO sign-off. **Security:** report a vulnerability privately as [SECURITY.md](SECURITY.md) says.

## What it does

- Starts from an entity or a referral and builds a bounded, readable network around it, which you
  expand step by step. Nothing loads until you choose it.
- Explains each link with its source evidence: why the relationship is there and which source records
  support it.
- Stays usable on entities with very many links. Expansion is paged and bounded, and every count says
  whether it is exact, estimated, a lower bound or unknown. A number is never guessed.
- Runs as one container image, set up by one mapping file. Domain words (what an account or a device is
  called in your graph) live in the mapping and in the ready-made [domain packs](domain-packs/README.md),
  never in code.

## What it does not do

- **It does not write to your Neo4j.** It only reads, and you should give it a read-only login. The one
  exception is opt-in: `neburyx test-source --write-probe` tries a single write in a transaction that is
  always rolled back, to confirm that a login cannot write. Use it only in a test environment, never
  against a source you cannot afford to touch.
- **It does not run a query you typed.** No query text reaches your database: every read is a fixed,
  parameterised template.
- **It does not sign anyone in.** The app has no sign-in yet.

## Warning: run it on your own machine only

The app has **no sign-in**. The demo and the Community install publish it on `127.0.0.1`, which only
your own machine can reach, and the app cannot see Docker's port mapping, so it cannot warn you if
that changes. **Do not change the published address, and do not put the app on a network** or behind a
proxy that others can reach, until a sign-in exists.

## Quickstart

Run Neburyx on two synthetic demo graphs, on your own machine, with the demo compose file in
`deploy/demo`. The data is synthetic: nothing in it is real.

### What you need

- Docker with Compose, and a checkout of this repository.
- Memory for Docker. The containers of the whole demo stack together used at most 3,911 MiB and
  4,471 MiB at their peak in two measured runs, so allow Docker more than that.

The image is published as `ghcr.io/neburyx/neburyx`. You can build it from this checkout, as below, or
skip the build and use the published image: after you write `.env` in the next step, add
`NEBURYX_IMAGE=ghcr.io/neburyx/neburyx` and `NEBURYX_TAG=0.1.0` to it.

### Build the image

From the repository root:

```bash
docker build -f deploy/docker/Dockerfile -t neburyx .
```

### Fill in the settings

Write a complete `.env` with random values in one step:

```bash
cd deploy/demo
[ -e .env ] && echo ".env exists; not overwritten" || ( umask 077; cat > .env <<EOF
NEBURYX_DB_ADMIN_PASSWORD=$(openssl rand -hex 24)
NEBURYX_DB_MIGRATION_PASSWORD=$(openssl rand -hex 24)
NEBURYX_DB_APP_PASSWORD=$(openssl rand -hex 24)
NEBURYX_CURSOR_KEY=$(openssl rand -base64 32)
DEMO_NEO4J_PASSWORD=$(openssl rand -hex 24)
EOF
)
```

The command refuses to touch a `.env` that already exists: Postgres sets its role passwords only when its volume is first made, so new passwords written over a running install would lock the app out of its own database, and a new cursor key would make open pages say "Start again". Changing a password after the first start is not done by this command. Never commit `.env`.

Or fill it in by hand, instead of the command above:

```bash
cp .env.example .env
```

Open `.env` and give each of these a value: `NEBURYX_DB_ADMIN_PASSWORD`,
`NEBURYX_DB_MIGRATION_PASSWORD`, `NEBURYX_DB_APP_PASSWORD`, `DEMO_NEO4J_PASSWORD` and
`NEBURYX_CURSOR_KEY`. Make the passwords with `openssl rand -hex 24`. Use letters and digits only for
passwords, because they are put into connection strings. Make the cursor key with
`openssl rand -base64 32`. The other settings in the file are optional.

### Start the demo

```bash
docker compose up --wait
```

The command returns when the stack is healthy: the database, the migration, both demo graphs and the
product. Only the product is published, on `127.0.0.1`: see the warning above.

If `up` stops with an error that names a service after a setting, for example `service "NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes" didn't complete successfully`, run `docker compose logs NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes` with that service's name: it says what is wrong with the setting and how to make a valid one.

### Open the first page

Open `http://127.0.0.1:8080`. If you set `NEBURYX_PORT` in `.env`, use that port instead.

On a fresh stack you see the first-run page. Its title is "Investigations", it carries the tag "No
sign-in", and its empty state says "No investigations yet". It offers one button for each demo
graph: "Open demo case · banking-demo" and "Open demo case · insurance-demo".

### Open the demo case

Press "Open demo case · banking-demo". It opens an investigation that starts at the account
`AC-0002000`, and the referral `REF-DEMO-1001` is shown in its header.

### Find the accounts that share a device

The banking demo graph holds a ring of six accounts that use one device and one address. To find them,
expand outward from the starting account:

1. Select the account `AC-0002000` and open its menu (right-click), or select it and press `e`.
   "Expand neighbors" loads its neighbors. "Expand by neighbor type" opens the "Expand relationships"
   panel, where you choose which neighbors to load.
2. Expand the device `DV-000010` and the address `ip-00010` the same way.

The graph now shows six accounts on that device and that address: `AC-0002000`, `AC-0002001`,
`AC-0002002`, `AC-0002003`, `AC-0002004` and `AC-0002005`.

To see the links that a rule derives, select an account. In the inspector's Overview it has two "Linked Account" rows, one for
the shared device and one for the shared address, each reading "Linked Account · N · rule-derived". Press "Show" on a row to draw
those links. Derived links are dashed. Right-click one and choose "Why is this relationship here?".

### Ask why a link is there

Right-click a line between an account and the device and choose "Why is this relationship here?". Selecting a
relationship opens its evidence panel too. The "Relationship evidence" panel opens with the tabs "Evidence", "Properties" and "Source". For a stored
relationship it says "Stored relationship" and lists the source records that support it.

In the demo, the links to source records point to placeholder addresses (`records.example.test` and `events.example.test`), because the demo
has no record system, so opening one shows a load error: that is expected. With your own source, record links go to the link
template that your mapping sets.

### A device that holds 1,000 accounts

The banking demo graph also has a device on a stop list, `DV-000000`, that 1,000 accounts use. On Home,
choose the source `banking-demo`, type `DV-000000` in "Search an entity or ID" and press "Search". The
result is listed under "Exact ID match" with a button "Open in graph". Expand the device by neighbor
type. Neburyx reports how many accounts it has with how that count was made, "1,000 · exact", and loads
the first 25 of them, not all 1,000. The rest are loaded page by page when you ask.

### Keep your work

Choose "Investigations" in the sidebar. The page lists your investigations, and the case is there with
its referral in the "Title and referral" column. The other columns are "Starting entity", "Source",
"Last edited (UTC)", "Entities / relationships" and "Actions". Each row has a button, "Actions for" and
the title, which opens a menu with "Open", "Rename", "Close", "Reopen", "Archive" and "Delete"; which of
them it offers depends on the investigation's status.

- **Close and reopen.** "Close" makes the investigation read-only. Its header then shows "Closed ·
  read-only" and says "This investigation is closed and read-only.", with a "Reopen" button.
- **Delete and restore.** "Delete" asks "Delete this investigation?" and deletes it when you choose
  "Delete investigation". Beside the "Deleted" chip on the Investigations page, the filter bar says
  "Deleted ones stay restorable for 30 days." The number of days is a
  [deployment setting](docs/configuration.md#retention). Choosing the chip lists what you deleted, each
  with a "Restore" button.
- **Export.** The "Export" button in the investigation's header opens "Export current view". Choose
  "JSON" or "CSV" and then "Download JSON" or "Download CSV". Every file begins with a header that states
  the source, the time (UTC), that the file is a partial view, how many entities are shown and how many
  are not yet retrieved (with how the count was made, and no number when it is unknown), and whether
  masking was on. "Exports are partial views, not signed evidence." A file is kept for 7 days, which is
  also a [deployment setting](docs/configuration.md#retention).

A closed or an archived investigation can still be exported. Export is not available while the source has
changed: the button is then unavailable, and its reason reads "Not available while the source has changed."

### Check the sources

```bash
docker compose run --rm --no-deps api test-source --name banking-demo
docker compose run --rm --no-deps api test-source --name insurance-demo
```

Each prints the server version, a summary of the mapping, the read-only line and how the server counts
the neighbors of each entity type, and exits `0` for pass and warn. Keep `--no-deps`: without it
Compose starts the loaders again, which resets the graphs. The demo graphs run on Neo4j Community, which
cannot list a login's privileges, so the read-only line says "Read-only: not verified" for both. That is
expected here.

### Stop, start again and remove

Stop the stack:

```bash
docker compose stop
```

To start it again, run the start command once more. Stop the stack first: running it on a stack that
is already running starts the loaders again and resets the graphs under the running product.

```bash
docker compose up --wait
```

To remove the containers and their volumes:

```bash
docker compose down -v
```

### If the stack does not start

- **Port 8080 is in use.** Set `NEBURYX_PORT` in `.env` to a free port, start again and open that port.
- **A setting is empty.** Compose stops and names it, for example "set NEBURYX_CURSOR_KEY in the .env
  file". Fill it in and start again.
- **A setting breaks its rule.** Compose stops before the database or the product starts, and the error at the end of its
  output names a service after the setting, for example `NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes`. Run
  `docker compose logs NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes` with that service's name: it says what is wrong and how to make a valid value.
- **The image step was skipped.** Compose cannot find the image called `neburyx`. Build it as above, or
  set `NEBURYX_IMAGE=ghcr.io/neburyx/neburyx` and `NEBURYX_TAG=0.1.0` in `.env`.
- **Docker does not have enough memory.** See the figures under "What you need".
- **A service did not become healthy.** Run `docker compose ps` to see which one, then
  `docker compose logs api` with that service's name instead of `api`.

## Where to go next

- [Run the app locally](docs/run-locally.md) against your own Neo4j and Postgres, without Docker.
- [Write a mapping](docs/mapping-guide.md) for your own Neo4j, and check it with `test-source`.
- [Domain packs](domain-packs/README.md): ready-made mappings, one directory per domain.
- [The Community install](deploy/compose/README.md): the image and a Postgres container, reachable only
  from this machine.
- [The documentation index](docs/README.md).

## Questions and problems

- Questions, and talking to us about Enterprise: [GitHub Discussions](../../discussions).
- To report a problem: [GitHub Issues](../../issues).

## Layout

| Path | Purpose |
|---|---|
| `apps/web` | Web client |
| `services/api` | Backend API |
| `packages/contracts` | API contract and generated client types |
| `packages/test-containers` | How tests and tools start a container (retries the port-binding timeout) |
| `packages/test-neo4j` | How the Neo4j tests reach a Neo4j Enterprise server of their own |
| `domain-packs` | Ready-made mapping files, one directory per domain |
| `deploy/docker` | Container image build |
| `deploy/compose` | Community install: image and Postgres, loopback only |
| `deploy/demo` | Demo environment on two synthetic graphs, loopback only |
| `tools/demo-graph` | Synthetic demo graph generator |
| `tools/dev` | The `pnpm dev` command that runs the app locally |
| `docs/` | Public technical documentation |

This repository contains no internal or private material, and uses synthetic data only.

## Development

Needs Node 24 (see `.nvmrc`) and pnpm, which Corepack provides at the version pinned in
`package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Code is written to [the coding guidelines](docs/coding-guidelines.md).
