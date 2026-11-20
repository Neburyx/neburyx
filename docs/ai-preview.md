# Switch the AI features on

Ask, the AI case summary and the investigation assistant are on wherever an AI provider is configured. They need no profile and no switch in the mapping file: give the API a provider key (see [The key file](#the-key-file)) and the features that can run start. Each has a setting that turns it off.

| Variable | What it does |
|---|---|
| `NEBURYX_ASK_ENABLED` | `off` turns Ask off; `on`, empty or unset leaves it on |
| `NEBURYX_SUMMARY_ENABLED` | `off` turns the AI case summary off; `on`, empty or unset leaves it on |
| `NEBURYX_ASSISTANT_ENABLED` | `off` turns the assistant off; `on`, empty or unset leaves it on |

These three are read only when a provider key (`NEBURYX_ASK_API_KEY` or `NEBURYX_ASK_API_KEY_FILE`) is set; a value that is neither `on` nor `off` stops the start and names the variable, never the value. With no provider key none of the AI features is available and nothing of them runs. With a key and Ask and the summary both off, the AI code is not loaded.

Ask needs its folder of intents (`NEBURYX_ASK_MAPPING_FOLDER`, see [The Ask folder](#the-ask-folder)): with Ask on and a key set but no folder, the start stops and names the setting. Set `NEBURYX_ASK_ENABLED=off` for a deployment that wants only the summary. With Ask off the assistant uses the folder when it can be loaded and validated; when it cannot (the folder is missing or unreadable, or its contents fail the checks below), the whole folder is left out, the start goes on with a logged warning that names no intent and no query text, and the assistant's `ask` route answers that Ask is not set up for the source. Every statement below that the start stops applies when Ask is on. The summary also needs its token key file before it is available (see [`GET /v1/ai/status`](#checking-it)).

**The older switch.** `NEBURYX_PROFILE=enterprise` together with `ai.preview: true` in the mapping file still means what it meant beyond these three features: the edition `GET /v1/me` reports and the enterprise audit events of every read. With only one of the two, the `api` and `migrate` commands stop and say which is missing. It no longer decides whether Ask, the summary or the assistant is available.

## What to set in the mapping file

The `ai` block of the mapping file holds one key, `preview`, the older switch above; the AI features do not need it. It is described in the [mapping guide](mapping-guide.md#the-ai-section).

```yaml
ai:
  preview: true
```

`neburyx.example.yaml` in `deploy/compose/config/` has a commented block to copy.

Everything else about Ask is set in the environment of the API process. The mapping file refuses a key it once held (see [Upgrading](#upgrading)), and a key written there is never read.

## What to set in the environment

When a provider key is set, the API reads these variables. An empty value counts as not set.

| Variable | What to give |
|---|---|
| `NEBURYX_ASK_PROVIDER` | `anthropic`, the default and the only value for now |
| `NEBURYX_ASK_CLASSIFICATION_MODEL` | The model that classifies a question, for example `claude-haiku-5-5` (the default). Give the name without a date suffix |
| `NEBURYX_ASK_API_KEY` | The API key itself. Give this or `NEBURYX_ASK_API_KEY_FILE`, not both; one of the two is required |
| `NEBURYX_ASK_API_KEY_FILE` | The absolute path of a file that holds the key and that only its owner can read (mode 0600); see [The key file](#the-key-file) |
| `NEBURYX_ASK_MAPPING_FOLDER` | Required. The absolute path of the Ask folder, described below |
| `NEBURYX_ASK_EFFORT` | How much work the model puts into a reply: `low`, `medium`, `high`, `xhigh` or `max`. The default is `medium` |
| `NEBURYX_ASK_TIMEOUT_MS` | How long one call to the model may take, from 1000 to 600000. The default is 60000 |
| `NEBURYX_ASK_MAX_RETRIES` | How many times a failed call is tried again, from 0 to 5. The default is 0 |
| `NEBURYX_ASK_MAX_TOKENS` | The most tokens a reply may use, from 1 to 32768. The default is 8192 |
| `NEBURYX_AI_CACHE` | `on` or `off`. The default is `on`; see [Prompt caching](#prompt-caching) |
| `NEBURYX_AI_CACHE_TTL` | `5m` or `1h`. The default is `5m` |
| `NEBURYX_AI_MAX_SLOT_SHARE` | The most of each pool of read slots, a source's and a person's, that AI reads may hold together: a number above 0 and up to 1. The default is 0.5, which leaves manual exploration at least half. An AI read over its share waits, and never holds up a manual read |

The defaults are hypotheses that will change with measurement. A value that is set and not accepted stops the start and names the variable, never the value. The variables are checked only when an AI provider key is set.

In Docker Compose, put the settings in `.env`: the compose file passes the provider, model, effort and limit variables, and the cache variables, to the `api` service, and sets the folder to `/etc/neburyx/ask`. The key is not in `.env`; see [The key file](#the-key-file). With `pnpm dev`, see [Running it with `pnpm dev`](#running-it-with-pnpm-dev).

The model client reads only these variables. The other `ANTHROPIC_*` variables of the environment (a token, a profile, a base address, log or tracing switches) are ignored. The one exception is `ANTHROPIC_CUSTOM_HEADERS`, which would add headers to every call, so the server refuses to start while it is set, even when it is empty.

If you name a model that the service has announced as retired, the client library writes one warning to the console with the model's name when a call is made. The warning holds neither the key nor any prompt. Choose a current model to avoid it.

In the demo environment (`deploy/demo`), the packs' own folders are used: add `COMPOSE_FILE=compose.yaml:compose.ask.yaml` and `NEBURYX_DEMO_ASK_KEY_FILE=<absolute path of a key file>` to the demo's `.env`; see its README.

## The Ask folder

The folder named by `NEBURYX_ASK_MAPPING_FOLDER` holds what Ask knows about each source, in one subfolder per source id:

```text
<folder>/
  <sourceId>/
    classification.md
    intents.json
```

- `classification.md` is text for the model, at most 64 KiB.
- `intents.json` is at most 1 MiB and holds at most 200 intents. Each intent is a name and either a parameterised read-only query or a built-in template:

```json
{
  "accounts-of-person": {
    "parameters": ["personId"],
    "query": "MATCH (p:Person {id: $personId})-[:OWNS]->(a:Account) RETURN a.id AS account ORDER BY account LIMIT 25"
  }
}
```

An intent may also have a `label`: 1 to 80 characters of plain text with no control character, which the panel shows in place of the name ("Ran Accounts of a person") and which the assistant's model reads as `read of <label>`. A label may not equal the name or label of another intent. The name stays the identifier in the model's requests and in the audit; without a label the name is shown as before.

A template intent has `parameters`, `template` (one of the nine built-in template ids) and `settings` instead of `query`. An intent has exactly one of `query` and `template`. Values reach the source only as parameters, never as query text. The intent name `saved-pattern` is reserved.

A source without a subfolder has no Ask. In a container the API runs as the `node` user (uid 1000), so the mounted folder and every file in it must be readable by that user (for example `chmod -R a+rX config/ask`, or owned by uid 1000); a folder that user cannot read stops the start, and on Linux a folder made by another user with mode 0700 is such a folder. Anything else in the folder stops the start: a subfolder that is not a configured source, a link, or any other file (names that start with a dot are ignored). With no source configured the folder only has to exist. With Ask on and a provider key set, the folder must exist: in Docker Compose that is `config/ask/` next to your mapping file (empty is fine with no source; with sources configured it needs a subfolder for at least one of them). A link is refused even inside the folder, so a Kubernetes ConfigMap volume, which mounts its files as links, cannot be used directly: copy the files into the folder (for example from an init step).

The folder is read once at start-up; a change needs a restart. The start-up checks each query and stops, naming the intent and the clause but never the query text, when:

- the `$` parameter names in the query are not exactly the intent's `parameters`;
- the query has anything but read clauses: `MATCH`, `OPTIONAL MATCH`, `WHERE`, `WITH`, `RETURN`, `ORDER BY`, `SKIP`, `LIMIT` and `UNWIND`, with plain functions, the built-in date, time, duration, point and vector functions, and `EXISTS`, `COUNT` and `COLLECT` subqueries under the same rules;
- the query has a write clause, `LOAD CSV`, `USE`, `CALL`, `FOREACH`, `UNION`, a second statement or a namespaced function (`apoc.*`, `db.*`), or a character outside plain ASCII and whitespace outside a string, comment or backticked name.

A word that Cypher reserves for a command (for example `start`, `next`, `offset`, `set`, `create`, `use`) cannot be used as a name in a query: put it in backticks.

### The reply form

`classification.md` must tell the model to answer in this form (the shipped files of the two domain packs do). Ask reads the reply strictly:

- The reply is exactly one JSON object, with nothing around it but whitespace and no key twice, and it has exactly the keys `intent` and `entities`.
- `intent` is the name of an intent of the folder (or `saved-pattern` when the person's saved patterns were sent, see [Asking for a saved pattern](#asking-for-a-saved-pattern)), or `null` when no intent answers the question; with `null`, `entities` is empty.
- `entities` is an object of text values: at most 20, each name a parameter name (`[A-Za-z_][A-Za-z0-9_]{0,63}`), each value non-empty, at most 256 code points, with no control character.

```json
{"intent": "name", "entities": {"id": "value"}}
```

```json
{"intent": null, "entities": {}}
```

This is the whole reply when no intent answers the question. The bare word `null` is not a reply: it is not an object with the two keys, so it is refused as a reply that does not fit.

A name that is not an intent of the folder is refused as an unknown intent, and any other departure from the form as a reply that does not fit. Both get a fixed sentence and nothing runs. Whether the names in `entities` are the intent's parameters is checked afterwards, when the entities are bound to the intent: a missing, extra or invalid input is refused with its own fixed sentence.

`classification.md` must also name the reserved intent `saved-pattern` as an allowed answer, with its two entity keys, or the classifier never picks a saved pattern: `pattern`, the key of one of the saved patterns in the list the product sends after the question, and `anchor`, the stable ID of the starting entity, only for a pattern that starts from an entity the question gives. The product's own sentence before that list says how to name a pattern, but it travels in the content after the question, not in the instructions of the call, so a `classification.md` that says the intent must be one of its own list contradicts it. `saved-pattern` is accepted only when the person's saved patterns were sent with the question; for a person with none, a reply that names it is refused as an unknown intent. The shipped files of the two domain packs name it with its two keys. See [Asking for a saved pattern](#asking-for-a-saved-pattern).

### Template intents

`settings` is the template's own parameters, with the fixed parts written out and each value the question supplies written as the string `"$name"`, where `name` is one of the intent's `parameters`:

```json
{
  "devices-shared-with": {
    "parameters": ["id"],
    "template": "shared-attribute",
    "settings": {
      "ref": { "entityType": "account", "stableId": "$id" },
      "attributeType": "device",
      "via": "USES_DEVICE"
    }
  }
}
```

- A string that is exactly `$name` is replaced by the value wherever a value stands, inside objects and arrays. Keys are never replaced. `"$a$b"`, `"$"` and `"x $id"` are plain text, and a fixed value that looks like `$name` cannot be written.
- The placeholders must be exactly the intent's `parameters`.
- Start-up checks the settings against the template with each placeholder set to text, and refuses what does not fit. A placeholder may stand only where the template takes text: not in a number, not in a choice from a list (a direction or a sort), and not in the time window. A date window cannot come from a question. For a time-bounded question, write an intent with a fixed window in its settings.
- The template `shortest-paths` takes `ends` (two references, each with the placeholder where the question supplies the value), `relTypes`, `maxHops` and `limit` as fixed values, and optionally `direction`. A number cannot be a placeholder, so the hops and the cap are written out in the intent. Start-up refuses an intent above 4 hops or 25 paths and, for the source it belongs to, one above that source's `max_hops`, `path_results_cap` or `max_page`, naming the intent and the setting. A question that finds no path between two entities that exist is answered `nothing-found`.
- Where a template takes a list of text (`via` of linked-entities, `relTypes` and `neighborTypes` of expand, `entityTypes` of search), a placeholder fills one element, as in `["$t"]`. A placeholder that stands for the whole list is refused.

(The entity type, attribute type and relationship type above are examples. They come from your mapping file or your domain pack, as in the rest of this guide.)

### What a question does

With Ask available, a question goes to `POST /v1/ask` ([Asking a question](api-conventions.md#asking-a-question)). Ask checks that the person may read the source, classifies the question with one call to the model (below), binds the entities the model found to the intent's parameters, and runs a template intent or a file query of the folder through the same gate as every other read: read-only, bounded, with the person's own access and masking. The answer is built by the server from the result and cites the elements it lists. A result that is larger than the source allows without being asked stops before reading it, with a count that is a lower bound at the source's `heavy_op_threshold` (never an estimate of the full size), no rows and a token to continue (`POST /v1/ask/continue`, valid for 15 minutes, and only while the intent is unchanged); the page comes from the Continue route.

A question that cannot be answered gets one fixed sentence for its cause, never text from the model. An intent with a `query` is checked at start-up as above and run by the same route through the gate: the entities are the query's parameters and reach it only as parameters, the read is bounded by the source's limits and its result must be nodes and relationships of the source's mapping (the rules the gate applies are in the architecture notes). The answer lists what the query returned, with a count labelled as a lower bound when the read was cut.

The model receives the source's `classification.md` as the instructions of the call and, as its content, the question exactly as typed and, for a person with saved patterns on the source, one fixed sentence and the catalog of that person's own patterns (a key, the label and a description of the structure of each, and a fixed sentence when not all of them are listed; see below). Nothing else is sent: no property value, no entity value of a result, no other person's pattern. Nothing is withheld or redacted from the question before the call. The intent names of the folder are sent only if `classification.md` lists them, so it should. The reply must have [the reply form](#the-reply-form).

The tests of `tools/ask-safety-suite` prove these promises, each by a named test (its README lists them):

- A value from a question reaches the source only as a parameter, and the statement is the folder's own text or the template's: for a file query, a template that takes an ID and a search, and through Continue with no new model call.
- An instruction typed into a question runs nothing. A reply that fits runs once, with its entities only; a reply with an entity too many, too few or too long is refused.
- A folder with a write, a call, `LOAD CSV` or a second statement, or with a parameter that is not declared, is refused at start-up, and the loader names the intent, never the query text. A query forced past the loader is refused by the gate before any read, the route and the gate each check the folder, and a result of a type the mapping does not name is refused whole. With `pnpm test:neo4j`, the read transaction refuses a write that passed every text check.
- The provider receives the instructions and the question as typed (with caching on and off, and for a question that holds text that looks like an instruction), the model is called once for each question, and no property value of a result reaches it. For a person with saved patterns it receives their own catalog and no ID, version, anchor or other person's pattern.
- No audit event, `ask_runs` row, log line or problem response holds an entity value, the question or a saved pattern's label or anchor.
- Nothing is redacted or withheld in the request path, and masking applies to the result nodes only: the model and the source receive the same either way.
- The settings that once withheld a property from the model are refused as unknown keys of the mapping file.
- Each check fails on a leaky input (a canary for each), and a case that never ran cannot pass.

The suite does not measure how well Ask classifies; that is `tools/ask-eval` (see [Checking it](#checking-it)).

### Asking for a saved pattern

A question may name one of the person's own saved patterns on the source (the shared patterns of other people are never offered). When the person has any, the model is sent, after the question, one fixed sentence that says how to name a pattern and a list with a key for each pattern, its label as the person typed it and a description of its structure (types, directions and kinds of condition, never a value or an ID); it answers with the reserved intent `saved-pattern` and the entity `pattern` (the key), and `anchor` (the stable ID the question gives) for a pattern that starts from an entity the question names. Ask then runs the saved pattern through the gate as the person's own saved run would, with the person's masking. The answer names the pattern by its ID in `entities` and by its label in `patternName`, and an unknown pattern is the refusal `nothing found`. A saved pattern is never built from a name in the question, only from an ID.

Each question writes one audit event, `ask.question` (`ask.continue` for a continue), with the intent's name, the kind, the outcome, the cause, the template id, a keyed hash of the parameters and the number of elements listed (for a saved pattern, also its ID and version, never its label). It never holds an entity value, the question or a sentence. The model call that classifies is audited by its own event (`ask.classify`), as under [Prompt caching](#prompt-caching). The event is queued and written after the answer has gone: if it cannot be written, the answer is still given, the failure is counted in `GET /readyz` and logged by its ids, and the event is lost (see [Audit events](audit-events.md)).

## The key file

The key is given to the API in one of two ways: `NEBURYX_ASK_API_KEY` holds the key itself, or `NEBURYX_ASK_API_KEY_FILE` names a file that holds it. There is no reference by name in the mapping file any more. A key in a file is the simplest way to keep it out of the environment of every process:

1. Put the key in a file, for example `anthropic.key`. The file holds either the bare key, or one assignment line, `ANTHROPIC_API_KEY=value` (the name is capital letters, digits and underscores; `export ` before it and matching quotes around the value are accepted). Blank lines and lines that start with `#` are ignored. A file with more than one assignment, more than one non-blank non-comment line, an assignment with an empty value, or no key at all is refused when the API starts, with a message that names the file and shows nothing from it.
2. Make it readable by its owner only: `chmod 600 anthropic.key`. A file that group or others can read is refused when the API starts.
3. In a container the API runs as the `node` user (uid 1000), so that user must own the file: `chown 1000 anthropic.key`. Mount it read-only and give its path inside the container in `NEBURYX_ASK_API_KEY_FILE`.
4. On Kubernetes, a file from a secret volume is owned by root, so a container that runs as `node` cannot satisfy the owner-only check. Fill `NEBURYX_ASK_API_KEY` from the secret (`env.valueFrom.secretKeyRef`) instead of using a file.

In Docker Compose the key is not passed by name in `compose.yaml`. Put `NEBURYX_ASK_API_KEY=` and the key in `source.env`, next to `.env` (chmod 0600, never committed): it is the optional file the `api` service reads. Do not put it in `.env`: Compose uses `.env` only to fill in variables of the compose file, so a key put there never reaches the `api` service.

The API checks that the file exists, is not empty, can be read by the process and holds one of the two forms. It reads the file at start only to check its form and keeps nothing; the key itself is read again at each call. With `NEBURYX_ASK_API_KEY`, the variable must be set and not empty.

## Prompt caching

Each model call has two parts: fixed instructions, and the values of the investigation that follow them. With caching on, the provider is asked to keep the fixed instructions in its prompt cache, so a later call that starts with the same instructions reads them back at a lower price and faster. Only the instructions are marked for the cache; a value of an investigation is never in the cached part: it travels in the user message after it. With caching off, the call is one user message with the whole prompt, and no cache marker is sent.

Two variables set it: `NEBURYX_AI_CACHE` (`on` or `off`, the default is `on`) and `NEBURYX_AI_CACHE_TTL` (`5m` or `1h`, the default is `5m`). An empty value counts as not set; any other value that is not accepted refuses the start and names the variable. They are read from the environment of the API process: in Docker Compose, set them in `.env` (the compose file passes them to the `api` service), and with `pnpm dev`, set them in your shell (the dev command passes them to the API). They are checked only when the preview is on.

| Lifetime | What it costs to write the cache | When to choose it |
|---|---|---|
| `5m` (default) | 1.25 times the normal input price of the cached tokens | Calls come often. Each read renews the lifetime at no cost |
| `1h` | 2 times the normal input price | Calls come less often than every five minutes but the same instructions are reused within the hour |

A read costs a fraction of the normal price (0.1 times on most models, 0.05 times on the current Sonnet and Opus models). The prices are the provider's, and they change; check its price list.

A prefix shorter than the model's minimum is not cached, and no error is raised. The minimum is about 512 tokens on the current models, and more on older ones (1,024 to 4,096).

The audit event of a model call carries `tokensIn` and `tokensOut`, and also `cacheReadTokens` (tokens read from the cache) and `cacheWriteTokens` (tokens written to it), each a number or `unknown` when the provider does not state it. `tokensIn` counts only the input tokens after the cached part, so the total input of a call is `tokensIn` plus the two cache figures. The audit holds the model, the prompt's id and version and the SHA-256 of its fixed instructions, never a value of a question or the text of an answer.

## The assistant

The mapping may give an entity type or a relationship type a plain-text `description` ([the mapping guide](mapping-guide.md)). The assistant sends the descriptions of the types that matter to a question (those of the elements it is given, and those the message names) as lines the model may cite, and the panel shows a cited description as "About {type}", marked as the operator's description and not as a read of the source. A question that asks only what named types or links mean is placed on a route of its own: the model only copies the names, and the server matches them to the profile's types (type, label or display name, exactly, whatever the case) and writes the answer itself, with no answer call and no view needed: the description as the operator wrote it, or a fixed sentence naming a type that has none (or whose description holds a verdict word). A name that matches no type goes to the view route. When such a question is mixed with a question about what is shown, the router adds the names to its `view` reply, and the answer from the view carries the fixed sentence for those of them that have no description; a type the message merely names, without asking what it means, gets no such sentence. The limits: descriptions state what a type is and are not evidence about any record; and a sentence that restates a verdict word is rejected whatever its source.

The assistant's settings are read when a provider key is set and the assistant is on; a value that is not a whole number in its range stops the start and names the variable, never the value. The defaults and ceilings are hypotheses to be measured, except the timeout of a call, the calls, the words of a message and the turns of context, which are given.

| Variable | Default | Ceiling |
|---|---|---|
| `NEBURYX_ASSISTANT_MODEL` | `claude-sonnet-5-5` | |
| `NEBURYX_ASSISTANT_TIMEOUT_MS` (one model call) | 60000 | 600000, and not above the total |
| `NEBURYX_ASSISTANT_TOTAL_TIMEOUT_MS` (a whole turn) | 180000 | 600000 |
| `NEBURYX_ASSISTANT_MAX_CALLS` (model calls a turn) | 5 | 10 |
| `NEBURYX_ASSISTANT_MAX_STEPS` (reads a turn) | 4 | 8 |
| `NEBURYX_ASSISTANT_MAX_ROWS` (rows read a turn) | the source's own page limit times the steps | an operator may only lower it |
| `NEBURYX_ASSISTANT_CONTEXT_TURNS` (earlier turns the router, the answer from the view and the answer after tool steps see: references and titles only, read again through the gate, with the relationships those turns cited and the titles of their ends) | 3 | 6 |
| `NEBURYX_ASSISTANT_MAX_MESSAGE_WORDS` | 1000 | 3000 |
| `NEBURYX_ASSISTANT_MAX_INPUT_TOKENS` | 25000 | 100000 |
| `NEBURYX_ASSISTANT_MAX_OUTPUT_TOKENS` | 4000 | 32000 |
| `NEBURYX_ASSISTANT_RUN_RETENTION_DAYS` (days the stored model-call records of the turns are kept) | 30 | a positive whole number |
| `NEBURYX_ASSISTANT_THREAD_RETENTION` (when a thread is cleared) | `close` | `close` is the only value: a thread is cleared when its investigation is closed, archived or deleted; any other value stops the start |
| `NEBURYX_ASSISTANT_THREAD_READ_TURNS` (how many of the newest turns of a thread one read gives; nothing stored is trimmed) | 100 | 500 |
| `NEBURYX_ASSISTANT_PROMPT_FILE` | the file shipped with the product | |
| `NEBURYX_ASSISTANT_VIEW_PROMPT_FILE` | `assistant-view.md`, shipped with the product | |
| `NEBURYX_ASSISTANT_TYPOLOGY_FILE` | `aml-typologies.md`, shipped with the product | |

`NEBURYX_ASSISTANT_PROMPT_FILE` names an absolute path to a file that replaces the router's instructions (at most as large as a classification file of the Ask folder). The reply format is added by the product after the file's text and cannot be changed by it, and the hash of the instructions used is kept with them. No setting raises a limit or budget of a source.

`NEBURYX_ASSISTANT_VIEW_PROMPT_FILE` and `NEBURYX_ASSISTANT_TYPOLOGY_FILE` do the same for the instructions of the answer from the view: each names an absolute path to a file that replaces the shipped prompt or the shipped typology text, within the same size limit, and the reply format is added after both and is fixed. A relative path, a missing, unreadable or oversized file stops the start and names the setting, never the path or the text. The answer from the view needs no setting or file of the case summary.

### What a turn stores

For each model call of a turn the application keeps, in the tables `assistant_runs` and `assistant_run_calls` of its own database, the exact instructions and values it sent and the reply as the provider gave it (a refused, cut-off or badly formed reply too), with the status, the failure kind, the tokens and the duration. This is the one place where the text of a message and of a reply is at rest, so it holds real names and values: no route, screen, export, log line, evidence view or audit event reads or holds it, and it is removed after `NEBURYX_ASSISTANT_RUN_RETENTION_DAYS` (at start-up and every hour; a failed removal is logged as one fixed line and tried again). The records are queued when the call starts and completed when it ends, after the request has gone on: the model is never kept waiting for a write, a failed or dropped write is counted in `GET /readyz` and logged by the run id and the step (never text), and a record can be lost if the process stops while it is queued. Every audit event of the turn (the model call, the Ask read and the closing event) carries the run id, so a bad reply can be traced from the audit to what was sent. Where the extension is loaded without the application's database for these tables nothing is written, and the events still carry the run id.

### The tool loop

After its first read, a turn may go on with more reads when `NEBURYX_ASSISTANT_MAX_STEPS` is 2 or more (4 by default; at 1 a turn is its one read, as before). The model is asked for the next step with the masked results so far and replies that it is done, or names one of the tools it was offered and gives the text of each value the tool takes:

- each intent of the source's Ask folder, with its parameters;
- each template of the catalog by its id (`entity`, `degree-preview`, `expand`, `shared-attribute`, `linked-entities`, `derived-rule-run`, `derived-edge-support`, `search` and `shortest-paths`), an anchor as its entity type and stable ID, a list as one value; a path search reads at most 3 hops and 10 paths;
- each of your saved patterns, and the system and built-in patterns, under the names the model is given for them;
- the view, read again through the gate.

A request is read strictly: exactly the tool's parameters, each one text, never query text. A request for anything else, or one that does not fit, is repeated once while the calls limit leaves room for the answer, and then the turn ends with the fixed sentence of an unplaced question and nothing more is read. A request that names an entity type the source's mapping does not know is refused by the gate; the turn notes that nothing was read and goes on. Each read runs exactly as Ask runs it: the same gate, the same masking, the same audit event and the same heavy stop, which ends the loop and gives the stop with its Continue.

The view call may also reply with such a request when the elements in view are not enough; the loop then goes on from the view's reading, with that request as its next step.

The citations of that answer name each element by the title the read gave it (masked as it was asked), so an element that is not drawn on the canvas is still named in its marker and its source line; the panel uses the graph's own title when the element is drawn.

After the steps, the model is asked once for the answer: cited sentences over the elements the reads returned, put through the checks the case summary has (every sentence cites an element that was read, a number occurs in the lines it cites, a name that was not given is removed, wording of a verdict is refused). The elements of a view keep the keys the view call gave them, the elements of the reads are `r1`, `r2` and so on, and each read has a line of its own (`s1`, `s2`, …) that the server writes with what the read found and the count with its quality, so that a sentence can state that a read found nothing by citing that line, and its numbers are checked against it. A line of a read is no element: it is in no list of sources, and the coverage of the answer says what each read found. A reply that fails may be asked for again within the calls limit, and with no sentence left the answer is the fixed sentence that nothing could be answered.

The tools need the source's Ask folder: a source with no folder has no tools, and a turn on it is its one read. When the steps or the rows of a turn are spent, no call is made to choose another read and the answer is drafted over what was read; the time is checked before each call and each step. A read that has begun runs under the gate's own timeout and is not cut by the turn's total time, and the read that crosses the limit of rows has read its whole page, so a turn may read up to one page past it. With `NEBURYX_ASSISTANT_MAX_STEPS` at 1 the router is told that a message that needs more than one read is not placed; at 2 or more it places such a message on its first read, and a message any part of which asks for a verdict, query text or another source, investigation or person is always refused with that cause.

A turn stops at a limit when a limit leaves no way to answer: model calls (`NEBURYX_ASSISTANT_MAX_CALLS`, 5 by default; one call is kept for the answer, so a repeat of a reply that did not fit never takes it, and when no call is left to choose another read the answer is drafted over what was read: a turn of two reads takes 4 calls, 5 with one repeat), the time of the whole turn, and the size of what is sent. Reads (`NEBURYX_ASSISTANT_MAX_STEPS`) and rows (`NEBURYX_ASSISTANT_MAX_ROWS`) end the reading, and so do calls and the size of what is sent when the turn has reads: the turn is then answered over what was read, and the answer carries `stoppedAt` with the limit that ended the reading, so the panel shows the stop sentence under the answer too (with one step allowed there is no loop and no limit to reach). The answer of a turn that has nothing to answer over is `{ "status": "limit", "limit": "calls" | "steps" | "rows" | "time" | "input", "sentence": …, "reads": […] }` with the fixed sentence of that limit and the reads made, and the panel shows the reads open above a card titled by the limit (**Stopped at a limit** for reads, **Model calls**, **Rows read**, **Time**, **Too large to send**). The sentences name no number and say what was read is shown above ("This turn reached its limit for reads, so it stopped. What was read is shown above."; for time, "This turn ran out of time, so it stopped. …"). The closing event is `refused` with the cause `limit-<kind>` (`answered` with that cause for a turn answered over what was read).

### The steps of a turn

Every answer that read something lists its reads, in order, written by the server: the tool and what kind of tool it was (a question of the source's folder, a template of the catalog, one of your patterns, or the view), the subject (the values the gate accepted for the tool's parameters, as Ask's "Understood as" shows them; a read whose values did not fit has none and is listed as not read), the rows it gave with the quality of that count (exact, estimated, lower bound, or no number when it is not known), and whether it is complete or partial. When the turn began from the view, the view's reading is its first read. The panel shows them as **Steps · N**, closed by default and open to one box per read; in a stop and in a confirmation they are open above the card.

### A heavy step waits for you

When a step of the loop, after at least one read, would read what Ask stops as heavy (a read over the source's heavy-read threshold), nothing of it is read. The answer is `{ "status": "confirmation", "pendingId": …, "plan": …, "step": …, "reads": […] }`: what the step would read (its tool, subject, the count it stopped at as a lower bound, the size of one page) and the reads made so far. The panel shows the card **Waiting for you** with **Confirm**, **Skip** and **Cancel**, and nothing more runs until you choose. A first read of a turn that is heavy stays Ask's heavy stop with **Continue**.

The waiting turn is not held in the memory of one process: the `plan` is a signed token naming the step it waits on, the earlier steps of the turn (tools and the values the gate accepted, never a result), the counters and the hash of the message and of the view's keys, bound to you, the source, the investigation, the definition of the tool and the masking, under its own label (never valid as a choice or a continue token); and a small row of the table `assistant_pending_confirmations` (the id, who and where, its status and its expiry, never a value, an element or a result) makes it single-use and holds one waiting confirmation per person, across investigations. So a decision works on any copy of the application and after a restart. The decision is a request of its own (`message` as typed, the keys of the view of the waiting turn, and `confirmation: { pendingId, plan, decision }`): **Confirm** reads the earlier steps again through the gate (their results were never kept, so they are as of now and as masked now, and may differ from the first time; the read goes through your read slots and each has an audit event marked as made again), reads the heavy step as one bounded page and goes on; **Skip** reads the earlier steps again, leaves the step out and goes on; **Cancel** reads nothing. A confirmation never lifts a limit: the limits are checked again before the step is read, and the time spent waiting does not count. A confirmation that was used, replaced (by a new confirmation or by any new message of yours), cancelled, expired (15 minutes; found when it is used or when you add another, never by a timer), altered, or whose message or view is not the one it was made for, is `{ "status": "confirmation-invalid", "sentence": "This confirmation is no longer valid. Nothing was read." }`. After a reload a turn that was waiting shows its message and the line that it is no longer open; send a new message to go on.

### Refusals in the panel

A refusal, and the refusal of an Ask question inside a turn, shows in the panel as a card titled **Not answered** with the fixed sentence of its cause under the message as typed, never a word of the model, and the shortcuts **Open Filters**, **Summarize this view** and **Open Paths**. Open Filters and Open Paths open that tool, and leave it open if it already is. **Summarize this view** starts a draft of the AI case summary (a model call) and closes the assistant panel; it is dimmed with the reason when the summary is not available. **Open Paths** shows only when the build has the Paths tool, and a line says it is left out when it does not.

### Cancel

Closing the connection of `POST /v1/assistant/turns` cancels the turn: the model call in flight is aborted, no read of the source starts after it, and a read already running is ended through the same signal. The turn's closing event and its stored run say `cancelled`, and a cancelled turn is not kept in the thread. In the panel, **Cancel** replaces **Send** while a turn is out. A cancelled message shows a Cancelled turn and puts the message back in the field; a cancelled Continue returns the turn to its heavy stop with Continue available. Nothing a cancelled turn had already read is undone.

### The thread

Each assistant turn that ends answered or refused on a route is kept in the person's thread of the investigation (`assistant_threads`, `assistant_turns`) as references and metadata only: the route and how it ended, the cause of a refusal, the intent and template it ran, a keyed hash of the message, the element each parameter resolved to and the elements and relationships the answer cited (references, never their content), the number of reads, the model reference, the prompt version, the tokens and the run id. **No question, no answer, no parameter value and no instruction is stored in the thread.** The hash is made with the application's signing key, so a short message cannot be confirmed by guessing. A turn that failed, was cancelled or was not let through (too long, too large, a continue that is not valid) is not kept. The thread is never used for training; nothing in the product sends it anywhere. This is what lets a later message use what an earlier one did without the text of either being kept.

A thread is **cleared when its investigation is closed, archived or deleted**, in the transaction of that change (a trigger of the migration, so no path that changes the status can skip it); a reopened investigation starts with no thread. A turn that began before the investigation was cleared cannot write into it afterwards: it reads the investigation's clearing count before it does any other work, and its write is refused when the count has moved or the investigation is not open. The number of turns a thread keeps is not decided: nothing is trimmed, and the thread goes when the investigation is closed. The setting `NEBURYX_ASSISTANT_THREAD_RETENTION` names this rule (`close`, its only value).

The thread's writes are queued like the model-call records, off the request path: a failed or dropped write is counted in `GET /readyz` and logged by the turn id and the step, never text, and never changes the answer. `GET /v1/assistant/investigations/{id}/thread` gives the caller their own thread as the kind and end of each turn and the number of things it cited (the most recent turns, 100 by default, and how many older ones there are: nothing stored is trimmed), and says when their previous thread was cleared if they have none since; an investigation that is not the caller's is `NOT_FOUND`. The text a person typed lives only in the panel's session in the browser and is gone when the browser session ends; the thread keeps the routes and intents, and the analyst keeps the source of truth, the graph and the notes.

### A turn

`POST /v1/assistant/turns` takes a message (`{ sourceId, investigationId, message, viewElementKeys, mask? }`) or the continue of a heavy stop (`continue: { intent, entities, continueToken }` in place of `message`), or the choice of an element that a clarification or a follow-up offered (`choice: { intent, roles, entities, choiceToken }` in place of `message`), never two of them; `viewElementKeys` names at most 300 elements of the view, never their content. The server checks that the investigation is the caller's and belongs to the source before any model call, refuses a message over `NEBURYX_ASSISTANT_MAX_MESSAGE_WORDS` words, and makes one audited call of the router, whose reply must be exactly one route object (a reply that is not one is asked for once more with a fixed note when `NEBURYX_ASSISTANT_MAX_CALLS` leaves room for the answer after it, and a second one is the `unplaced` refusal). The answer is one of:

- a refusal with a cause (`verdict`, `raw-query`, `other-source`, `unplaced`) and a fixed sentence the server chooses, never a word of the model; a reply that is not a route is `unplaced` and nothing is run;
- `answered` on the `view` route: sentences that each cite the elements of the view they rest on (`sentences`, `citations`, the model and the number of calls), written from the elements the server read again through the gate (never from content the browser sent) and kept only when every check passes; `not-answered` when no sentence survives or the view holds nothing readable;
- `answered` on the `ask` route: the same answer `POST /v1/ask` gives for an intent of the source's Ask folder (a result with its cited summary and sources, a heavy stop with its token, or one of Ask's refusals), plus, for a result that was read, a `step` (the intent, the number of elements it lists, whether it is complete) and a `coverage` line the server writes (how much is shown, how much is not yet retrieved, with the quality of the count);
- a `clarification` when the message cannot be placed on one element and the assistant asks instead of guessing: the fixed question naming the entity type ("Which … do you mean?"), and each element it may mean as the person sees it (title and entity type), with the `choice` the panel sends when one is picked. Nothing was read for the intent. The candidates are elements of the person's own thread and of the view, at most five, newest first. A clarification is not kept in the thread;
- `choice-invalid` for a choice whose token is expired, altered, another person's, another investigation's or another masking's, whose intent changed since, or whose element the gate no longer reads: nothing was read;
- `answered` on the `ask` route (on the `view` route when the loop began from the view) after tool steps: `sentences`, `citations`, `coverage`, the model, `calls` and `steps` (2 or more), as above; or `limit` with the limit that ended the turn;
- `unavailable` when the model's service or the source fails (`kind`, and whether a read had started); `too-large` when the message and the view are over `NEBURYX_ASSISTANT_MAX_INPUT_TOKENS`; `too-long` over the word limit; `continue-invalid` for a continue whose token is expired, altered, another person's, another investigation's or for a changed intent, entities, masking or definition.

**The context of a follow-up.** The router is shown the last `NEBURYX_ASSISTANT_CONTEXT_TURNS` turns of the person's own thread of this investigation: for each, its route, the intent it ran, the elements it ran the intent for and the elements it cited, each as a key of this turn (`c1`, `c2`, …) with its title as the person sees it, read again through the gate for this message so masking and access are as of now; a refused turn gives only its cause, and no text of any message or reply is in it (none is stored). Another person's turns, another investigation's and another source's are never in it. A message that refers to an earlier element without naming it ("the other one") is answered by the router naming the element by its key in a member of its own, never by its text; the server looks the key up in the keys it made for this turn, runs the intent with that element's stable ID as a parameter, and treats any other key as naming nothing: a message that names nothing it holds becomes a clarification when elements of the right entity type are at hand, and the fixed `unplaced` refusal when none are.

**The elements in view, named by key.** The router is also shown the elements in view, each entity as a key of the same table (`c4`, …) with its type and its id as the client sent them (no title, and no read of the source for this), the relationships in view as lines with their own keys, their type and the ends the client sent, and an element that is also in the thread keeps the key the thread gave it. A key resolves only to an element of the view or of the thread, of the entity type the role takes: a key of a relationship, of another entity type or of nothing names nothing for the role, and a stable id written where a key stands makes the reply not a route. When the message could mean one of several elements of the type in view, the clarification offers them, and the title of one that only the view holds is read again through the gate for this message's masking, and left out if the gate does not give it back.

**An attached summary.** A message may carry `summaryToken`, the token of an AI case summary. The token is opened for every turn with the person, the investigation and the policy version in force (nothing of the summary is stored by the thread; the browser holds the token). When the router places the message on the view, the elements the summary's sentences cite are read again through the gate together with the elements in view (at most 300 together), each sentence is judged again against what was read, and the sentences that still hold are given to the model as context beside the elements; the answer's checks read the elements alone, so a name or a figure that only the summary states is dropped. A sentence of the summary can be cited as a whole; the answer then says which one. A token that cannot be opened ends the turn before anything is read or sent, and a summary none of whose sentences holds ends it after the router call, with the same fixed answer, `summary-invalid`. The summary does not depend on its stored run.

**Follow-ups and choices.** An answer on the `ask` route may carry `followUps`: at most three other template questions of the source's Ask folder (never a file query) that the elements of the answer can be put to, each with the titles of its elements and a `choice`. A choice, from a clarification or a follow-up, carries a token that binds the person, the source, the investigation, the intent and its definition, the roles that are elements, the entities and the masking, valid 15 minutes under a label of its own, so it can never be used as the token of a heavy stop. The server checks the token, reads every element of the choice again through the gate, and runs the intent as Ask runs it, with no model call; a choice leaves the same audit event and thread turn as any answered turn.

A heavy stop carries a token that binds the person, the source, the investigation, the intent and its definition, the entities and the masking, valid 15 minutes; a continue with it reads one bounded first page and calls no model, and works while Ask itself is off. With no AI provider configured, or every AI feature off, the endpoint (which the application answers itself then) answers `403` with the reason `ai-off`, as it does when only the assistant is off. The errors are listed in [the API conventions](api-conventions.md#an-assistant-turn).

## Checking it

`GET /v1/ai/status` is always there. It answers `{ "ask": { "available": … }, "summary": { "available": … }, "assistant": { "available": … } }`, with `true` for a feature that can be used now: a provider is configured, the feature is on and what it needs is in place (for Ask, its folder is loaded; for the summary, its token key file is set). With no provider configured, all three are `false`. The assistant's entry also carries `messageWords`, the effective limit of a message, when it is `true`.

A route of a feature that is switched off answers `ACCESS_DENIED` with the reason `ai-off` and the sentence "This AI feature is not available in this release yet: it is switched off, or no AI provider is configured.", audits the refusal, and reads nothing of the request. With no provider configured the AI routes of Ask and the summary do not exist and answer 404; the assistant's endpoint, `POST /v1/assistant/turns`, is answered by the application itself with `403` and the reason `ai-off`.

When the API starts with a problem in these settings, it writes one line for each problem, naming the setting, and exits 1. The start-up warnings name the setting too. A start that succeeds answers `GET /v1/ai/status` as above. `GET /v1/me` reports the edition as `enterprise` only when the older switch is on.

How well Ask classifies is measured by `pnpm ask-eval --packs domain-packs --replay tools/ask-eval/data/replay.json --baseline tools/ask-eval/data/baseline.json`, which scores a committed recording of the model's replies to the demo packs' questions with no model call (see [`tools/ask-eval`](../tools/ask-eval/README.md) for recording a live run). How well the assistant's router chooses a route is measured by `pnpm ask-eval assistant --packs domain-packs --replay tools/ask-eval/data/assistant/scripted/replay.json`, which replays a recording built from the expectations of the packs' `assistant-questions.yaml` with no model call, and the same command records, scores and compares a live run of a model (see [`tools/ask-eval`](../tools/ask-eval/README.md)). The audit queue and the thread read are measured by `services/api/src/audit/queue-burst.test.ts` and, against a real Postgres, `queue-measure.integration.test.ts`. The safety rules of Ask are tested by `pnpm test` in [`tools/ask-safety-suite`](../tools/ask-safety-suite/README.md), and its one read-transaction case by `pnpm test:neo4j` against a Neo4j Enterprise server you own.

## What you see in the app

The header bar of the workspace shows **Ask** and **Summarize**. While `GET /v1/ai/status` has not answered, nothing is drawn for them. When it says a feature is available, its control is the available one (a sparkle in the accent colour). When it says it is not, or the status could not be read, the control is dimmed: it stays reachable by keyboard, pressing it says "Not available: AI is switched off, or no AI provider is configured." and opens nothing. There is no padlock and the edition does not decide it. Summarize, the "Include AI case summary" option of the export dialog and the "AI notes" item of the investigation menu follow the summary's availability. **Ask** opens and closes the Ask panel beside the canvas; it is answered by the API routes described under [The Ask folder](#the-ask-folder).

### Asking

The panel asks one question at a time, read-only, and does not remember earlier questions. Type the question in **Your question** and press **Send**, or Enter (Shift+Enter adds a line). A counter shows the characters used out of 1,000; typing or pasting stops at the limit and the panel says so. Send is off for a blank question, while a question is out, and while the source has changed (the panel then says that questions are paused).

While Ask works, the panel says **Asking…** and the field cannot be edited. **Cancel**, or Escape, stops the question: no answer is shown and the question stays in the field. A second Escape, or Escape with no question out, closes the panel and gives the focus back to the Ask control.

### An answer

An answer shows, from the top:

- **Understood as**: the question type Ask picked, in words, and **Values taken from your question**: each entity it named, with the name of the input it fills. A file query is marked **From a file query**.
- The result: for a result with a count, the figure and its quality word, **Exact**, **Estimated**, **Lower bound** or **Unknown** (an estimated figure starts with `~`, a lower bound with `≥`); for any other result, one line for each count with its quality, or the entity it shows. A partial result says that the source was read only up to its limit, and the notices of the run follow.
- For a file query, **Rows** with one line for each row it returned: a relationship as `from → type → to`, an entity on its own line.
- **Answer**: the summary the server wrote from the result, each sentence followed by numbered markers. A marker, and each entry of **Sources** below it (the element's name and type), selects that element on the canvas when it is drawn. When it is not, the panel says why: add the result to the graph first, the element is not in this answer, it is outside the current view, or it is no longer on the graph. When the summary left elements out, a line under the sources says so.
- **Add to graph**: draws what the result lists. Its label gives the number it adds (**Add first …** when the result counts more than it lists), and after a press the panel says what was added. A result with nothing to draw says so instead. It is off while the source has changed.

When the question ran one of your own saved patterns, the answer shows the pattern's label with **Your saved pattern**, and its starting entity as **Start**, never the pattern's ID. A note says that only you see the label: others who use Ask never see it.

### A result too large to read

When a result would read more than the source allows without being asked, Ask stops before reading anything. The card shows what the question was understood as and a figure that is a lower bound at the source's threshold (for example `≥ 500 matches`, tagged **Lower bound**), never an estimate of the full size, and **Continue**. Continue reads a first page only (**Reading a first page…**) and shows it as an answer. If the stop has expired (after 15 minutes) or the graph or your access changed, the panel says that Continue is no longer valid and offers **Ask again**, which sends the same question.

### When Ask does not answer

A question Ask cannot answer gets a card titled **Ask did not answer**, with the number and name of its cause and the fixed sentence of that cause (the sentences are listed under [Asking a question](api-conventions.md#asking-a-question)); never text from the model. Below it are your question as typed, shown as text, and, where they help:

- for missing, extra and invalid inputs: **Needs** (the inputs of the question type), **Found**, and **Missing** or **Extra**, as names; what is wrong is marked;
- for nothing found: **Used**, the question type that ran;
- a line of what to try, for the causes where rewording can help.

Every card ends with **Or do it by hand** and the manual tools, which work without Ask: **Open Paths** (when the Paths tool is there), **Open Filters**, **Search by stable ID** and **Expand** (which explains how to expand a selected entity). A build without Ask in it shows the card of the cause unavailable.

A failure, such as an unavailable service, a busy source, a timeout or a rate limit, shows a short title and a sentence in words and, where trying again can help, **Try again**, which sends the same question (or the same Continue) again, held back for the wait a rate limit asks for. When the audit event or the run record cannot be written, the answer is still given: both are queued and a failure of one is counted in `GET /readyz` and logged, never shown here. The panel says that the question may have run only for the rare answer that did not match what was sent.

### Closing, a new investigation and masking

Closing the panel keeps the question and the last answer: they are there when it opens again, until another investigation is opened. A question still out when the panel closes is cancelled. Changing masking clears an answer, a heavy stop or a question that is out, and the panel says so: ask again to see the answer with the new masking.

## Upgrading

Ask's settings moved from the `ai` block of the mapping file to the environment. A mapping file that still has one of the old keys now fails to start, and the message names the key and the variable that replaces it:

| Old key | Replaced by |
|---|---|
| `ai.provider` | `NEBURYX_ASK_PROVIDER` |
| `ai.model` | `NEBURYX_ASK_CLASSIFICATION_MODEL` |
| `ai.key` (`env` or `file`) | `NEBURYX_ASK_API_KEY` or `NEBURYX_ASK_API_KEY_FILE` |
| `ai.effort` | `NEBURYX_ASK_EFFORT` |
| `ai.timeout_ms` | `NEBURYX_ASK_TIMEOUT_MS` |
| `ai.max_retries` | `NEBURYX_ASK_MAX_RETRIES` |
| `ai.max_tokens` | `NEBURYX_ASK_MAX_TOKENS` |
| `ai.cache` | `NEBURYX_AI_CACHE` and `NEBURYX_AI_CACHE_TTL` |

Remove the keys from the mapping file (leaving `ai: preview: true` only if you also want the older switch, which now decides the edition and the enterprise audit of reads), and set the variables. `NEBURYX_ASK_MAPPING_FOLDER` is new and required.

The `/v1/ask` and `/v1/ask/continue` routes are back and answer questions for template intents and file queries (see [The Ask folder](#the-ask-folder)). The settings for prompt files, property lists and the PII override are gone too (a mapping file that still has one is refused at start; remove it).

The database migration of an earlier change drops the table `ask_plans` and the column `ask_runs.plan_id`. It cannot be undone, so the previous image cannot run against the migrated database. To go back to the previous image, restore a backup taken before the upgrade. This concerns a database on which an earlier build of the enterprise code had already applied the migration that made `ask_plans`. The 0.1.0 release has no enterprise migrations, so a database that it made gets all of them in one run, in their own history, when the enterprise code is loaded (see the settings above), and the 0.1.0 image ignores that history.

## Running it with `pnpm dev`

`pnpm dev` loads the enterprise code when a provider key is set in your shell (`NEBURYX_ASK_API_KEY` or `NEBURYX_ASK_API_KEY_FILE`), or, as before, when `NEBURYX_PROFILE=enterprise` is set and `ai.preview: true` is in the mapping file the settings file names ([Run it locally](run-locally.md)). The migrate step then applies the migrations of the AI extension too, from the same variables.

The `NEBURYX_ASK_*` variables, `NEBURYX_AI_CACHE` and `NEBURYX_AI_CACHE_TTL` are passed from your shell to the API process only, and the provider key variables and the three on/off settings also to the migrate step, never to the web dev server, and never from the env file the settings name, which refuses `NEBURYX_*` names. Set them in your shell before `pnpm dev`, with `NEBURYX_ASK_MAPPING_FOLDER` pointing to a local folder, for example:

```bash
export NEBURYX_ASK_API_KEY_FILE=$HOME/.neburyx/anthropic.key
export NEBURYX_ASK_MAPPING_FOLDER=$HOME/.neburyx/ask
pnpm dev
```

The enterprise code is built once when the command starts: a change under `ee/` needs a restart, and so does a change in the Ask folder.
