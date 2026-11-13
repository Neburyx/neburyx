# Input fuzz suite

The suite sends hostile input to every request input that reaches the read gate and checks two things: **no input reaches Neo4j as statement text**, and **bad input is refused at validate with the right error code**. It runs with the unit tests (`pnpm test`, the `unit` CI job) and needs no server.

Files are in `services/api/src/fuzz/`, with the rig in `services/api/src/testing/fuzz-rig.ts`, `fuzz-closed-set.ts` and `fuzz-corpus.ts`.

## What it checks

**The closed set.** The rig runs the real app and gate over a recording executor. Before the fuzz starts it sends every legal choice of each read route once (entity types, relationship types, directions, match modes, groups, masked and unmasked, an expansion with no window, a window of days and a window of dates, an expansion of the third source over a relationship with no time property, first pages and next pages, and for the pattern routes: every preset and each template by its own ID, one and two hops, each direction, no window, a window of days and a window of dates, with and without a minimum of shared nodes, masked and not, always a first run; each run reads its estimate first, so the count statement of each pattern template is in the set, and a run with the continue flag, which reads none, is sent for each template) and keeps the statement text the executor saw. That set is the *closed set*: the fixed templates with allowlisted names. For every fuzz request the suite then checks that

- the closed set holds none of the values used to build it (`W-1`, the search text, the phone values, the cursors and tokens it minted), so a template that wrote a request value into its text would be found;
- every statement the executor saw is in the closed set;
- every name a statement quotes in backticks is a label, relationship type or property of the mapping;
- no hostile string of the request (four characters or longer) appears in any statement. It may appear in the parameters only;
- a request refused before the gate leaves the executor with no call at all (search more: at most the index-snapshot read).

A test feeds the check a statement built from text and shows it fails.

**Every route is in the set.** (`POST /v1/investigations`, which reads the entity once through the gate when it opens one, is built into the set; no hostile request to it is part of the recorded run below.) `fuzz/completeness.test.ts` compares the routes the closed set was built from (the builder records each route it requests) with the routes the API registers under `/v1`, less a named list with a reason for each: the routes that read no source, and the source test, which runs the tester and not a gate template. A route the builder does not request fails the test, so removing a route from the set, or adding a source-reading route and leaving it out, cannot pass unseen. Negative tests feed the check a set with one route missing. The cancellation route list (`graph/cancel-routes.test.ts`) and the concurrency suite's (`tools/concurrency-suite/src/routes.test.ts`) are compared with the registered routes the same way.

**The estimate cases are in the set.** Beside the routes, the closed set records the pattern-run cases it was built from for each pattern template (`shared-attribute:estimate`, `shared-attribute:continue`, `shared-attribute:heavy`, `linked-entities:estimate`, `linked-entities:continue`, `linked-entities:heavy`, and `pattern:estimate`, `pattern:continue`, `pattern:heavy` for the pattern run) and the completeness test requires each of them and the count statement of each template (a negative feeds it a set without one). The `heavy` case runs each preset and each template for an anchor whose count probe answers more matches than the source's threshold: the answer is the stop, with a lower bound at the threshold and no rows, and the set is built only if it is. `fuzz/templates.test.ts` also checks that the stop reads nothing but the count statement, that a continue reads no estimate and no more than a first page of 25, and that hostile text in the anchor reaches the count statement as a parameter only.

**The pattern runs are checked by a grammar, not by membership.** The statements the compiler writes for a definition are a function of its shape, and the shapes are too many to put in a set. So `POST /v1/patterns/run` adds no statement to the closed set: the builder sends the cases it knows (one step out and in both directions, node and relationship conditions, a window of each form, two steps through a type on a stop-list and through one with none, four steps, the reads that skip a supernode and a stop-listed entity), keeps the statements apart, and checks each of them, and every pattern statement the fuzz later sees, against a grammar. The values of those requests (the condition text, the instants, the anchors) are in the leak check, so a statement that held one would be found.

