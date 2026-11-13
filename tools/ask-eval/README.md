# ask-eval

Measures how well Ask plans. It runs the real planner over a file of questions on recorded model replies, compares each plan with the one the file expects, and reports the result. It never calls a model: live accuracy is measured by hand on the operator's own server, with a recording the operator makes.

```bash
pnpm ask-eval --questions services/api/tests/ask/questions.yaml \
  --replay services/api/tests/ask/replies.json \
  --packs domain-packs \
  --baseline services/api/tests/ask/baseline.json --mode replay
```

## What is scored

- A question expects a plan (a template and its parameters), a refusal (`unsupported`, with an optional `family`), or `blocked` (the allowlist stops it before planning). A blocked question is outside the plan and refusal counts, but the run fails if one of them is no longer blocked.
- A plan is **right** only when the template and every parameter match after the defaults are filled in: an omitted `minShared` of 1, `maxHops` of 1, a `limit` of the mapping's default page, an `expand` direction of `both` and sort of `observed`, and a `linked-entities` direction that the mapping gives (the one direction in which the listed relationship types join the anchor's type; two or none is a miss). Lists the plan treats as sets (`via`, `relTypes`, `neighborTypes`, `entityTypes`) match in any order. The two `ends` of a `derived-edge-support` plan match in order when the rule joins two different entity types, and in either order only when the rule's two types are the same. `rationale` and `templateVersion` are ignored.
- **Targets:** every refusal question must be refused, and at most `--max-misses` plan questions may miss (2 of 25 for the demo set). The refusals and the plans are two lines of the report.
- **Baseline:** with `--baseline` and `--mode replay|live`, the run also fails below the value stored for the mode. With no value for the mode only the targets apply. `--update-baseline` writes the result only from a run that meets its targets, and never writes a lower value. A baseline made for another question set is refused.
- **Family count:** a refusal that carries an expected `family` is counted when the planner's answer has the same family. It is reported beside the targets and never changes the exit code. The report says `family: not measured` when no answer has a family.
- **Exit codes:** 0 for a run that meets the targets and the baseline, 1 for a miss, 2 for a usage error (a malformed file, a baseline of another set, a refused path).

## The replay

A replay maps the text the planner is given for a question to the reply the model gave, `{ plan, repair? }` (the second is the reply to the repair call). A question with no reply is reported `no-reply` and counts as a miss. `--write-replay` writes a replay in which every question gets the answer the file expects, with no model call; it replaces an existing, different file only with `--force`. A replay made this way regression-tests the allowlist, validation, repair, scoring, targets and baseline, not a model.

## A question file outside the repository

`--questions <path>` outside the checkout, with one `--mapping`, a `--replay`, `--refusal-target exact` and `--max-misses <n>`. The report holds question ids and counts only, never a wording or a blocked word. A path inside the checkout other than the demo file is refused. Output files (`--write-replay`, `--update-baseline`) need `--out` outside the checkout. `ask-eval scan --questions <file> --root <folder>` prints how many whole questions of a file appear in a folder tree, and nothing else.

## Where the code lives

The scoring, loading and reporting are here. The planner is `ee/` code (`ee/ask/src/eval`), so the entry script `entry/ask-eval-entry.mjs` imports it and hands it to the command (see [architecture checks](../../docs/architecture-checks.md)).

`report` groups refusals by expected family and plans by template; `--json` writes it as one document that also holds the counts, the targets and the baseline, and sends any other line to standard error.
