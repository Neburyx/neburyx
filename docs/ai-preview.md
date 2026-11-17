# Switch the AI features on

Ask, the AI case summary and the investigation assistant are on wherever an AI provider is configured. They need no profile and no switch in the mapping file: give the API a provider key (see [The key file](#the-key-file)) and the features that can run start. Each has a setting that turns it off.

| Variable | What it does |
|---|---|
| `NEBURYX_ASK_ENABLED` | `off` turns Ask off; `on`, empty or unset leaves it on |
| `NEBURYX_SUMMARY_ENABLED` | `off` turns the AI case summary off; `on`, empty or unset leaves it on |
| `NEBURYX_ASSISTANT_ENABLED` | `off` turns the assistant off; `on`, empty or unset leaves it on |

These three are read only when a provider key (`NEBURYX_ASK_API_KEY` or `NEBURYX_ASK_API_KEY_FILE`) is set; a value that is neither `on` nor `off` stops the start and names the variable, never the value. With no provider key none of the AI features is available and nothing of them runs. With a key and Ask and the summary both off, the AI code is not loaded.

Ask needs its folder of intents (`NEBURYX_ASK_MAPPING_FOLDER`, see [The Ask folder](#the-ask-folder)): with Ask on and a key set but no folder, the start stops and names the setting. Set `NEBURYX_ASK_ENABLED=off` for a deployment that wants only the summary. The summary also needs its token key file before it is available (see [`GET /v1/ai/status`](#checking-it)).

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

Each question writes one audit event, `ask.question` (`ask.continue` for a continue), with the intent's name, the kind, the outcome, the cause, the template id, a keyed hash of the parameters and the number of elements listed (for a saved pattern, also its ID and version, never its label). It never holds an entity value, the question or a sentence. The model call that classifies is audited by its own event (`ask.classify`), as under [Prompt caching](#prompt-caching). If an event cannot be written, the answer is withheld.

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

The assistant's settings are read when a provider key is set and the assistant is on; a value that is not a whole number in its range stops the start and names the variable, never the value. The defaults and ceilings are hypotheses to be measured, except the timeout of a call, the calls, the words of a message and the turns of context, which are given.

| Variable | Default | Ceiling |
|---|---|---|
| `NEBURYX_ASSISTANT_MODEL` | `claude-sonnet-5-5` | |
| `NEBURYX_ASSISTANT_TIMEOUT_MS` (one model call) | 60000 | 600000, and not above the total |
| `NEBURYX_ASSISTANT_TOTAL_TIMEOUT_MS` (a whole turn) | 180000 | 600000 |
| `NEBURYX_ASSISTANT_MAX_CALLS` (model calls a turn) | 5 | 10 |
| `NEBURYX_ASSISTANT_MAX_STEPS` (reads a turn) | 4 | 8 |
| `NEBURYX_ASSISTANT_MAX_ROWS` (rows read a turn) | the source's own page limit times the steps | an operator may only lower it |
| `NEBURYX_ASSISTANT_CONTEXT_TURNS` (earlier turns the router sees) | 3 | 6 |
| `NEBURYX_ASSISTANT_MAX_MESSAGE_WORDS` | 1000 | 3000 |
| `NEBURYX_ASSISTANT_MAX_INPUT_TOKENS` | 25000 | 100000 |
| `NEBURYX_ASSISTANT_MAX_OUTPUT_TOKENS` | 4000 | 32000 |
| `NEBURYX_ASSISTANT_PROMPT_FILE` | the file shipped with the product | |

`NEBURYX_ASSISTANT_PROMPT_FILE` names an absolute path to a file that replaces the router's instructions (at most as large as a classification file of the Ask folder). The reply format is added by the product after the file's text and cannot be changed by it, and the hash of the instructions used is kept with them. No setting raises a limit or budget of a source.

## Checking it

`GET /v1/ai/status` is always there. It answers `{ "ask": { "available": … }, "summary": { "available": … }, "assistant": { "available": … } }`, with `true` for a feature that can be used now: a provider is configured, the feature is on and what it needs is in place (for Ask, its folder is loaded; for the summary, its token key file is set). With no provider configured, all three are `false`. The assistant is `false` until it is built.

A route of a feature that is switched off answers `ACCESS_DENIED` with the reason `ai-off` and the sentence "This AI feature is not available in this release yet: it is switched off, or no AI provider is configured.", audits the refusal, and reads nothing of the request. With no provider configured the AI routes do not exist and answer 404.

When the API starts with a problem in these settings, it writes one line for each problem, naming the setting, and exits 1. The start-up warnings name the setting too. A start that succeeds answers `GET /v1/ai/status` as above. `GET /v1/me` reports the edition as `enterprise` only when the older switch is on.

How well Ask classifies is measured by `pnpm ask-eval --packs domain-packs --replay tools/ask-eval/data/replay.json --baseline tools/ask-eval/data/baseline.json`, which scores a committed recording of the model's replies to the demo packs' questions with no model call (see [`tools/ask-eval`](../tools/ask-eval/README.md) for recording a live run). The safety rules of Ask are tested by `pnpm test` in [`tools/ask-safety-suite`](../tools/ask-safety-suite/README.md), and its one read-transaction case by `pnpm test:neo4j` against a Neo4j Enterprise server you own.

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

A failure, such as an unavailable service, a busy source, a timeout or a rate limit, shows a short title and a sentence in words and, where trying again can help, **Try again**, which sends the same question (or the same Continue) again, held back for the wait a rate limit asks for. When the audit record cannot be written, the answer is withheld and the panel says that the question may have run.

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
