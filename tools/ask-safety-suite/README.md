# tools/ask-safety-suite

Tests that the Ask design holds its safety rules, one hostile case at a time from the question to the source and to every record: the real application, the real enterprise extension with its own classifier and provider over a stand-in of the model service on the loopback address, the real gate over a scripted source that records the text and the parameters of every read, and recording sinks for the audit events, the rows of `ask_runs` and the logs. No live model call is made.

| Command | Runs |
|---|---|
| `pnpm test` (from the root, or in this folder) | Every case but one. No server, no network beyond loopback. They run in CI. |
| `pnpm test:neo4j` (from the root) | The case that needs a real read transaction: a write that no text check stops, asked as a question on a login that can write, against a Neo4j Enterprise server you own, as the other Neo4j tests do (see [`packages/test-neo4j`](../../packages/test-neo4j/README.md)). Not in CI. |

## How it is built

- `src/rig.ts` starts the application with the extension a test file gives it, and keeps what happened: the reads at the source, the events of the application's audit seam (the route's and the gate's), the events of the extension's own sink (the classification's model calls), the rows of `ask_runs` and the log lines. It imports no enterprise package, because the open-core check lets only test files import them: each test file builds the extension, the model stand-in and the run store itself, and carries its own `vi.mock` of `@neburyx/ee-audit` (that mocked module is in `src/mock-audit.ts`).
- `src/checks.ts` holds the three checks: `expectOnlyParameters` (the statement is exactly the expected text and each value reached the source as a parameter equal to what was typed; a value that is inside the folder's own text is not a failure by itself), `expectProviderInput` (the request body is exactly the expected body, key for key) and `expectNoValue` (no record holds a sentinel). Each has a canary: a test that gives it a deliberately leaky input and proves that it throws, so a check that cannot fail is found.
- `src/hostile.ts` is the table of hostile values, each with a sentinel inside it: the checks search for the sentinel, never for the value's punctuation.

## Named tests

`src/named-tests.test.ts` fails if a test named here is not found in its file. The first column says what it proves; the files outside this folder are existing tests that the suite relies on.

| What it proves | File | Test |
|---|---|---|
| A value reaches a file query only as a parameter, and the statement is the folder's own text | `src/parameters.test.ts` | own query text for a value that holds |
| The same for a template that takes an ID | `src/parameters.test.ts` | sends the same statement of the entity template |
| The same for a search | `src/parameters.test.ts` | in a search as a parameter of the search |
| A hostile value stays a parameter through Continue, with no new model call | `src/parameters.test.ts` | keeps a hostile value a parameter through Continue |
| A leaky query is caught | `src/parameters.test.ts` | canary: the check fails when a leaky executor |
| An instruction typed into a question runs nothing | `src/injection.test.ts` | treats a question that holds |
| A reply that fits runs once, with the entities only | `src/injection.test.ts` | runs a reply that fits and names an intent of the folder once |
| A reply with an entity too many, too few or too long is refused as the reply reader or the binding refuses it | `src/injection.test.ts` | refuses a reply with |
| A folder with a write, a call, LOAD CSV or a second statement is refused at start-up | `src/file-queries.test.ts` | refuses a start for %s, naming the file |
| A parameter that is not declared is refused at start-up | `src/file-queries.test.ts` | refuses a start for a query that names a parameter |
| A query forced past the loader is refused by the gate before any read | `src/file-queries.test.ts` | answers the gate |
| The route checks its own folder and the gate its own | `src/file-queries.test.ts` | shows that the route checks |
| A result of a type the mapping does not name is refused whole | `src/file-queries.test.ts` | refuses %s as file-query-result |
| The read transaction refuses a write that passed every text check (Neo4j) | `src/file-query-transaction.neo4j.test.ts` | is refused by the explicit READ transaction on a login that can write |
| The provider receives the instructions and the raw question, cached | `src/provider-input.test.ts` | is the instructions as the one cached system block |
| The same with caching off | `src/provider-input.test.ts` | is one user message that joins the instructions |
| A question with text that looks like an instruction is sent as typed | `src/provider-input.test.ts` | is the same body for a question that holds text |
| No property value of a result reaches the provider, and the model is called once for each question | `src/provider-input.test.ts` | holds no property value in any request of any later question |
| For a person with saved patterns the provider receives their own catalog and no id, version, anchor or other person's pattern | `src/provider-input.test.ts` | is the question, the fixed note and the catalog |
| No id of a pattern is in any request | `src/provider-input.test.ts` | carries no id of any pattern |
| A leaky provider input is caught | `src/provider-input.test.ts` | canary: a request that carries a property value |
| No event, row, log line or problem response holds a value, the question or a label | `src/records.test.ts` | holds nothing of them after an answered question |
| The same for a saved pattern's label and anchor | `src/records.test.ts` | label or anchor: not its run |
| A leaky sink is caught | `src/records.test.ts` | canary: a sink that adds a sentinel |
| Nothing is redacted or withheld in the request path | `src/records.test.ts` | sends the model the question exactly as typed |
| Masking applies to the result nodes only: the model and the source receive the same | `src/records.test.ts` | masks the personal property of the result nodes |
| The checks fail on a leaky input | `src/checks.test.ts` | canary: fails a statement with a value built into its text |
| A case that never ran cannot pass | `src/rig.test.ts` | counts what a case expects |
| The settings that withheld a property from the model are refused as unknown keys of the mapping file | `../../services/api/src/mapping/ai.test.ts` | refuses %s as a key the section does not have |
| The loader names the intent and never the text of a bad query | `../../ee/ask/src/folder/load.test.ts` | naming the intent and not the text |
