# Input fuzz suite

The suite sends hostile input to every request input that reaches the read gate and checks two things: **no input reaches Neo4j as statement text**, and **bad input is refused at validate with the right error code**. It runs with the unit tests (`pnpm test`, the `unit` CI job) and needs no server.

Files are in `services/api/src/fuzz/`, with the rig in `services/api/src/testing/fuzz-rig.ts`, `fuzz-closed-set.ts` and `fuzz-corpus.ts`.

## What it checks

**The closed set.** The rig runs the real app and gate over a recording executor. Before the fuzz starts it sends every legal choice of each read route once (entity types, relationship types, directions, match modes, groups, masked and unmasked, first pages and next pages, and for the pattern routes: every preset and each template by its own ID, one and two hops, each direction, no window, a window of days and a window of dates, with and without a minimum of shared nodes, masked and not, always a first run; each run reads its estimate first, so the count statement of each pattern template is in the set, and a run with the continue flag, which reads none, is sent for each template) and keeps the statement text the executor saw. That set is the *closed set*: the fixed templates with allowlisted names. For every fuzz request the suite then checks that

- the closed set holds none of the values used to build it (`W-1`, the search text, the phone values, the cursors and tokens it minted), so a template that wrote a request value into its text would be found;
- every statement the executor saw is in the closed set;
- every name a statement quotes in backticks is a label, relationship type or property of the mapping;
- no hostile string of the request (four characters or longer) appears in any statement. It may appear in the parameters only;
- a request refused before the gate leaves the executor with no call at all (search more: at most the index-snapshot read).

A test feeds the check a statement built from text and shows it fails.

**Every route is in the set.** (`POST /v1/investigations`, which reads the entity once through the gate when it opens one, is built into the set; no hostile request to it is part of the recorded run below.) `fuzz/completeness.test.ts` compares the routes the closed set was built from (the builder records each route it requests) with the routes the API registers under `/v1`, less a named list with a reason for each: the routes that read no source, and the source test, which runs the tester and not a gate template. A route the builder does not request fails the test, so removing a route from the set, or adding a source-reading route and leaving it out, cannot pass unseen. Negative tests feed the check a set with one route missing. The cancellation route list (`graph/cancel-routes.test.ts`) and the concurrency suite's (`tools/concurrency-suite/src/routes.test.ts`) are compared with the registered routes the same way.

**The estimate cases are in the set.** Beside the routes, the closed set records the pattern-run cases it was built from for each pattern template (`shared-attribute:estimate`, `shared-attribute:continue`, `linked-entities:estimate`, `linked-entities:continue`) and the completeness test requires each of them and the count statement of each template (a negative feeds it a set without one).

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
| Expand `filters` or `rank` changed, or taken off, when continuing with a cursor | `CURSOR_INVALIDATED` |
| Expand `limit` above the source's `max_page` (default 50) | `QUERY_BUDGET_EXCEEDED`, with `maxPage` |
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

Run on the commit that added the pattern routes to the suite, with `NBX_FUZZ_RECORD` set to a file; the fixed seed is **5017**, 120 runs for a property unless the file says otherwise. The counts include the requests that build the closed set, which now has the pattern runs, so every file's counts are higher than they were before them.

| Route | Answers |
|---|---|
| `POST /v1/graph/expand` | `INVALID_REQUEST` 2033, `CURSOR_INVALIDATED` 949, `served` 696, `QUERY_BUDGET_EXCEEDED` 100, `NOT_FOUND` 61 |
| `POST /v1/search/entities` | `served` 976, `INVALID_REQUEST` 222 |
| `POST /v1/search/entities/more` | `CURSOR_INVALIDATED` 2604, `served` 493, `INVALID_REQUEST` 330 |
| `POST /v1/entities/lookup` | `INVALID_REQUEST` 487, `served` 370, `NOT_FOUND` 16 |
| `POST /v1/graph/preview-expansion` | `NOT_FOUND` 214, `INVALID_REQUEST` 210 |
| `POST /v1/graph/derived-neighbors` | `INVALID_REQUEST` 206, `served` 169, `NOT_FOUND` 60 |
| `POST /v1/graph/coverage` | `INVALID_REQUEST` 180, `NOT_FOUND` 65, `SOURCE_MISMATCH` 48, `served` 2 |
| `POST /v1/templates/{id}/run` | `served` 2408, `INVALID_REQUEST` 1535, `NOT_FOUND` 321, `QUERY_BUDGET_EXCEEDED` 43 |

14,854 requests, 15,799 statements seen by the executor, at most 54 distinct statements in a file, all in the closed set. The oversized-page case is `fuzz/routes.test.ts`, "answers QUERY_BUDGET_EXCEEDED, naming the maximum".

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
- The `ref` of the run route carries no source ID, so there is no `SOURCE_MISMATCH` to send; an unknown source is `NOT_FOUND`, and a source ID inside the `ref` is an extra key.
- A two-hop run whose target is its own anchor type needs the direction `both` when the relationship has two different ends; with the stored direction it reaches no such entity and is refused as a request.

## What it does not cover

Request rate and read slots, cancellation and timeouts (their own suites); the investigation routes, which do not read the source through the gate; the list route of the templates and the heavy-operation probe of a pattern run, which the API does not have yet; text produced for or by a language model; the web client; the network layer in front of the API. The real-server file uses Neo4j 5.26 only.
