# `ee/`

Code for the Enterprise and AI features of Neburyx. It is open source, under the Apache-2.0 licence in [`LICENSE`](LICENSE), the same licence as the rest of the repository.

What may live here:

- Modules for the Enterprise scope (sign-in, policy, audit, evidence packs, and the AI features: model providers, planner, summary and assistant), one folder per module.
- Nothing that the Community build needs to run.

Modules now:

| Folder | What it is |
|---|---|
| `ask/` | `@neburyx/ee-ask`: the enterprise extension (`createEnterpriseExtension`), the AI route group (one route, `GET /v1/ai/status`, so far), the provider interface (`ModelProvider`, whose request is only a built-in prompt id and its parameters), the registry of built-in prompts with the override of an id by a file, and `configure`, which checks the AI settings at start-up |
| `migrations/` | SQL migrations of the `ee/` tables, applied by `neburyx migrate` only when the preview is switched on (none yet) |

How an extension registers: Community code defines a registry and a contract (`ProfileExtension`, in `packages/contracts`) and never imports `ee/`. The image's entry script registers a loader for the extension; Community loads it only when the switch is on, mounts its route groups with the permission each route declares, and applies its migrations folder.

Rules:

- **Community code never imports from `ee/`.** `ee/` plugs in through the interfaces that Community code defines.
- **One image.** `ee/` is built into the same image as the rest. Its code path is off unless both the start-up variable `NEBURYX_PROFILE=enterprise` and `ai.preview: true` in `neburyx.yaml` are set; a start with only one of them is refused with a clear message.
- **The switch is a safety rail, not a lock.** The code is open, so whoever runs a deployment can set both parts. The switch keeps AI features from reaching a source by accident.
- No customer-specific code, no real data, no credentials.

## Testing the AI features without a model

`ee/ask/src/testing/` holds what the tests of the AI features use so that no test calls a live model: a fixture provider that answers from scripted replies keyed by prompt id and version, a suite of conformance cases that every provider is run through (the fixture today, the real client against a local stub server later), and a recorder. It is not built into the package or the image, and the package's main entry exports none of it; code inside `ee/ask` imports it by relative path.

Recording a provider's answers by hand, to turn them into a fixture:

1. Wrap the provider with `createRecorder`, run the cases that matter, and read `recording()`. The recorder keeps the status, text, model, usage and failure code of each answer, once for each prompt id and version, and never the request: its parameters hold the question and the view.
2. Record only against the synthetic demo source, never against a source with real data.
3. Write it with `writeRecording`, which runs `checkRecording` first and refuses a recording that holds an identifier-like token: an e-mail address, a UUID, a URL, an IPv4 address, six or more digits (also in groups, as in card and phone numbers), a code such as `ACC-12345` or an IBAN-shaped text. Identifiers of the synthetic demo graph (which `tools/demo-graph` generates) are passed in by hand as the allowed set. Placeholders such as `‹account#1›` and ISO dates are not findings.
4. The check is a backstop, not proof: it cannot see names, addresses, dates of birth or other free text (an ISO date is not a finding), so read what it lets through before committing it. No recording made from a live call is committed unless it passes the check with the synthetic demo's identifiers.

`loadRecording(path)` (or `parseRecording(json)`) turns a recording into replies for the fixture provider, and refuses one that was recorded against another version of a prompt, a repeated entry or an invalid reply. A recording holds only the fields of the format: `writeRecording` and the load drop any other field.
