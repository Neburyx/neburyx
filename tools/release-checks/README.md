# tools/release-checks

One command that runs the checks a release candidate has to pass and writes down the result of each: the date, the commit, the image, how long each check took, its exit code and the figures it measured.

```bash
pnpm check:release --record-dir <folder outside this repository> [--dry-run] [--image <name>]
```

| Flag | Meaning |
|---|---|
| `--record-dir` | Required. Where the record goes: `<UTC date-time>-<short commit>[-dry-run].json` and `.md`, and a `.logs` folder with the full output of each check. It must be outside this repository. |
| `--dry-run` | The record says "Dry run: does not count." (first line of the markdown, `dryRun: true` in the JSON) and the run does not need a clean working tree. Without it the command refuses to start on a tree with uncommitted changes. |
| `--image` | A product image that is already built. The demo install then does not build one, and the record says the build was not timed. |

The markdown of every record has exactly one line `Commit: <the full 40-character commit>` and exactly one line `Result: PASS` or `Result: FAIL`; the JSON has `commit` and `result`. The command runs every check, one after another, and does not stop at a failure. It exits `0` when every check passed, `1` when any failed (it prints the id of each) and `2` for a usage error. A check that cannot start (Docker not reachable, no Neo4j connection) is a failed check, never a skipped one. Nothing starts Docker. An interrupt (Ctrl-C) stops the running check, writes the record, and lists the checks not yet run as failed with the detail "not run: interrupted".

Connection values (`NBX_EE_URI`, `NBX_EE_USER`, `NBX_EE_PASSWORD`, from the environment or from `~/.config/neburyx/dev-neo4j.env`) are replaced by `***` in every log and in the record.

## The checks

In this order, in every run:

| Id | What it runs | Passes when |
|---|---|---|
| `fuzz` | `pnpm --filter @neburyx/api exec vitest run src/fuzz` (the input fuzz and cursor-tamper suite, [docs/fuzz-suite.md](../../docs/fuzz-suite.md)) | it exits 0 and reports at least one passed test |
| `neutrality` | Four parts: `domains` (the no-domain-words check), `packs` (`services/api/src/packs.test.ts`), `demo-compose` (`demo.compose.test.ts`: one test body over every pack, on one image) and `saved-view` (a view saved under a mapping from which a type and a property were removed reopens with placeholders at the saved places, the dropped-filter notice and no error, in memory and on Postgres) | all four parts pass, each reports its tests, each required test is found once per pack (or once), and the record names the packs found in `domain-packs/` and the image the compose suite built for itself (which is not the image under test of `demo-install`) |
| `supernode-suite` | `pnpm test:supernodes` with `NBX_SUPERNODE_RECORD` set to a file in the run's folder | it exits 0, reports tests and wrote the record file |
| `fuzz-real-server` | `src/fuzz/real-server.neo4j.test.ts` on a Neo4j test database | it exits 0 and reports at least one passed test |
| `demo-install` | `docker build` of the product image, then `docker compose up --wait` of `deploy/demo`, then `GET /readyz` and `GET /v1/sources` | the whole takes 900,000 ms (15 minutes) or less |

The two Neo4j checks need the connection above and make their own `nbx-test-` databases on that server (see [packages/test-neo4j](../../packages/test-neo4j/README.md)); the supernode suite takes about 12 minutes. `neutrality` and `demo-install` need Docker.

## How the install time is measured

The clock starts immediately before the `docker build` of the product image, on a machine with no containers, volumes or networks of the demo project and with the product image tag and the demo loader image removed, so that both builds happen inside the clock. The check names its own image tags (`neburyx-release-check` and `neburyx-release-check-loader`) and removes only those, never an image it was given with `--image`. The base images (Neo4j, Postgres, the Node base) are those on the machine before the run; the record says whether each was there. The clock stops when `docker compose up --wait` has returned 0, `GET /readyz` answers ready and `GET /v1/sources` lists every demo source as `connected`. A step that is still running at 900,000 ms is stopped and the check fails, naming the step. Passwords and the cursor key for the run are made fresh in a temporary file outside the repository and deleted afterwards; the stack is taken down at the end whatever the result.

## Tests

`pnpm --filter @neburyx/release-checks test` runs the tool's own tests with fake commands and a fake Docker; they touch no server and start no container.
