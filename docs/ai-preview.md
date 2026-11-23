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

The same suite proves the assistant's guarantees through `POST /v1/assistant/turns` of the real application over a stand-in of the model service, and its table of named tests names, for each guarantee, the one kind of proof of each test (the real application, the `ee/ask` route rig, a single module or a static check) and fails when a guarantee has no test, when a row names a file that is gone, or when a test that CI does not run is not marked so:

- A follow-up resolves only to an element the application gave, or asks: a forged or invented key, a stable id or query text where a key stands, a changed value, role, intent or token of a choice or a pressed follow-up, a choice made after its lifetime or under another masking, a Continue token offered as a choice and a choice token offered as a continue each run no read of the intent, make no model call beyond the router's one repeat, and are refused as the product refuses them (an invalid choice, or not found for another person or a source the person cannot read).
- A message that asks for raw Cypher, another source or to "just run it" is refused with the fixed sentence of its cause, reads nothing and makes one model call; a router that was talked into a read passes the value only as a parameter of the folder's own statement.
- Every read of every route (the view, Ask, the agent's tools, a confirmed step, a continue) is a registered template, and each has a gate event of its own trace; a read sent straight to the executor has none and fails the check.
- A turn stops at each of its limits (steps, calls, rows, the time of the turn, the input guard) and shows the router at most the number of earlier turns the setting names; a continue and a pressed follow-up make one read and no model call.
- A streamed turn writes no line with the text the model wrote before its answer, and the answer line is the one the JSON route gives.
- The assistant's checks on a reply (every sentence or row cites an element it was given, a number must be in the cited line, no verdict wording) are shown to fail when the product's own test of each is taken out, on the answer from the view, after tool steps and for a table (`tools/summary-suite`).

The suite does not measure how well Ask classifies; that is `tools/ask-eval` (see [Checking it](#checking-it)).

### A value you write is checked against the type its question needs

When a question or a message writes an id for a role that needs a type of entity (a customer, an account), Neburyx looks the id up through the gate before the question runs, by a read by reference of the source: first one reference of the needed type for each value (a value that is of that type is settled by that one read), and only for a value that is not, a second read with one reference of each other type of the mapping, with the id as a parameter of the read and no query text. This holds for Ask, for the assistant's `ask` and `clarify` replies and the choice that follows a clarification, for the anchor of a saved pattern and for each step of the assistant's tool loop. A value of a role that has no type (a payment reference, a name to search for) is not looked up, and a type whose identifiers are tokens the server made (a type whose id is also a personal field) is never looked up from a typed value: it is left out of the references that are sent, and a value whose own role needs such a type cannot be looked up at all and gets the neutral sentence below.

- If the id is an element of another type, the answer is a fixed sentence that names both types and cites the element with the title the gate gave it ("Account AC-2 is an account; this question needs a customer. Nothing was run."). Masking applies to the title as to any read.
- If no element of the mapping has the id, the sentence says so ("There is no customer with that id. Nothing was run."). The types are named as the mapping names them for a person, in lower case, and a title longer than a sentence holds is cut.
- If the read left something out (what you may not see or export), the sentence does not say whether the element exists ("That value does not give a customer this question can use. Nothing was run."). One such element in a read makes every id of that read answer this way, which is the cautious answer.
- If a step of the agent turn writes such a value, the turn ends there with the sentence, which says that the step was not run and the results above stand, and the reads the earlier steps made; the model is not asked again.

The sentences are fixed text built from type names and a title, never words of the model. The lookup is a read through the gate like any other, audited as the read by references and by the gate's own event for each run; the closing event of the turn and the event of the question name the cause (`value-not-fit`) and how it failed (`valueKind`), never the value. It counts toward the turn's time and your rate on the source, but it is not a step or a model call of the turn and is not listed among the reads of an answer. The elements it returns are not added to the rows a tool loop may read: it compares elements and reads no rows for the answer, and it is bounded at 100 references of a kind in a read, so a turn that uses it stops at the same rows limit as the same turn without it. A key the model names for an element is checked as before, against the elements of the turn's context.

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

While a turn runs, the panel shows each read as it finishes (the tool, its kind, the subject, the rows and whether the count is exact) and, under them, the read in progress or the checking of the answer, instead of a waiting sentence; when the answer arrives the reads collapse under "Steps". The browser asks for the turn as a stream of steps ([the API conventions](api-conventions.md#a-streamed-assistant-turn)). Steps are about reads and nothing a model wrote is shown before the checked answer. Cancel closes the connection, which cancels the turn. A proxy that buffers the response makes the steps arrive with the answer; nothing else changes.

The mapping may give an entity type or a relationship type a plain-text `description` ([the mapping guide](mapping-guide.md)). The assistant sends the descriptions of the types that matter to a question (those of the elements it is given, and those the message names) as lines the model may cite, and the panel shows a cited description as "About {type}", marked as the operator's description and not as a read of the source. A question that asks only what named types or links mean is placed on a route of its own: the model only copies the names, and the server matches them to the profile's types (type, label or display name, exactly, whatever the case) and writes the answer itself, with no answer call and no view needed: the description as the operator wrote it, or a fixed sentence naming a type that has none (or whose description holds a verdict word). A name that matches no type goes to the view route. When such a question is mixed with a question about what is shown, the router adds the names to its `view` reply, and the answer from the view carries the fixed sentence for those of them that have no description; a type the message merely names, without asking what it means, gets no such sentence. The limits: descriptions state what a type is and are not evidence about any record; and a description that holds a word of the verdict list is not used at all: it is kept out of the model's input and the panel, a question about its type is answered as for a type with no description, and the start-up log warns (`assistant.description_withheld`), naming the source and the type and never the text.

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
| `NEBURYX_ASSISTANT_OVERVIEW_PROMPT_FILE` | `assistant-overview.md`, shipped with the product | |
| `NEBURYX_ASSISTANT_TYPOLOGY_FILE` | `aml-typologies.md`, shipped with the product | |

`NEBURYX_ASSISTANT_PROMPT_FILE` names an absolute path to a file that replaces the router's instructions (at most as large as a classification file of the Ask folder). The reply format is added by the product after the file's text and cannot be changed by it, and the hash of the instructions used is kept with them. No setting raises a limit or budget of a source.

`NEBURYX_ASSISTANT_VIEW_PROMPT_FILE` and `NEBURYX_ASSISTANT_TYPOLOGY_FILE` do the same for the instructions of the answer from the view: each names an absolute path to a file that replaces the shipped prompt or the shipped typology text, within the same size limit, and the reply format is added after both and is fixed. A relative path, a missing, unreadable or oversized file stops the start and names the setting, never the path or the text. The answer from the view needs no setting or file of the case summary.

### What a turn stores

For each model call of a turn the application keeps, in the tables `assistant_runs` and `assistant_run_calls` of its own database, the exact instructions and values it sent and the reply as the provider gave it (a refused, cut-off or badly formed reply too), with the status, the failure kind, the tokens and the duration. This is the one place where the text of a message and of a reply is at rest, so it holds real names and values: no route, screen, export, log line, evidence view or audit event reads or holds it, and it is removed after `NEBURYX_ASSISTANT_RUN_RETENTION_DAYS` (at start-up and every hour; a failed removal is logged as one fixed line and tried again). The records are queued when the call starts and completed when it ends, after the request has gone on: the model is never kept waiting for a write, a failed or dropped write is counted in `GET /readyz` and logged by the run id and the step (never text), and a record can be lost if the process stops while it is queued. Every audit event of the turn (the model call, the Ask read and the closing event) carries the run id, so a bad reply can be traced from the audit to what was sent. Where the extension is loaded without the application's database for these tables nothing is written, and the events still carry the run id.

### The agent turn

A message the router places on `ask` or `view`, or cannot place, is read and answered by an agent (LangChain deepagents, behind the gate) instead of one read and a fixed sentence. The router still chooses the route for what has a fixed behaviour: a refusal of a verdict with its overview, a question about what a type means, a clarification and a message that is too large. An AI case summary attached to a message is read beside the view by the view answer, as before.

The agent reads only through the tools it is offered, as native tool calls, each with exactly its parameters, each one text, never query text:

- each intent of the source's Ask folder, with its parameters;
- each template of the catalog by its id (`entity`, `degree-preview`, `expand`, `shared-attribute`, `linked-entities`, `derived-rule-run`, `derived-edge-support`, `search` and `shortest-paths`), an anchor as its entity type and stable ID, a list as one value; a path search reads at most 3 hops and 10 paths;
- each of your saved patterns, and the system and built-in patterns, under the names the model is given for them;
- the view, read again through the gate;
- the tools of your own data, below.

Nothing else is offered: the framework's own tools (files, a shell, sub-agents, planning, background tasks) are never offered or run, and a call to any other name, or one whose values do not fit the tool, runs nothing and gets a fixed sentence back. A request that names an entity type the source's mapping does not know is refused by the gate; the turn notes it as not read and goes on. A tool of a source with no Ask folder is not offered.

The agent gives its answer only through a checked `answer` tool: cited sentences, or a table when the router chose that form, put through the checks the case summary has (every sentence cites an element that was read, a number occurs in the lines it cites, a name that was not given is removed, wording of a verdict is refused and removes the whole draft). What the model writes besides is never shown, stored as an answer or put in an event. When `answer` removes sentences, the model is told how many and may answer again; the last answer that keeps a sentence stands, and when none does the turn ends with the fixed sentence "I can't support an answer from this investigation". The elements of a view keep the keys the view read gave them, the elements of the reads are `r1`, `r2` and so on, a line the server wrote for a read is `s1`, and the keys are renumbered after every read, so the model cites only the keys of the latest result. The operator's descriptions of the types the reads returned are sent as lines `m1`, `m2` under "What the types mean", quoted, with no value of the graph.

The citations of that answer name each element by the title the read gave it (masked as it was asked), so an element that is not drawn on the canvas is still named in its marker and its source line; the panel uses the graph's own title when the element is drawn.

The line of an element in the result of a tool carries the same properties as the line of an element in the view: the properties your mapping projects for its type (its `stable_id`, title, `search`, `reference`, `pii`, `filterable` and `key_properties` properties, and its `state_property`), written as the view writes them, a masked value with its mark and a property with no value shown as not shown.

An answer on the `ask` route that rests on a read of one of the folder's questions carries the same follow-ups as Ask's own answer to that read.

The turn stops at a limit: model calls (`NEBURYX_ASSISTANT_MAX_CALLS`, 5 by default), reads (`NEBURYX_ASSISTANT_MAX_STEPS`, 4 by default, and the rows setting), the time of the whole turn, and the size of what is sent. One call is kept for the answer: from the last call on, and once a limit is reached, only `answer` is offered and run, so the answer is drafted over what was read and carries the limit it stopped at (the panel shows the stop sentence under it). When the limit comes before anything was read, or the answer does not fit, the turn ends with the fixed sentence of the limit. The time is checked before each call and each read; the model call and the read in flight are stopped with the turn. Reads run in the order the model gave them, and none after a heavy stop or a cancel.

### The tools of your own data

Three more tools are offered when they can run; none of them reads anything outside what the person already has, and none writes.

- `typology`: the lines of your typology file (the list of shapes of money movement in the view instructions), as `t1`, `t2`, …. No read of the source. It is offered when the file has lines.
- `ai-notes`: the AI notes of **your own** draft of this investigation, rebuilt for you through the gate and under your masking, a line for each sentence (`a1`, `a2`, …). Another person's notes are never read: an investigation that is not yours is refused before any step, and when the application finds no notes of yours for it, the step is listed as not read and the turn goes on. Entries that cannot be rebuilt are counted as not read.
- `ai-summary`: an AI case summary of the elements in view, drafted in the turn by the summarizer (the same checks, run record and audit events as the summary), and given back as its checked sentences. It is offered only when something is in view and the summary is on. Its model calls are counted in the turn's calls limit (the summary is given no more calls than the turn has left, one kept for the answer) and the turn's event holds them in its model call count; the turn's token and model fields hold only the calls the turn's own recording made. A summary that was not drafted is a step that read nothing.

The router only chooses a route, never a tool: a message that asks what your saved AI notes say, for an AI summary of what is shown, or what the typology lists goes to the view route, and the answer from the view asks for the tool when the elements in view cannot answer. A message that asks to write, save or change a note is read and answered by the agent like any other, and no tool can write; the answer says so. A question of the source's folder that only uses the word summary stays a question of the folder.

A sentence of the notes or the summary is a line the model may cite with its `a` key; it stands for the elements it rests on, and those are the sources of the answer. The text of an `a` line is never a source of the checks (a number or a name is not checked against it), while a `t` line is your own text and is a source for what it says. A `t` line is no element. The model's reply is held to the keys the tools returned: a key that was not returned drops the sentence. No tool writes: the notes of your draft are not changed by a turn, and a summary drafted in a turn is not saved (use the summary panel for that). The typology's step shows in **Steps** as "N lines"; the other two show the rows the gate read for them.

### The steps of a turn

Every answer that read something lists its reads, in order, written by the server: the tool and what kind of tool it was (a question of the source's folder, a template of the catalog, one of your patterns, the view, the typology, your AI notes, or the AI case summary; the panel tags them Folder intent, Template, Your pattern, View, Typology, Your AI notes and AI case summary), the subject (the values the gate accepted for the tool's parameters, as Ask's "Understood as" shows them; a read whose values did not fit has none and is listed as not read), the rows it gave with the quality of that count (exact, estimated, lower bound, or no number when it is not known), and whether it is complete or partial. When the turn began from the view, the view's reading is its first read. The panel shows them as **Steps · N**, closed by default and open to one box per read; in a stop and in a confirmation they are open above the card.

### A heavy step waits for you

When a step of the agent turn (the first read included) would read what Ask stops as heavy (a read over the source's heavy-read threshold), nothing of it is read. The answer is `{ "status": "confirmation", "pendingId": …, "plan": …, "step": …, "reads": […] }`: what the step would read (its tool, subject, the count it stopped at as a lower bound, the size of one page) and the reads made so far. The panel shows the card **Waiting for you** with **Confirm**, **Skip** and **Cancel**, and nothing more runs until you choose.

The waiting turn is not held in the memory of one process: the `plan` is a signed token naming the step it waits on, the earlier steps of the turn (tools and the values the gate accepted, never a result), the counters and the hash of the message and of the view's keys, bound to you, the source, the investigation, the definition of the tool and the masking, under its own label (never valid as a choice or a continue token); and a small row of the table `assistant_pending_confirmations` (the id, who and where, its status and its expiry, never a value, an element or a result) makes it single-use and holds one waiting confirmation per person, across investigations. So a decision works on any copy of the application and after a restart. The decision is a request of its own (`message` as typed, the keys of the view of the waiting turn, and `confirmation: { pendingId, plan, decision }`): **Confirm** reads the earlier steps again through the gate (their results were never kept, so they are as of now and as masked now, and may differ from the first time; the read goes through your read slots and each has an audit event marked as made again), reads the heavy step as one bounded page and goes on; **Skip** reads the earlier steps again, leaves the step out and goes on; **Cancel** reads nothing. A confirmation never lifts a limit: the limits are checked again before the step is read, and the time spent waiting does not count. A confirmation that was used, replaced (by a new confirmation or by any new message of yours), cancelled, expired (15 minutes; found when it is used or when you add another, never by a timer), altered, or whose message or view is not the one it was made for, is `{ "status": "confirmation-invalid", "sentence": "This confirmation is no longer valid. Nothing was read." }`. After a reload a turn that was waiting shows its message and the line that it is no longer open; send a new message to go on.

### Refusals in the panel

A refusal, and the refusal of an Ask question inside a turn, shows in the panel as a card titled **Not answered** with the fixed sentence of its cause under the message as typed, never a word of the model, and the shortcuts **Open Filters**, **Summarize this view** and **Open Paths**. Open Filters and Open Paths open that tool, and leave it open if it already is. **Summarize this view** starts a draft of the AI case summary (a model call) and closes the assistant panel; it is dimmed with the reason when the summary is not available. **Open Paths** shows only when the build has the Paths tool, and a line says it is left out when it does not.

### An overview beside a refusal of a verdict

When a message asks for a verdict (guilt, intent, risk), the refusal says what the assistant cannot judge and, when it can, shows **What the investigation connects** beside it: up to five cited sentences that state only what is connected, grouped as the prompt asks (elements that link to the same element first, then the relationships of one type that leave one element in a sentence; the server does not count or enforce the grouping) (the relationships between the elements in view, what they share, the payments between them; the prompt asks for no property of a node and no sentence about what is missing, and the server keeps only the sentences that rest on a relationship), the two lines of coverage the server writes, and the line "An overview of the view, not an assessment." The overview is drafted by the same path as an answer from the view and put through the same checks (every sentence cites elements in view, numbers and names must be in the cited lines, no verdict wording), with a prompt of its own (`assistant.overview`, replaceable with `NEBURYX_ASSISTANT_OVERVIEW_PROMPT_FILE`). The model call that drafts it is sent the elements in view and a request the server wrote: nothing of the message you typed, of the thread or of an attached summary. It is one more model call (audited as `assistant.overview`) and uses the calls the turn has left (`NEBURYX_ASSISTANT_MAX_CALLS`).

When no overview can be drawn (no call left, an empty view, no relationship in view or no sentence that rests on one, a person who may not use the view route, a draft that holds a verdict word or has no sentence left after the checks, a failed call or the turn's time limit) the refusal is shown alone, as before, and says nothing of the attempt. The turn is stored in the thread as a refusal of a verdict, as references only, and does not change what the next turn is given.

### Cancel

Closing the connection of `POST /v1/assistant/turns` cancels the turn: the model call in flight is aborted, no read of the source starts after it, and a read already running is ended through the same signal. The turn's closing event and its stored run say `cancelled`, and a cancelled turn is not kept in the thread. In the panel, **Cancel** replaces **Send** while a turn is out. A cancelled message shows a Cancelled turn and puts the message back in the field; a cancelled Continue returns the turn to its heavy stop with Continue available. Nothing a cancelled turn had already read is undone.

### The thread

Each assistant turn that ends answered or refused on a route is kept in the person's thread of the investigation (`assistant_threads`, `assistant_turns`) as references and metadata only: the route and how it ended, the cause of a refusal, the intent and template it ran, a keyed hash of the message, the element each parameter resolved to and the elements and relationships the answer cited (references, never their content), the number of reads, the model reference, the prompt version, the tokens and the run id. **No question, no answer, no parameter value and no instruction is stored in the thread.** The hash is made with the application's signing key, so a short message cannot be confirmed by guessing. A turn that failed, was cancelled or was not let through (too long, too large, a continue that is not valid) is not kept. The thread is never used for training; nothing in the product sends it anywhere. This is what lets a later message use what an earlier one did without the text of either being kept.

A thread is **cleared when its investigation is closed, archived or deleted**, in the transaction of that change (a trigger of the migration, so no path that changes the status can skip it); a reopened investigation starts with no thread. A turn that began before the investigation was cleared cannot write into it afterwards: it reads the investigation's clearing count before it does any other work, and its write is refused when the count has moved or the investigation is not open. The number of turns a thread keeps is not decided: nothing is trimmed, and the thread goes when the investigation is closed. The setting `NEBURYX_ASSISTANT_THREAD_RETENTION` names this rule (`close`, its only value).

The thread's writes are queued like the model-call records, off the request path: a failed or dropped write is counted in `GET /readyz` and logged by the turn id and the step, never text, and never changes the answer. `GET /v1/assistant/investigations/{id}/thread` gives the caller their own thread as the kind and end of each turn and the number of things it cited (the most recent turns, 100 by default, and how many older ones there are: nothing stored is trimmed), and says when their previous thread was cleared if they have none since; an investigation that is not the caller's is `NOT_FOUND`. The text a person typed lives only in the panel's session in the browser and is gone when the browser session ends; the thread keeps the routes and intents, and the analyst keeps the source of truth, the graph and the notes.

### A table answer

When a message asks for the answer as a table ("show the accounts in view as a table"), the router adds `"form":"table"` to its reply for the view and only then; the words of the message alone never decide it, and an Ask question is always answered in sentences. The model is then asked for a table in place of sentences: 1 to 6 columns with short plain labels, and one row for each element, each row a list of cells (one for each column, copied as the element line writes it, or empty) and the keys of the elements the row is about. Each row is checked as a sentence is: it must cite an element, a number in a cell must occur in the line it cites, a name that was not given removes the row, a key written in a cell removes the row, and a verdict word in a cell ends the answer as it does a sentence; a column label must be plain words that the lines sent give or a short fixed list (element, type, date, amount, direction, and the like). A row that cites a sentence of an attached summary is removed. The model may write up to 100 rows and the first 25 that pass are shown.

The answer is `{ status: "answered", route: "view", table, citations, coverage, model, calls }` (with `steps`, `reads` and `stoppedAt` after tool steps). `table` holds the title, the columns and the rows (`cells` and `cites`), `droppedRows` (rows the checks removed, when any) and `moreNotShown` (rows the model wrote beyond the 25 shown, when any). The title and the coverage are written by the server: the title is `<type plural> of <title of the anchor> · N rows` for a table from one read of the neighbours of one element, otherwise `<type plural> · N rows` (`Elements · N rows` when the rows are about several types), and the coverage reads "N of M <type> in view shown" for the view and "N of M <type> read shown" after tool steps, with the label of the count's quality (exact, estimated, lower bound) as the line writes it. The panel draws the table with a **Cite** column, a marker for each element a row cites, the sources and the coverage; a table of more than 10 rows shows its first three rows and its last, folds the rest behind a line that opens it, and says **More not shown** with the server's counts when `moreNotShown` is set. The closing event records the form and counts only (`form`, `tableRowsShown`, `tableRowsDropped`, `tableRowsNotShown`), never a cell, a label or a title, and the thread keeps the cited elements as references as it does for sentences ([audit events](audit-events.md)).

### A turn

`POST /v1/assistant/turns` takes a message (`{ sourceId, investigationId, message, viewElementKeys, mask? }`) or the continue of a heavy stop (`continue: { intent, entities, continueToken }` in place of `message`), or the choice of an element that a clarification or a follow-up offered (`choice: { intent, roles, entities, choiceToken }` in place of `message`), never two of them; `viewElementKeys` names at most 300 elements of the view, never their content. The server checks that the investigation is the caller's and belongs to the source before any model call, refuses a message over `NEBURYX_ASSISTANT_MAX_MESSAGE_WORDS` words, and makes one audited call of the router, whose reply must be exactly one route object (a reply that is not one is asked for once more with a fixed note when `NEBURYX_ASSISTANT_MAX_CALLS` leaves room for the answer after it, and a second one is the `unplaced` refusal). The answer is one of:

- a refusal with a cause (`verdict`, `raw-query`, `other-source`, `unplaced`) and a fixed sentence the server chooses, never a word of the model; a reply that is not a route, and a refusal the router gives as `unplaced`, goes to the agent, and the `unplaced` refusal is given only when the agent cannot start; a refusal of a verdict also carries a neutral overview of the elements in view when one can be drawn (see below);
- `answered` on the `view` route: sentences that each cite the elements of the view they rest on (`sentences`, `citations`, the model and the number of calls), written from the elements the server read again through the gate (never from content the browser sent) and kept only when every check passes; `not-answered` when no sentence survives or the view holds nothing readable;
- `answered` on the `ask` route: the same answer `POST /v1/ask` gives for an intent of the source's Ask folder (a result with its cited summary and sources, a heavy stop with its token, or one of Ask's refusals), plus, for a result that was read, a `step` (the intent, the number of elements it lists, whether it is complete) and a `coverage` line the server writes (how much is shown, how much is not yet retrieved, with the quality of the count);
- a `clarification` when the message cannot be placed on one element and the assistant asks instead of guessing: the fixed question naming the entity type ("Which … do you mean?"), and each element it may mean as the person sees it (title and entity type), with the `choice` the panel sends when one is picked. Nothing was read for the intent. The candidates are elements of the person's own thread and of the view, at most five, newest first. A clarification is not kept in the thread;
- `choice-invalid` for a choice whose token is expired, altered, another person's, another investigation's or another masking's, whose intent changed since, or whose element the gate no longer reads: nothing was read;
- `answered` on the `ask` route (on the `view` route when the loop began from the view) after tool steps: `sentences`, `citations`, `coverage`, the model, `calls` and `steps` (1 or more: a plain Ask turn answered over the property values of its one read has one), as above; or `limit` with the limit that ended the turn;
- `unavailable` when the model's service or the source fails (`kind`, and whether a read had started); `too-large` when the message and the view are over `NEBURYX_ASSISTANT_MAX_INPUT_TOKENS`; `too-long` over the word limit; `continue-invalid` for a continue whose token is expired, altered, another person's, another investigation's or for a changed intent, entities, masking or definition.

**The context of a follow-up.** The router is shown the last `NEBURYX_ASSISTANT_CONTEXT_TURNS` turns of the person's own thread of this investigation: for each, its route, the intent it ran, the elements it ran the intent for and the elements it cited, each as a key of this turn (`c1`, `c2`, …) with its title as the person sees it, read again through the gate for this message so masking and access are as of now; a refused turn gives only its cause, and no text of any message or reply is in it (none is stored). Another person's turns, another investigation's and another source's are never in it. A message that refers to an earlier element without naming it ("the other one") is answered by the router naming the element by its key in a member of its own, never by its text; the server looks the key up in the keys it made for this turn, runs the intent with that element's stable ID as a parameter, and treats any other key as naming nothing: a message that names nothing it holds becomes a clarification when elements of the right entity type are at hand, and the fixed `unplaced` refusal when none are.

**A follow-up that names no element.** A message that needs an element of an intent's input, writes none and says nothing like "it" or "that account" is placed on the one element of the needed entity type that the earlier turns or the view hold, when there is exactly one (an element held by both counts once): the router prompt asks the model to name that element by its key, before the pack's instruction to choose null for a missing value, and the server checks the key as it checks any other and runs the intent for that element through the gate. With two or more elements of the type the assistant asks which one is meant, and with none it answers that it cannot place the message. The model names the element and the server checks it; neither picks "the most recent" or any one of several. A value the message writes is used as written, whatever else is held. A selection on the canvas that settles the referent comes first (see the selection below): this rule applies when nothing is selected or no selected element fits. The follow-up chips you press run the question they carry with no model call and are not changed by this.

**The elements in view, named by key.** The router is also shown the elements in view, each entity as a key of the same table (`c4`, …) with its type and its id as the client sent them (no title, and no read of the source for this), the relationships in view as lines with their own keys, their type and the ends the client sent, and an element that is also in the thread keeps the key the thread gave it. A key resolves only to an element of the view or of the thread, of the entity type the role takes: a key of a relationship, of another entity type or of nothing names nothing for the role, and a stable id written where a key stands makes the reply not a route. When the message could mean one of several elements of the type in view, the clarification offers them, and the title of one that only the view holds is read again through the gate for this message's masking, and left out if the gate does not give it back.

**An attached summary.** A message may carry `summaryToken`, the token of an AI case summary. The token is opened for every turn with the person, the investigation and the policy version in force (nothing of the summary is stored by the thread; the browser holds the token). When the router places the message on the view, the elements the summary's sentences cite are read again through the gate together with the elements in view (at most 300 together), each sentence is judged again against what was read, and the sentences that still hold are given to the model as context beside the elements; the answer's checks read the elements alone, so a name or a figure that only the summary states is dropped. A sentence of the summary can be cited as a whole; the answer then says which one. A token that cannot be opened ends the turn before anything is read or sent, and a summary none of whose sentences holds ends it after the router call, with the same fixed answer, `summary-invalid`. The summary does not depend on its stored run.

**The selection on the canvas.** A typed message may carry `selectionKeys`, the keys of the elements the person has selected on the canvas; a follow-up chip, a choice, a continue and the decision of a confirmation carry none. The server keeps the keys that are in the view, once each, in the view's order. It is a hint and nothing more: the router is shown a mark `(selected)` on the lines of those elements and is told that "this", "it" and "the selected one" mean them, so a question about one element of the needed type names it, a question that fits several selected elements (or a selected one and an element of an earlier turn) asks which, and a selected element of another type than the question needs is no referent; the answer from the view is given a line naming the selected elements by their keys and is told to answer about them. The selection is not given to the step calls of the tool loop and is not part of the text the checks read, so it supports no sentence and no citation. It is kept nowhere but in the stored run of the turn (the text the calls were sent) and as a count in the closing audit event (`selectedElements`, never a key or a title); the thread holds none of it and the next turn is read with the selection it is sent with.

**Follow-ups and choices.** An answer on the `ask` route may carry `followUps`: at most three other template questions of the source's Ask folder (never a file query) that the elements of the answer can be put to, each with the titles of its elements and a `choice`. A choice, from a clarification or a follow-up, carries a token that binds the person, the source, the investigation, the intent and its definition, the roles that are elements, the entities and the masking, valid 15 minutes under a label of its own, so it can never be used as the token of a heavy stop. The server checks the token, reads every element of the choice again through the gate, and runs the intent as Ask runs it, with no model call; a choice leaves the same audit event and thread turn as any answered turn.

A heavy stop carries a token that binds the person, the source, the investigation, the intent and its definition, the entities and the masking, valid 15 minutes; a continue with it reads one bounded first page and calls no model, and works while Ask itself is off. With no AI provider configured, or every AI feature off, the endpoint (which the application answers itself then) answers `403` with the reason `ai-off`, as it does when only the assistant is off. The errors are listed in [the API conventions](api-conventions.md#an-assistant-turn).

## Checking it

`GET /v1/ai/status` is always there. It answers `{ "ask": { "available": … }, "summary": { "available": … }, "assistant": { "available": … } }`, with `true` for a feature that can be used now: a provider is configured, the feature is on and what it needs is in place (for Ask, its folder is loaded; for the summary, its token key file is set). With no provider configured, all three are `false`. The assistant's entry also carries `messageWords`, the effective limit of a message, when it is `true`.

A route of a feature that is switched off answers `ACCESS_DENIED` with the reason `ai-off` and the sentence "This AI feature is not available in this release yet: it is switched off, or no AI provider is configured.", audits the refusal, and reads nothing of the request. With no provider configured the AI routes of Ask and the summary do not exist and answer 404; the assistant's endpoint, `POST /v1/assistant/turns`, is answered by the application itself with `403` and the reason `ai-off`.

When the API starts with a problem in these settings, it writes one line for each problem, naming the setting, and exits 1. The start-up warnings name the setting too. A start that succeeds answers `GET /v1/ai/status` as above. `GET /v1/me` reports the edition as `enterprise` only when the older switch is on.

How well Ask classifies is measured by `pnpm ask-eval --packs domain-packs --replay tools/ask-eval/data/replay.json --baseline tools/ask-eval/data/baseline.json`, which scores a committed recording of the model's replies to the demo packs' questions with no model call (see [`tools/ask-eval`](../tools/ask-eval/README.md) for recording a live run). How well the assistant's router chooses a route is measured by `pnpm ask-eval assistant --packs domain-packs --replay tools/ask-eval/data/assistant/scripted/replay.json`, which replays a recording built from the expectations of the packs' `assistant-questions.yaml` with no model call, and the same command records, scores and compares a live run of a model (see [`tools/ask-eval`](../tools/ask-eval/README.md)). The audit queue and the thread read are measured by `services/api/src/audit/queue-burst.test.ts` and, against a real Postgres, `queue-measure.integration.test.ts`. The safety rules of Ask are tested by `pnpm test` in [`tools/ask-safety-suite`](../tools/ask-safety-suite/README.md), and its one read-transaction case by `pnpm test:neo4j` against a Neo4j Enterprise server you own.

The release check of the preview, `pnpm check:ask-preview`, runs the checks of the Ask preview in one command and writes down the result with a figure for each criterion: Ask's accuracy against its baseline, the safety suite, the cited summary, the summary's and the assistant's replies on the demo views, the assistant's route accuracy against its baselines, and that the preview runs on any source under the data rules and the audit. It makes no model call. See [tools/release-checks](../tools/release-checks/README.md#the-ask-preview-gate).

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