**The grammar** (`testing/pattern-grammar.ts`) is learned from the compiler's own output, not written by hand: every name of the source's mapping becomes a token of its kind, a condition's position becomes a mark with the largest position seen, the step index is kept, the statement length is bounded by the longest seen, and the language is the set of runs of 6 tokens seen in the corpus. The corpus is the enumerated shapes, 600 shapes drawn at random from seed 5017, every aspect of a step at every step position, the ends of a statement, every position of a condition at every step, the longest statements, and the paths of the stop-list rules. A statement is accepted if its length is within the bound and every run of 6 tokens in it was seen. It over-approximates on purpose: it accepts a statement the compiler never wrote if its parts were each seen, and it refuses one that holds a token or a join of tokens that no compiler output holds. It holds for a mapping whose names have the kinds the corpus holds; a kind it never saw is refused. The grammar module holds no Cypher keyword. `fuzz/pattern-grammar.test.ts` checks that it accepts every statement the compiler writes for the shapes and refuses a set of altered statements. The count statement a run reads first (the pattern count template) is checked the same way by a grammar of its own, learned from the count statement of each shape and path of the corpus; the count statements of the builder are also in the closed set, and each is pinned in the fragment goldens beside the run's own (the entries named `count/…`). Every fuzz file that builds the closed set or sees a pattern call learns the grammar once per worker, from several thousand statements.

**The shapes.** A shape is what decides the statement text: an ordered list of steps, each with a direction, a class of relationship types (the ordered groups of types, each timed or not, and how many have no stable ID; the stop-list rules belong to the arrival types and are part of the shape), a window or not, and an ordered list of conditions on the neighbor and on the relationship, each of 37 forms. The number of shapes under the caps (4 steps, 6 conditions on a target, 24 in a pattern) is given by a recurrence in `testing/pattern-shapes.ts` (`shapeCount`), checked against a brute-force count at small caps in `fuzz/pattern-shapes.test.ts`. It counts shapes, not distinct statements: a window on untimed types writes the text of no window. The shapes with at most this many steps:

| Steps | Shapes |
|---|---|
| 1 | 1,687,589,190,894,791,302,442,370 |
| 2 | 8,543,871,831,674,809,078,248,541,372,250,529,476,972,816,093,070 |
| 3 | 1,451,199,502,606,346,917,990,720,673,872,710,867,807,969,054,880,652,070 |
| 4 | 8,882,862,577,183,253,101,032,046,839,953,628,228,617,949,013,031,205,002,070 |

That product is not enumerated and cannot be. The suite enumerates the **1,357** shapes of the smallest sizes (checked to be over 1,000 and under the count), and `fuzz/pattern-run.test.ts` also draws 400 more at random from seed 8821, a seed the grammar corpus does not use, so that the grammar is checked on statements it was not learned from. It sends each of them through the real route and gate over a recording executor, and checks every statement the executor saw: accepted by the grammar, no value of the request in it, only names of the mapping quoted. Its requests are not in the recorded run below. `gate/templates/pattern-fragments.golden.test.ts` holds the fragments of the compiler: the text each part writes for the minimal shapes and for one changed input. The values the builder uses for the pattern cases (the supernode and stop-list anchors, the instants, the condition text) are in the leak check of its statements, as are those of the other routes.

**The matched properties.** The exact group of a search answer and of a next page names the `search` properties that held the typed text (`exactMatches` and `matches`). `fuzz/routes.test.ts` sends hostile texts, masked and not, and checks that every name is a `search` property of the mapping; the answer adds no statement, so the closed set is the one above.

**The refusals.** Each of these is a property over generated input, with the codes the API returns:

