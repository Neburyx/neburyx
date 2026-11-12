# Switch the AI preview on

The AI preview is the Enterprise and AI part of the product. It is off in a normal install and works only when **both** of these are set:

- the environment variable `NEBURYX_PROFILE=enterprise`, on the `api` service and on the `migrate` service;
- `ai.preview: true` in the mapping file (`neburyx.yaml`).

With only one of the two, the `api` and `migrate` commands stop and say which is missing. The switch is a safety rail against reaching AI features by accident, not a lock: whoever runs the deployment can set both.

## What to set in the mapping file

The `ai` block is described key by key in the [mapping guide](mapping-guide.md#the-ai-section). With the preview on, three keys are required:

| Key | What to give |
|---|---|
| `provider` | `anthropic`. Other providers are refused for now |
| `model` | The model to use, for example `claude-sonnet-5-5`. There is no default model: you choose one, and you can change it later without changing anything else. Give the name without a date suffix |
| `key` | Where the API key is, by reference: `env: NAME` for an environment variable, or `file: /absolute/path` for a file. The key is never written in the mapping file, and a key written there is refused |

`neburyx.example.yaml` in `deploy/compose/config/` has a commented block to copy.

## The key file

A key in a file is the simplest way to keep it out of the environment of every process:

1. Put the key in a file, for example `anthropic.key`.
2. Make it readable by its owner only: `chmod 600 anthropic.key`. A file that group or others can read is refused when the API starts.
3. In a container the API runs as the `node` user (uid 1000), so that user must own the file: `chown 1000 anthropic.key`. Mount it read-only and name the path inside the container in `key.file`.
4. On Kubernetes, a file from a secret volume is owned by root, so a container that runs as `node` cannot satisfy the owner-only check. Give the key as an environment variable filled from the secret (`env.valueFrom.secretKeyRef`) and use `key: { env: NAME }` instead of a file.

The API checks that the file exists, is not empty and can be read by the process. It does not read the key when it starts. With `env`, the variable must be set and not empty.

## Prompts

Each AI feature has a built-in prompt with an id and a version: `ask.plan`, `summary.view` and `assistant.route`. To replace one, point its id at your own text file in `ai.prompts`:

```yaml
ai:
  prompts:
    ask.plan: /etc/neburyx/prompts/ask-plan.txt
```

The file is plain UTF-8 text of at most 64 KiB. It may use only the parameters of its prompt, written as `{{name}}`: `ask.plan` has `catalog` and `question`, `summary.view` has `view`, `assistant.route` has `message` and `view`. A replacement changes what the model is told; it cannot add tools. The hash of a prompt, which later work records in the audit with its id and version, is the SHA-256 of the prompt text before any parameter is filled in (of the file's bytes, for a replacement), so it names the prompt and holds none of the request. The features that use these prompts come later; today the preview has one route, `GET /v1/ai/status`, and the checks that keep model output from reaching your graph arrive with them.

## What may be sent to the model

By default no property of any record is sent: the model gets placeholders for the records, their types and the question, and nothing else. To send properties, list them by type in `ai.properties`. The list only narrows what the server already holds back: values that the gate masked are never sent, whatever the list says.

```yaml
ai:
  properties:
    person: [locale, status]
    KNOWS: [since]
    company: ["*"]
```

- A type is an entity type or a relationship type of the mapping, and each name must be a property that the mapping names for that type. A type or property the mapping does not have stops the start.
- `*` stands for every property of the type that is not `pii`. It never includes a `pii` property.
- A `pii` property can be sent only with the override: set `pii_override: true` **and** name the property in its type's list. With the override off, a list that names a `pii` property stops the start. With it on, the server logs a warning naming each such property when it starts, and the audit of a call that sent one records that a `pii` property was sent (the property names, never the values).
- Only values that are text, numbers, booleans, dates or times are sent, as text. Lists, points and values of an unknown kind are not.
- What is sent does not depend on the provider or the model you choose.

## Checking it

With the switch off the AI paths do not exist: `/v1/ai/status` and every other path under `/v1/ai` answer 404 and nothing is audited. The AI route group also refuses a call as a second check, with `ACCESS_DENIED` and the reason `ai-preview-off`, and audits the refusal, if a loaded extension is ever told that the preview is not on. The switch is a safety rail set by whoever runs the deployment, not a lock; what protects real data is the rules for what a model request may carry and the audit of every model call.

When the API starts with a problem in these settings, it writes one line for each problem, naming the setting, and exits 1. The start-up warnings name the setting too. A start that succeeds answers `GET /v1/ai/status` with `{ "preview": true }`, and `GET /v1/me` reports the edition as `enterprise`.
