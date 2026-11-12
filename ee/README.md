# `ee/`

Code for the Enterprise and AI features of Neburyx. It is open source, under the Apache-2.0 licence in [`LICENSE`](LICENSE), the same licence as the rest of the repository.

What may live here:

- Modules for the Enterprise scope (sign-in, policy, audit, evidence packs, and the AI features: model providers, planner, summary and assistant), one folder per module.
- Nothing that the Community build needs to run.

Modules now:

| Folder | What it is |
|---|---|
| `ask/` | `@neburyx/ee-ask`: the enterprise extension (`createEnterpriseExtension`) and the AI route group, which has one route, `GET /v1/ai/status`, so far |
| `migrations/` | SQL migrations of the `ee/` tables, applied by `neburyx migrate` only when the preview is switched on (none yet) |

How an extension registers: Community code defines a registry and a contract (`ProfileExtension`, in `packages/contracts`) and never imports `ee/`. The image's entry script registers a loader for the extension; Community loads it only when the switch is on, mounts its route groups with the permission each route declares, and applies its migrations folder.

Rules:

- **Community code never imports from `ee/`.** `ee/` plugs in through the interfaces that Community code defines.
- **One image.** `ee/` is built into the same image as the rest. Its code path is off unless both the start-up variable `NEBURYX_PROFILE=enterprise` and `ai.preview: true` in `neburyx.yaml` are set; a start with only one of them is refused with a clear message.
- **The switch is a safety rail, not a lock.** The code is open, so whoever runs a deployment can set both parts. The switch keeps AI features from reaching a source by accident.
- No customer-specific code, no real data, no credentials.
