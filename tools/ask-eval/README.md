# ask-eval

Measures how well Ask plans. It runs the real planner over a file of questions on recorded model replies, compares each plan with the one the file expects, and reports the result. Scoring never calls a model; live accuracy is measured from a recording that `ask-eval record` makes on the operator's own server (see below).

```bash
pnpm ask-eval --questions services/api/tests/ask/questions.yaml \
  --replay services/api/tests/ask/replies.json \
  --packs domain-packs \
  --baseline services/api/tests/ask/baseline.json --mode replay
```

## What is scored

- A question expects a plan (a template and its parameters), a refusal (`unsupported`, with an optional `family`), or `blocked` (the allowlist stops it before planning). A question expected to be blocked is outside the plan and refusal counts, but the run fails if one of them is no longer blocked.
- A plan is **right** only when the template and every parameter match after the defaults are filled in: an omitted `minShared` of 1, `maxHops` of 1, a `limit` of the mapping's default page, an `expand` direction of `both` and sort of `observed`, and a `linked-entities` direction that the mapping gives (the one direction in which the listed relationship types join the anchor's type; two or none is a miss). Lists the plan treats as sets (`via`, `relTypes`, `neighborTypes`, `entityTypes`) match in any order. The two `ends` of a `derived-edge-support` plan match in order when the rule joins two different entity types, and in either order only when the rule's two types are the same. `rationale` and `templateVersion` are ignored.
- **The one-hop rule.** An `expand` plan and a `linked-entities` plan count as the same plan when each reads as the entities of one target type at the other end of one relationship type from the anchor, in one direction, with the same window and limit: for `linked-entities` one relationship type in `via`, `maxHops` 1 and a direction given or derived from the mapping; for `expand` one relationship type, one neighbor type, the direction (`both` when omitted) and the default sort. Two hops, two relationship types, another relationship type, direction, target type, window or limit are a different plan. A plan right by this rule is right, and the report says how many were (`scored right by the one-hop rule: n`).
- **The blocked-before-planning rule.** A question that is expected to be refused and that the allowlist blocks counts as refused: nothing was sent to the model and the investigator is told the question cannot be asked. The report says how many (`scored refused because the allowlist blocked the question: n`). A plan question that is blocked stays a miss, and a question expected to be blocked is unchanged. A refusal counted this way is left out of the family count, because nothing was planned and no family exists.
- **Targets:** every refusal question must be refused, and at most `--max-misses` plan questions may miss (2 of 25 for the demo set). The refusals and the plans are two lines of the report.
- **Baseline:** with `--baseline` and `--mode replay|live`, the run also fails below the value stored for the mode. With no value for the mode only the targets apply. `--update-baseline` writes the result only from a run that meets its targets, and never writes a lower value. A baseline made for another question set is refused.
- **Family count:** a refusal that carries an expected `family` is counted when the planner's answer has the same family. It is reported beside the targets and never changes the exit code. The report says `family: not measured` when no answer has a family.
- **Exit codes:** 0 for a run that meets the targets and the baseline, 1 for a miss, 2 for a usage error (a malformed file, a baseline of another set, a refused path).

## The replay

A replay maps the text the planner is given for a question to the reply the model gave, `{ plan, repair? }` (the second is the reply to the repair call). A question with no reply is reported `no-reply` and counts as a miss. `--write-replay` writes a replay in which every question gets the answer the file expects, with no model call; it replaces an existing, different file only with `--force`. A replay made this way regression-tests the allowlist, validation, repair, scoring, targets and baseline, not a model.

## A question file outside the repository

`--questions <path>` outside the checkout, with one `--mapping`, a `--replay`, `--refusal-target exact` and `--max-misses <n>`. The report holds question ids and counts only, never a wording or a blocked word. A path inside the checkout other than the demo file is refused. Output files (`--write-replay`, `--update-baseline`) need `--out` outside the checkout. `ask-eval scan --questions <file> --root <folder>` prints how many whole questions of a file appear in a folder tree, and nothing else.

## Recording a live run

`ask-eval record` asks the questions of a file through the real planner and the operator's configured provider, and writes the replies as a replay that the runner scores. It never runs on its own: every run needs an explicit call budget.

```bash
pnpm ask-eval record --questions <file> --mapping <mapping> --dry-run
pnpm ask-eval record --questions <file> --mapping <mapping> --budget <n> --out <folder outside the checkout> [--model <name>]
```

- `--dry-run` makes no call and prints the questions to ask and the worst case (two calls a question, the planner's repair call included), so a budget can be agreed first.
- The budget counts every model call, repairs included. A call that would pass it is not made: the run stops, exits 1 and says so, and the recording holds only the questions fully answered. A question that is not in it scores as a miss when the recording is scored; it is never dropped from the totals. A call that fails counts, is not retried, and is reported by question id and failure code only.
- The provider is built the way the product builds its own, from the `ai` settings of the mapping and `ai.key.file` (a key file that others can read, an empty one or a missing one is refused before any call; `ai.key.env` and `ai.prompts` replacements are refused for these runs). A mapping with no `ai` section, such as the demo packs, takes `--ai <file>` outside the checkout: a file with an `ai` section (or the settings themselves). `--model` replaces the model name, for a step-up. The key is read from its file only by the provider and appears in no output.
- `--out` names a folder outside the checkout; the recording is `recording.json` there, with mode 0600, and an existing one is replaced only with `--force`. A question asked but blocked by the allowlist is named (`blocked: <id>`); an unexpected error ends the run after the recording and the run record are written. A question file outside the checkout takes one `--mapping`; its report holds ids and counts only. A refusal by the model is recorded and scores as a refusal of the kind the planner gives it (`model-refused`).
- The run ends with the model, the prompt ids and versions, the word-list version and the token counts, for the record of the run.

## Where the code lives

The scoring, loading and reporting are here. The planner is `ee/` code (`ee/ask/src/eval`), so the entry script `entry/ask-eval-entry.mjs` imports it and hands it to the command (see [architecture checks](../../docs/architecture-checks.md)).

`report` groups refusals by expected family and plans by template, and counts every answer by the family the planner returned (`plan`, a refusal family, `no-reply`); `--json` writes it as one document that also holds the counts, the targets and the baseline, and sends any other line to standard error.
