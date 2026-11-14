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

Each AI feature has a built-in prompt with an id and a version: `ask.plan`, `ask.plan.repair`, `summary.view` and `assistant.route`. To replace one, point its id at your own text file in `ai.prompts`:

```yaml
ai:
  prompts:
    ask.plan: /etc/neburyx/prompts/ask-plan.txt
```

The file is plain UTF-8 text of at most 64 KiB. It may use only the parameters of its prompt, written as `{{name}}`: `ask.plan` (version 7) has `catalog`, `vocabulary`, `patterns` and `question`, `ask.plan.repair` (version 5) has those and `reply` and `problems`, `summary.view` has `view`, `assistant.route` has `message` and `view`. The built-in planner prompts ask for a plan as one JSON object with the keys `"kind"` (the text `plan`), `"templateId"`, `"templateVersion"`, `"params"` and `"rationale"`, and for a refusal as one with `"kind"` (the text `unsupported`), `"family"` and `"reason"`. `"templateVersion"` is a number, written without quotes: a version written as text is an invalid reply, and nothing is converted. The repair prompt asks for the JSON object alone. The reader accepts a reply that is one JSON object, one JSON object in a fenced block, or one JSON object among prose, which it drops; a reply with no object or with several is refused as not one JSON object. A replacement for `ask.plan` or `ask.plan.repair` must ask for the same keys, or every reply fails as `invalid-plan`. A replacement changes what the model is told; it cannot add tools. The hash of a prompt, which the audit records with its id and version, is the SHA-256 of the prompt text before any parameter is filled in (of the file's bytes, for a replacement), so it names the prompt and holds none of the request. `POST /v1/ask/plan` uses `ask.plan` and `ask.plan.repair`, and their output is checked against the template catalog and the mapping's vocabulary before any plan is returned. A refusal is shown to the investigator in fixed words chosen by the kind of question, never in the words of the model: the built-in prompts ask the model to name the kind (a `family` from a closed list) with an `unsupported` answer, and the server uses it only to pick the fixed sentence. A replacement prompt that does not ask for a family, or a reply with a family that is not on the list, gives the family `other`. `summary.view` and `assistant.route` are still unused.

## Prompt caching

Each prompt has two parts: fixed instructions, and the values of the investigation that follow them. With caching on, the provider is asked to keep the fixed instructions in its prompt cache, so a later call that starts with the same instructions reads them back at a lower price and faster. Only the instructions are marked for the cache. For the planner prompt (`ask.plan`) the instructions include the template catalog and the vocabulary of your mapping (names of types and rules only), which are the same for every question of a mapping, so they are in the cached part; the question, and any value of an investigation, is never in the cached part: it travels in the user message after it. With caching off, the call is one user message with the whole prompt, as before, and no cache marker is sent.

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

A prefix shorter than the model's minimum is not cached, and no error is raised. The minimum is about 512 tokens on the current models, and more on older ones (1,024 to 4,096). The planner prompt, with its catalog and vocabulary, is several thousand characters, so it is likely to reach that minimum on the current models; the other built-in prompts are short and are not cached. Its size is an estimate until the first call reports its token counts. A replacement prompt reaches the minimum when its fixed instructions are long enough.

A replacement prompt marks where the instructions end with a line that holds only `[[values]]`. The text before the line is the instructions and the text after it is the values; the line itself is not sent. The instructions can use only a static parameter of the prompt (for `ask.plan`, `catalog` and `vocabulary`, which are filled in from the mapping and the catalog), not a parameter that holds a value of a question, and neither part may be empty, or the start is refused. A replacement with no such line is sent whole as the user message and is not cached. (A file that already held such a line is read differently from this version on: the line is removed and the two parts are joined by a blank line.) The hash recorded in the audit is the hash of the whole file, line included.

The audit event of a model call carries `tokensIn` and `tokensOut`, and also `cacheReadTokens` (tokens read from the cache) and `cacheWriteTokens` (tokens written to it), each a number or `unknown` when the provider does not state it. For a prompt whose instructions hold static parameters it also carries `instructionsSha256`, the SHA-256 of the instructions with those parameters filled in, so two mappings that send different instructions under one prompt version are told apart; the filled instructions hold names only, never a value of a question. `tokensIn` counts only the input tokens after the cached part, so the total input of a call is `tokensIn` plus the two cache figures.

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

## Saved patterns

Ask can propose one of the saved patterns of the person asking, on the source the question is asked on: their own, and the ones other people shared on that source. It offers the model a key for each (`pat_1`, `pat_2`, and so on, new for each question) and a description of its structure: the entity type it starts at and whether the question gives that entity, and for each step the relationship types, the direction, the entity type it arrives at, the number and kind of its conditions and whether it has a time window. A saved run of a preset is described by its template, types and numbers. A property name, a condition value, a held starting entity, an owner, an identifier and a time are never sent, and a pattern that no longer fits the mapping is not offered.

- **The name of a pattern** is sent only when every word of it passes the same rebuild as the question (words of the mapping, the template catalog and the common-word list; no placeholder). Otherwise the pattern is offered by structure alone. A name is shown to the model in quotes, as data, and the preview lists the names that will be sent.
- **A check on every request.** Before each call to the model, the text about saved patterns must be exactly what the server builds from the structure above, and no name or identifier of a pattern may be anywhere else in the request. A request that fails the check is not sent, and the question answers as a failure, with nothing about the pattern in the log.
- **The size.** At most 30 patterns are listed for a question, the most recently changed first, reading at most four pages of the person's patterns; when more exist, the text says so and so do the plan and the preview (`patternCatalogCut`). The person can always run a pattern by hand.
- **A plan that names a pattern** keeps the pattern's id and version and the starting entity, and nothing else of it. It is confirmed and run like any plan, through the saved-pattern run, with its limits, its heavy-run stop and its count labels. If the pattern was changed (a new definition, a new name, a new starting entity, shared or unshared again) after the plan was made, the run is refused with `CONFLICT` and the reason `pattern-changed`, and a pattern that was unshared or deleted answers `NOT_FOUND`; nothing is read in either case. A pattern the mapping no longer supports is refused with `pattern-unavailable`.
- **The audit.** The event of a run carries the pattern's id and version beside the template, the keyed hash and the row count, and never a name. The event of the call to the model carries the number of patterns offered and a hash of the text sent.

## Checking it

With the switch on, `POST /v1/ask/plan`, `POST /v1/ask/run`, `POST /v1/ask/edit` and `POST /v1/ask/cancel` exist too; where no planner is installed they answer `ASK_UNSUPPORTED` with the reason `not-in-this-edition`. With the switch off the AI paths do not exist: `/v1/ai/status` and every other path under `/v1/ai` answer 404 and nothing is audited. The AI route group also refuses a call as a second check, with `ACCESS_DENIED` and the reason `ai-preview-off`, and audits the refusal, if a loaded extension is ever told that the preview is not on. The switch is a safety rail set by whoever runs the deployment, not a lock; what protects real data is the rules for what a model request may carry and the audit of every model call.

When the API starts with a problem in these settings, it writes one line for each problem, naming the setting, and exits 1. The start-up warnings name the setting too. A start that succeeds answers `GET /v1/ai/status` with `{ "preview": true }`, and `GET /v1/me` reports the edition as `enterprise`.

## Plans, runs and what the database keeps

A plan that Ask proposes is kept in the application's database for 15 minutes, until it is run, cancelled or edited, whichever is first. The row holds the template, the references it names and, for a search, the text the investigator typed; it never holds the question, a placeholder or a prompt. The typed text is removed in the same statement that moves the plan out of "proposed" (a run, a cancel, an edit, or a read that finds it expired), and a task on the application's job runner removes it from plans that expired unread: it runs every five minutes, clears at most 500 plans at a time and logs how many it cleared. A typed value therefore rests in the database for at most 20 minutes after its plan was stored. With the switch off there is no such task.

The plan store uses a database connection pool of its own, of 2 connections, beside the audit sink's; the preview's connections to the database are the application's pool size plus 2.

Each run is one audit event, `ask.run`, with the template, a keyed hash of the parameters and the row count. The events of the call that made the plan share its trace ID, which the plan row keeps (`planning_trace_id`), and the audit table is indexed by trace ID, so one query says which model produced a plan. The hash is keyed with a key derived from `NEBURYX_CURSOR_KEY`: without that key the hashes differ after every restart, and the start-up says so.

## What you see in the app

The header of the workspace shows **Ask** and **Summarize**. With the switch off, both show a padlock beside their name; pointing at one, or a screen reader, says "Enterprise capability, locked", and activating it does nothing. With the preview on, both show a sparkle and can be activated. The state comes from the edition that `GET /v1/me` reports, so it is the same after a reload.

**Summarize** does not do anything yet: an activated control says "Summarize is not available in this release yet" and sends no request. It arrives in a later release.

**Ask** works. It answers a question about the investigation that is open, with a read-only run of one of the product's own templates, and never by writing a query:

1. **Ask a question.** Type it in the Ask panel (at most 1,000 characters). Do not type customer names: other people may see the text. A name or an ID you want the question to mean is picked from the entities of the source, so the model receives a placeholder for it and never the text you typed.
2. **Preview.** The preview shows exactly the words the model will receive, with each name and ID replaced by a placeholder, and the saved patterns that are listed for it (their structure only, and a name only when every word of it is allowed). Nothing is sent until you press Send. If the preview changes after you edit the question, the panel says so before you send.
3. **Blocked words.** A word that is not a word of your mapping, of the template catalog or of the list of common words cannot be sent. The panel says "Not sent" and names each such word. For each you can pick an entity it stands for, remove the word, use it as a search value, or edit the question. Typed names and values are never sent as text.
4. **The plan card.** A question that the model can answer with one template becomes a plan, shown under "Review before running": the template, what it names, and a line that the run is read-only with the same limits as manual exploration. Nothing has run. You can **Edit** the plan (change what it names), **Cancel** it, or **Run** it. A plan is kept for 15 minutes.
5. **Run.** The run goes through the same gate, limits and count labels as a manual read. A run that would read more than the source allows without being asked stops and says so; **Continue** reads one page more, and Cancel keeps it from running. A plan that ran can be run again.
6. **The cited answer.** The result is shown with a short summary of statements, each followed by the keys of the records it rests on, so you can check every statement against the result. A summary is made from the result by fixed rules, not by the model; a summary with a statement that the result does not back is not shown. **Add to graph** draws the result on the graph when it has something to draw.
7. **Refusals.** A question that no template answers is refused, with a fixed sentence that says why and a line that says what to do instead, for example opening Paths, expanding an entity or searching by stable ID. The kinds are: a path between entities, a property or value selection, similar records, a ranking or an aggregate, a combination of attributes, an attribute of a linked record, a relation the question does not name, a judgement, personal data, and the view that is loaded on screen. A refusal runs nothing and keeps nothing.
8. **Saved patterns.** Ask can propose one of your saved patterns, or one shared on the source, when it fits the question. The plan card shows its name, its path and the entity it starts from. A saved pattern's plan cannot be edited in place: ask again to change what it names. If the pattern changed after the plan was made, the run is refused and nothing is read.

## Running it with `pnpm dev`

`pnpm dev` loads the enterprise code when `NEBURYX_PROFILE=enterprise` is set in your shell and `ai.preview: true`, `ai.provider`, `ai.model` and `ai.key` are in the mapping file the settings file names ([Run it locally](run-locally.md)). The migrate step then applies the migrations of the preview too. A key given as `env: NAME` must also be in the env file the settings name, since the dev command gives the API only the variables of that file; a key file works as it does elsewhere. The enterprise code is built once when the command starts: a change under `ee/` needs a restart.