| Input | Answer |
|---|---|
| Wrong type, missing key, extra key, text one over its cap (search text 201 characters, lookup value 100,001 units, reference 266,692 units, path segment 401 units), control character or lone surrogate in a path segment, malformed JSON, body over 1 MiB | `INVALID_REQUEST`, no read |
| Content type that is not JSON (plain text is read as a string and refused as `INVALID_REQUEST`) | `UNSUPPORTED_MEDIA_TYPE` |
| Unknown source | `NOT_FOUND` |
| `GET /v1/edges/{ref}`: a segment that is not the unpadded base64url text of a stored, derived or aggregate reference (hostile text, a reference with a missing, mistyped or extra key at any level, a segment one over 2,048 characters), any query parameter but `mask`, or an edge type, rule, or entity type the mapping does not name | `INVALID_REQUEST`, no read |
| `GET /v1/source-links/{ref}`: a segment that is not the unpadded base64url text of an entity reference or a stored reference (hostile text, a missing, mistyped or extra key, a segment one over 2,048 characters), any query parameter but `mask` and `record`, a `record` on an entity reference, no `record` on an edge reference | `INVALID_REQUEST`, no read |
| Entity type the mapping does not name | `NOT_FOUND` on degree preview, derived neighbors and coverage; `INVALID_REQUEST` on expand, search, lookup and the entity read |
| Coverage: no entries, more than 500, a duplicate | `INVALID_REQUEST`; a ref of another source: `SOURCE_MISMATCH`; coverage never reads the source |
| Expand `limit` below 1, a fraction, beyond the safe integers | `INVALID_REQUEST` |
| Expand `filters` or `rank` that name an operator, a target, an order or a kind outside the closed sets, a property the mapping does not declare (for every asked neighbor type and every row read), more than 6 conditions, an `in` of more than 20 values, a range with no end, values of mixed kinds, a number beyond 2^53, or temporal text that is not ISO; a condition or rank on a personal-data property while masking is asked | `INVALID_REQUEST`, no read |
| Expand `filters`, `rank` or `window` changed, taken off, or put on, when continuing with a cursor | `CURSOR_INVALIDATED` |
| Expand `window` that is not days from 1 to 3650 or a range of calendar dates in order and at most 3650 days: a bad or reversed bound, text that is not an ISO date, both forms, an extra key, a wrong type | `INVALID_REQUEST`, no read |
| Expand `limit` above the source's `max_page` (default 50) | `QUERY_BUDGET_EXCEEDED`, with `maxPage` |
| `POST /v1/patterns/validate` and `POST /v1/patterns/preview`: an unknown source, or one the person may not read | `NOT_FOUND` |
| `POST /v1/patterns/validate` and `POST /v1/patterns/preview`: a body that is not the envelope (a missing, extra or mistyped member, a definition that is not an object), malformed JSON, a body over 1 MiB | `INVALID_REQUEST`, no read; a content type that is not JSON: `UNSUPPORTED_MEDIA_TYPE` |
| `POST /v1/patterns/validate` and `POST /v1/patterns/preview`: a definition with hostile text in a name, a key, a value, a window or an operator | answered `200` with problems that hold none of the text, no read (for the preview an acceptable definition answers `ok` and carries its values as data, quoted in the words and escaped by JSON) |
| `POST /v1/patterns/run`: a definition with hostile text in a name, a key, a window or an operator, or an anchor of another type than the definition starts from | `INVALID_REQUEST`, nothing read, none of the text in the answer |
| `POST /v1/patterns/run`: hostile text as the value of an accepted condition | served; the text reaches the executor as a parameter only, in no statement |
| `POST /v1/patterns/run`: an unknown source, or one the person may not read | `NOT_FOUND` |
| `POST /v1/patterns/run`: a body that is not the envelope, malformed JSON, a body over 1 MiB, or no key | `INVALID_REQUEST`, no read; a content type that is not JSON: `UNSUPPORTED_MEDIA_TYPE` |
| `GET /v1/templates`: an unknown source | `NOT_FOUND` |
| `GET /v1/templates`: no `sourceId`, an empty or repeated one, or another query member | `INVALID_REQUEST` |
| `POST /v1/templates/{id}/run`: an ID that is neither a preset of the source nor a built-in template, however long (the path segment is not capped at 401 units as the entity path is); an entity type of the anchor the mapping does not name; an unknown source; an anchor that does not resolve | `NOT_FOUND` |
| `POST /v1/templates/{id}/run`: an attribute type, a target type or a relationship type (each item of `via`) the mapping does not join, a preset that also receives the types it binds, a `via` that is not a non-empty list of texts, a direction that is not `out`, `in` or `both`, a hop count that is not a whole number from 1 to 4, a window that is not days from 1 to 3650 or a range of calendar dates in order and at most 3650 days, a window over a relationship type with no mapped time property, a `limit` that is not a whole number of at least 1, a `minShared` outside 1 to 50, a missing or malformed `Idempotency-Key` (not 16 to 64 letters, digits, `_` and `-`), a `ref` that holds a source ID, a stable ID of a keyed type that is not a token this server made for that source and type (forged, truncated, extended, another spelling, the twin source's token), a missing, mistyped or extra key at any level, text one over its cap, a body over 1 MiB, malformed JSON | `INVALID_REQUEST`, no read |
| `POST /v1/templates/{id}/run`: a content type that is not JSON | `UNSUPPORTED_MEDIA_TYPE` |
| `POST /v1/templates/{id}/run`: a `limit` above the source's `max_page`; a hop count above the lower of the template's 2 and the source's `max_hops` budget (3 and 4 on a source with the default budget, 2 on a source whose budget is 1) | `QUERY_BUDGET_EXCEEDED`, with `maxPage` or `maxHops` |
| `POST /v1/templates/{id}/run`: `continue` that is not a boolean, an extra top-level member, or `continue` inside `params` | `INVALID_REQUEST` |
| Search more with a `limit`, more than 25 exact references, or references of another source, of an unmapped type, or sent to a group other than `related` | `INVALID_REQUEST`, no read |
| A stable ID of a keyed entity type that is not a token this server made for that source and type (forged, truncated, extended, another spelling, another source or type), in expand, preview, derived neighbors, lookup, the entity path and the exact references of search more | `INVALID_REQUEST`, no read |
| A cursor that is edited, truncated, extended, of another version or spelling, signed right over a wrong payload, signed right for another source, principal, policy version, template, template version, sort or bound parameter, sent to another search group, expired, or minted before the policy version changed | `CURSOR_INVALIDATED`, with one body for all of them, and no read (search more: only the index-snapshot read it makes before it hands the cursor to the gate) |

Free text is accepted, and must reach the executor as a parameter only: search text, the stable ID of a type that is not keyed, and a lookup value (for a type that is not keyed, or a keyed type when unmasked). So are strings at their caps, with the body inside the 1 MiB bound.

A cursor is stateless and valid for 30 minutes. Replaying it unchanged in the same scope is served again; `limit` and the exact references of search more are not bound to it.

## A recorded run

Run on the commit that added the pattern count statement to the grammar check, with `NBX_FUZZ_RECORD` set to a file and the files of `services/api/src/fuzz` run together; the fixed seed is **5017**, 120 runs for a property unless the file says otherwise. The counts include the requests that build the closed set, whose pattern cases are checked by grammar and kept apart from it. The pattern run route adds requests and statements (the run's statement and the count it reads first); the validation and the preview read no source, so they add requests and no statements. The requests of `fuzz/pattern-run.test.ts` are not counted: it does not use the rig.

| Route | Answers |
|---|---|
| `POST /v1/graph/expand` | `INVALID_REQUEST` 3382, `CURSOR_INVALIDATED` 2316, `served` 1660, `QUERY_BUDGET_EXCEEDED` 100, `NOT_FOUND` 51 |
| `POST /v1/search/entities` | `served` 1053, `INVALID_REQUEST` 222 |
| `POST /v1/search/entities/more` | `CURSOR_INVALIDATED` 2826, `served` 553, `INVALID_REQUEST` 330 |
| `POST /v1/entities/lookup` | `INVALID_REQUEST` 487, `served` 373, `NOT_FOUND` 18 |
| `POST /v1/graph/preview-expansion` | `NOT_FOUND` 217, `INVALID_REQUEST` 210 |
| `POST /v1/graph/derived-neighbors` | `INVALID_REQUEST` 206, `served` 175, `NOT_FOUND` 60 |
| `POST /v1/graph/coverage` | `INVALID_REQUEST` 180, `NOT_FOUND` 65, `SOURCE_MISMATCH` 48, `served` 2 |
| `POST /v1/graph/read-refs` | `served` 54 |
| `POST /v1/templates/{id}/run` | `served` 2860, `INVALID_REQUEST` 1715, `NOT_FOUND` 321, `QUERY_BUDGET_EXCEEDED` 43 |
| `POST /v1/patterns/run` | `served` 426, `INVALID_REQUEST` 191, `NOT_FOUND` 60 |
| `POST /v1/patterns/validate` | `INVALID_REQUEST` 212, `served` 126, `NOT_FOUND` 60 |
| `POST /v1/patterns/preview` | `INVALID_REQUEST` 212, `served` 126, `NOT_FOUND` 60 |

21,009 requests, 28,929 statements seen by the executor, at most 94 distinct statements in a file, each in the closed set, or a pattern statement or count that the grammar accepts. The oversized-page case is `fuzz/routes.test.ts`, "answers QUERY_BUDGET_EXCEEDED, naming the maximum".

The pattern routes' own files are `fuzz/templates.test.ts` (the body, the ID, hostile text in every input, and the refusals that depend on the mapping, the budgets and the token) and the entries of the shape table in `fuzz/routes.test.ts`.

`fuzz/real-server.neo4j.test.ts` repeats a fixed sample (the hostile texts above through search, lookup, preview and expand) on a real Neo4j test database. The server reports no syntax error, `' RETURN 1 //` finds nothing, and the nodes, relationships, labels, properties, indexes and constraints are the same before and after. It runs with `pnpm test:neo4j` (a server you own; not in CI).

## Running and replaying

```bash
pnpm --filter @neburyx/api exec vitest run src/fuzz
NBX_FUZZ_RECORD=/path/to/record.jsonl pnpm --filter @neburyx/api exec vitest run src/fuzz   # also writes one line per file
```

A failing property prints its seed, the path and the shrunk counterexample. To replay it, pass the seed and path to `fc.assert` in that property (`{ seed, path }`), or run with the fixed seed in `testing/fuzz-corpus.ts`, which gives the same input every time.

## What it found

- A forged keyed token in the exact references of search more was read only after the index-snapshot read and the related page, and not at all when the page had no related records. It is now read with the other request checks, before any read.
- A stable ID of a type that is not keyed is accepted by the route schema up to 266,691 units (sized for a token) but refused by the gate above 100,000 units, with `INVALID_REQUEST` before any read. The code is right; the contract's cap is higher than the cap that applies to such an ID.
- A cursor signed with the right key is accepted if its position holds other fields than its template reads; the position reaches the executor as a parameter and nothing else. Making one needs the cursor key.
- A refused search-more cursor is refused after one index-snapshot read. Every other refusal above makes no call at all: the gate validates (the cursor included) before its index guard.
- The run route answers `NOT_FOUND`, not `INVALID_REQUEST`, for a template ID of any length, since a text that is not a preset or a template is an unknown ID; and an unmapped attribute type, target type or relationship type is `INVALID_REQUEST`, since the parameters of a built-in template are checked against the mapping as a request, not looked up as a resource. Only the entity type of the anchor and the ID are `NOT_FOUND`.
- A hop count of 5 or more is `INVALID_REQUEST` (the parameter schema stops at 4); 3 and 4 are `QUERY_BUDGET_EXCEEDED`, naming the cap, which is the lower of the template's 2 and the source's budget.
- A window on Expand over a relationship type with no mapped time property is served, not refused as it is on a pattern run: the page is read as without the window and the answer names the type (`applied: none`, `notAppliedTo`).
- The `ref` of the run route carries no source ID, so there is no `SOURCE_MISMATCH` to send; an unknown source is `NOT_FOUND`, and a source ID inside the `ref` is an extra key.
- A two-hop run whose target is its own anchor type needs the direction `both` when the relationship has two different ends; with the stored direction it reaches no such entity and is refused as a request.

## What it does not cover

Request rate and read slots, cancellation and timeouts (their own suites); the investigation routes, which do not read the source through the gate; text produced for or by a language model; the web client; the network layer in front of the API. The real-server file uses Neo4j 5.26 only.
