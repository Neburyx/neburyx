# `ee/`

Code for the Enterprise and AI features of Neburyx. It is open source, under the Apache-2.0 licence in [`LICENSE`](LICENSE), the same licence as the rest of the repository.

What may live here:

- Modules for the Enterprise scope (sign-in, policy, audit, evidence packs, and the AI features: model providers, Ask, summary and assistant), one folder per module.
- Nothing that the Community build needs to run.

Modules now:

| Folder | What it is |
|---|---|
| `ask/` | `@neburyx/ee-ask`: the enterprise extension (`createEnterpriseExtension`); the AI route group, with `GET /v1/ai/status`, `POST /v1/ask` (a question) and `POST /v1/ask/continue` (one more bounded page of a result stopped as heavy); the provider interface (`ModelProvider`, whose request is a prompt id and version, the fixed instructions and the values) and the audited model call; the loader of the Ask folder (`<folder>/<source id>/classification.md` and `intents.json`, read and checked at start-up); the classifier, which sends the source's `classification.md` and the question to the model and reads its reply strictly; the server-built cited answer; and `configure`, which checks the AI settings of the environment at start-up (the mapping file holds only `ai.preview`) |
| `migrations/` | SQL migrations of the `ee/` tables, applied by `neburyx migrate` only when the preview is switched on: `0001-audit-events.sql`, `0002-ask-runs.sql`, `0003-ask-plans.sql`, `0004-drop-ask-plans.sql` and `0005-ask-runs-intent.sql` (see its [README](migrations/README.md)) |

How an extension registers: Community code defines a registry and a contract (`ProfileExtension`, in `packages/contracts`) and never imports `ee/`. The image's entry script registers a loader for the extension; Community loads it only when the switch is on, mounts its route groups with the permission each route declares, and applies its migrations folder.

Rules:

- **Community code never imports from `ee/`.** `ee/` plugs in through the interfaces that Community code defines.
- **One image.** `ee/` is built into the same image as the rest. Its code path is off unless both the start-up variable `NEBURYX_PROFILE=enterprise` and `ai.preview: true` in `neburyx.yaml` are set; a start with only one of them is refused with a clear message.
- **The switch is a safety rail, not a lock.** The code is open, so whoever runs a deployment can set both parts. The switch keeps AI features from reaching a source by accident.
- No customer-specific code, no real data, no credentials.

## Testing the AI features without a model

`ee/ask/src/testing/` holds what the tests of the AI features use so that no test calls a live model: a fixture provider that answers from scripted replies keyed by prompt id and version, and a suite of conformance cases that every provider is run through (the fixture, and the real client against a local stub server). It is not built into the package or the image, and the package's main entry exports none of it; code inside `ee/ask` imports it by relative path.

How well Ask classifies a question is scored by the code in `ee/ask/src/eval`, reached through the entry script of [`tools/ask-eval`](../tools/ask-eval/README.md). It runs the product's own classifier over a replay of recorded replies of the model (`replayProvider`), so a scoring run makes no model call. A recording run wraps the real provider (`recordingProvider`) so that every question makes exactly one call, never more than the budget given, and keeps only the question, the model's reply and the name of the model, in the form a replay reads; it needs a key and is run by hand against the synthetic demo packs, never against a source with real data. See the README of `tools/ask-eval` for the commands, the targets and the baseline.
