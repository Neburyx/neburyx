# ask-eval

Measures how well Ask classifies a question: whether it picks the right intent and the right inputs. It runs the product's own classifier over a file of questions on **recorded** replies of the model, compares each answer with the one the file expects, and reports the result. Scoring never calls a model; a live measurement is a recording that `ask-eval record` makes within a call budget.

```bash
pnpm ask-eval --packs domain-packs \
  --replay tools/ask-eval/data/replay.json --baseline tools/ask-eval/data/baseline.json
```

## What is scored

- A question expects `refuse` or an intent with its entities (`questions.yaml` of a pack: `expect: { intent: …, entities: { … } }`). Each pack's own `ask/` folder is read the way the product reads it.
- A plan is **right** only when the intent and every entity (name and value) are equal to the expected ones, compared exactly as given (nothing is trimmed). A refusal is **refused** only when the classifier answers that no intent fits (`no-intent`). Every other answer is a miss with its cause: `wrong-intent`, `wrong-entities`, `answered` (a question to refuse was given an intent), `no-reply` (the replay has no answer), or the classifier's own cause (`unknown-intent`, `bad-reply`, `model-declined`, `model-failed`).
- **Targets:** every refusal is refused, and at least 92% of the plans are right, that is at most `floor(plans × 8 / 100)` misses. The report also counts the plan questions the classifier answered `no-intent`.
- **Baseline:** `baseline.json` holds the counts of the best run of the replay mode (refusals refused, plans right) and a hash of the question files; a run below either count fails, and a baseline made for other questions is refused. `--update-baseline` writes it only from a run that meets the targets, never lower, and never from a scripted replay.
- Exit codes: 0 for a run that meets the targets and the baseline, 1 for a miss, 2 for a usage error.

The report holds counts, ids and causes. It never holds a question, an entity value or a reply.

## The replay

A replay is one file: `{ folders, answers }`. `folders` holds the SHA-256 of the `classification.md` of each source the answers were recorded for; `answers` maps a question's text to `{ reply }` (the model's text), `{ declined: true }` (the model refused) or `{ failure: <code> }` (a failed call). A replay recorded for another `classification.md` is refused: a change to a classification text needs a new recording.

The committed replay, `tools/ask-eval/data/replay.json`, is the recording of one measured run of `claude-haiku-5-5` (35 calls, one for each demo question), and `baseline.json` holds its counts (8 refusals refused, 27 plans right).

`--write-replay <file>` writes the **scripted** replay, in which every question gets the reply its own expectation describes and `note: scripted`. It proves the mechanism and keeps the nightly job green until a measured recording exists; the report says so, and no baseline is written from it.

## Recording a live run

```bash
pnpm ask-eval record --packs domain-packs --dry-run
pnpm ask-eval record --packs domain-packs --budget <n> --out <folder outside every git working tree> [--force]
```

- A question makes exactly one call: the classifier never repairs a reply and the run never retries, so the calls of a run are the number of questions. `--dry-run` makes no call, needs no key and prints that number with the model, the effort and the hash of each `classification.md`.
- The budget counts every call and is checked before each one; a run does not start with a budget below the number of questions.
- The key is read only from the file named by `NEBURYX_ASK_API_KEY_FILE`, as the product reads it; a key in the environment is refused. The model and effort come from `NEBURYX_ASK_*`.
- `--out` holds `recording.json` (the replay format, so it can be committed as the replay) and `run-record.json` (the model, effort, prompt hashes, calls, failed calls and tokens; no text). Both are written with mode 0600.

## A private question set

A question file with its own Ask folder can be run from outside the repository: `--questions <file> --folder <folder> --source <id>` (the folder in the product's shape, `<folder>/<id>/classification.md` and `intents.json`). Every private input and output path must be outside every git working tree; the tool refuses one inside. `ask-eval scan --questions <file> --folder <folder> --source <id> <checkout>` counts, and prints only counts, the whole questions, intent names and long classification lines of the private set that occur anywhere under a checkout; it exits 1 when any is not 0 (`--exclude <path>` leaves a path out, `--common <path>` names text the private classification may share with public files).

## Where the code lives

The scoring, loading, reporting, baseline and scan are here. The classifier, the replay provider and the recording wrapper are `ee/` code (`ee/ask/src/eval`), which a tool may reach only through its entry script, `entry/ask-eval-entry.mjs` (see [architecture checks](../../docs/architecture-checks.md)).
