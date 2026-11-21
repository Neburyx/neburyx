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

## The Ask-preview gate

```bash
pnpm check:ask-preview --record-dir <folder outside this repository> [--dry-run] [--cut summary] [--cut assistant]
```

The same command, runner and record as above, with the checks of the second release gate (`--gate ask-preview`; `pnpm check:release` stays the first gate's). It makes no model call: the figures of the accuracy criteria come from the committed recordings of the model's replies, each naming the model it was measured on, and from the committed baselines. A recording made for another classification text or router text, a baseline made for other questions or another model, a baseline that holds no value and a replay that is only scripted all fail the check, so a router change that is not recorded again fails the gate.

The markdown of the record has a *Criteria* table: one row for each criterion with its status and its figure, then the table of checks. The first lines say either `No criterion was dropped.` or which criteria were dropped.

| Criterion | What it says | Checks |
|---|---|---|
| C1 | Ask meets the targets of the evaluation tool and its committed baseline on the demo packs' questions | `ask-accuracy`: `pnpm ask-eval` with `--json` over the committed recording; passes only when the targets are met and the counts are no lower than the baseline's |
| C2 | The Ask safety suite passes | `ask-safety`: the whole suite and every test its table of named tests names, each in its own package, with each guarantee of the assistant that the table lists having a passed row; `ask-safety-read-transaction`: the one case that needs a real Neo4j (a write that passed every text check is refused by the read transaction) |
| C3 | Every summary statement cites returned elements | `ask-cited-summary`: the end-to-end test over the demo questions on the Neo4j dev server, with the number of questions from the evaluation tool's own loader |
| C4 | The AI case summary and the assistant's replies pass the citation, numeric and leakage suites on the demo views | `summary-suites`: the summary suite whole, with a canary of each of the citation, numeric and leakage checks found by name, and the demo views of the labelled set counted; `assistant-replies`: the rows of the safety suite's table about a reply, a streamed turn and the records |
| C5 | Assistant route accuracy meets its baseline | `assistant-route-accuracy`: the assistant's scoring once for each model replay committed with a folder of its own, each against its baseline |
| C6 | The preview runs on any source, under the data rules and the audit | `any-source`: the preview guard, Ask and an assistant turn answering the same whatever a source says of `synthetic`, the safety suite's provider-input and record rows, and the audit routing check, with the audited events of the preview counted in `docs/audit-events.md` |

The suite checks build first (`pnpm build:deps` and the summary suite's own build), once for the run, because the tests import built output that git does not hold; a failed build fails them with its reason.

`ask-safety-read-transaction` and `ask-cited-summary` need the Neo4j connection the other Neo4j checks use and make their own `nbx-test-` databases; without the connection they fail, they are never skipped. A required test is found by the words of its title in the JSON report of its file, so a test that was removed, skipped or renamed fails the check.

`--cut summary` and `--cut assistant` drop the criteria that rest only on a feature that is cut: the summary's part of C4 for the first, C5 and the assistant's part of C4 for the second. A dropped criterion shows `dropped: the feature is cut`, is never counted as passed, and the `Result:` line is judged on what remains; C1, C2, C3 and C6 are never dropped.

## How the install time is measured

The clock starts immediately before the `docker build` of the product image, on a machine with no containers, volumes or networks of the demo project and with the product image tag and the demo loader image removed, so that both builds happen inside the clock. The check names its own image tags (`neburyx-release-check` and `neburyx-release-check-loader`) and removes only those, never an image it was given with `--image`. The base images (Neo4j, Postgres, the Node base) are those on the machine before the run; the record says whether each was there. The clock stops when `docker compose up --wait` has returned 0, `GET /readyz` answers ready and `GET /v1/sources` lists every demo source as `connected`. A step that is still running at 900,000 ms is stopped and the check fails, naming the step. Passwords and the cursor key for the run are made fresh in a temporary file outside the repository and deleted afterwards; the stack is taken down at the end whatever the result.

## Tests

`pnpm --filter @neburyx/release-checks test` runs the tool's own tests with fake commands and a fake Docker; they touch no server and start no container.
