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

The model client reads only what the mapping file names. The `ANTHROPIC_*` variables of the environment (a key, a token, a profile, a base address, log or tracing switches) are ignored: the key comes from `key` and nowhere else. The one exception is `ANTHROPIC_CUSTOM_HEADERS`, which would add headers to every call, so the server refuses to start while it is set.

If you name a model that the service has announced as retired, the client library writes one warning to the console with the model's name when a call is made. The warning holds neither the key nor the prompt. Choose a current model to avoid it.

## The key file

A key in a file is the simplest way to keep it out of the environment of every process:

1. Put the key in a file, for example `anthropic.key`. The file holds either the bare key, or one assignment line, `ANTHROPIC_API_KEY=value` (the name is capital letters, digits and underscores; `export ` before it and matching quotes around the value are accepted). Blank lines and lines that start with `#` are ignored. A file with more than one assignment, more than one non-blank non-comment line, an assignment with an empty value, or no key at all is refused when the API starts, with a message that names the file and shows nothing from it.
2. Make it readable by its owner only: `chmod 600 anthropic.key`. A file that group or others can read is refused when the API starts.
3. In a container the API runs as the `node` user (uid 1000), so that user must own the file: `chown 1000 anthropic.key`. Mount it read-only and name the path inside the container in `key.file`.
4. On Kubernetes, a file from a secret volume is owned by root, so a container that runs as `node` cannot satisfy the owner-only check. Give the key as an environment variable filled from the secret (`env.valueFrom.secretKeyRef`) and use `key: { env: NAME }` instead of a file.

The API checks that the file exists, is not empty, can be read by the process and holds one of the two forms. It reads the file at start only to check its form and keeps nothing; the key itself is read again at each call. With `env`, the variable must be set and not empty.

## Prompts

Each AI feature has a built-in prompt with an id and a version: `ask.plan`, `summary.view` and `assistant.route`. To replace one, point its id at your own text file in `ai.prompts`:

```yaml
ai:
  prompts:
    ask.plan: /etc/neburyx/prompts/ask-plan.txt
```

The file is plain UTF-8 text of at most 64 KiB. It may use only the parameters of its prompt, written as `{{name}}`: `ask.plan` has `catalog` and `question`, `summary.view` has `view`, `assistant.route` has `message` and `view`. A replacement changes what the model is told; it cannot add tools. The hash of a prompt, which later work records in the audit with its id and version, is the SHA-256 of the prompt text before any parameter is filled in (of the file's bytes, for a replacement), so it names the prompt and holds none of the request. The features that use these prompts come later; today the preview has one route, `GET /v1/ai/status`, and the checks that keep model output from reaching your graph arrive with them.

## Prompt caching

Each prompt has two parts: fixed instructions, and the values of the investigation that follow them. With caching on, the provider is asked to keep the fixed instructions in its prompt cache, so a later call that starts with the same instructions reads them back at a lower price and faster. Only the fixed instructions are marked for the cache. A value of an investigation is never in the cached part: it travels in the user message after it. With caching off, the call is one user message with the whole prompt, as before, and no cache marker is sent.

```yaml
ai:
  cache:
    enabled: true   # the default
    ttl: 5m         # the default; or 1h
```

The environment variables `NEBURYX_AI_CACHE` (`on` or `off`) and `NEBURYX_AI_CACHE_TTL` (`5m` or `1h`) win over the file. An empty value counts as not set; any other value that is not accepted refuses the start and names the variable. They are read from the environment of the API process: in Docker Compose, set them in `.env` (the compose file passes them to the `api` service), and with `pnpm dev`, set them in your shell (the dev command passes them to the API). Like the other `ai` settings, they are checked only when the preview is on.

| Lifetime | What it costs to write the cache | When to choose it |
|---|---|---|
| `5m` (default) | 1.25 times the normal input price of the cached tokens | Calls come often. Each read renews the lifetime at no cost |
| `1h` | 2 times the normal input price | Calls come less often than every five minutes but the same instructions are reused within the hour |

A read costs a fraction of the normal price (0.1 times on most models, 0.05 times on the current Sonnet and Opus models). The prices are the provider's, and they change; check its price list.

A prefix shorter than the model's minimum is not cached, and no error is raised. The minimum is about 512 tokens on the current models, and more on older ones (1,024 to 4,096). Today's built-in prompts are short, so they will not be cached until later work makes them longer. A replacement prompt reaches the minimum when its fixed instructions are long enough.

A replacement prompt marks where the instructions end with a line that holds only `[[values]]`. The text before the line is the instructions and the text after it is the values; the line itself is not sent. The instructions cannot use a `{{name}}` parameter, and neither part may be empty, or the start is refused. A replacement with no such line is sent whole as the user message and is not cached. (A file that already held such a line is read differently from this version on: the line is removed and the two parts are joined by a blank line.) The hash recorded in the audit is the hash of the whole file, line included.

The audit event of a model call carries `tokensIn` and `tokensOut`, and also `cacheReadTokens` (tokens read from the cache) and `cacheWriteTokens` (tokens written to it), each a number or `unknown` when the provider does not state it. `tokensIn` counts only the input tokens after the cached part, so the total input of a call is `tokensIn` plus the two cache figures.

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

## What you see in the app

The header of the workspace shows **Ask** and **Summarize**. With the switch off, both show a padlock beside their name; pointing at one, or a screen reader, says "Enterprise capability, locked", and activating it does nothing. With the preview on, both show a sparkle and can be activated. Ask and Summarize do not do anything yet: until the features behind them are in the release, an activated control says that it is not available in this release yet and sends no request. The state comes from the edition that `GET /v1/me` reports, so it is the same after a reload.

## Running it with `pnpm dev`

`pnpm dev` loads the enterprise code when `NEBURYX_PROFILE=enterprise` is set in your shell and `ai.preview: true`, `ai.provider`, `ai.model` and `ai.key` are in the mapping file the settings file names ([Run it locally](run-locally.md)). The migrate step then applies the migrations of the preview too. A key given as `env: NAME` must also be in the env file the settings name, since the dev command gives the API only the variables of that file; a key file works as it does elsewhere. The enterprise code is built once when the command starts: a change under `ee/` needs a restart.
