# Input fuzz suite

The suite sends hostile input to every request input that reaches the read gate and checks two things: **no input reaches Neo4j as statement text**, and **bad input is refused at validate with the right error code**. It runs with the unit tests (`pnpm test`, the `unit` CI job) and needs no server.

Files are in `services/api/src/fuzz/`, with the rig in `services/api/src/testing/fuzz-rig.ts`, `fuzz-closed-set.ts` and `fuzz-corpus.ts`.

## What it checks

**The closed set.** The rig runs the real app and gate over a recording executor. Before the fuzz starts it sends every legal choice of each read route once (entity types, relationship types, directions, match modes, groups, masked and unmasked, first pages and next pages) and keeps the statement text the executor saw. That set is the *closed set*: the fixed templates with allowlisted names. For every fuzz request the suite then checks that

- the closed set holds none of the values used to build it (`W-1`, the search text, the phone values, the cursors and tokens it minted), so a template that wrote a request value into its text would be found;
- every statement the executor saw is in the closed set;
- every name a statement quotes in backticks is a label, relationship type or property of the mapping;
- no hostile string of the request (four characters or longer) appears in any statement. It may appear in the parameters only;
- a request refused before the gate leaves the executor with no call at all (search more: at most the index-snapshot read).

A test feeds the check a statement built from text and shows it fails.

**The refusals.** Each of these is a property over generated input, with the codes the API returns:

| Input | Answer |
|---|---|
| Wrong type, missing key, extra key, text one over its cap (search text 201 characters, lookup value 100,001 units, reference 266,692 units, path segment 401 units), control character or lone surrogate in a path segment, malformed JSON, body over 1 MiB | `INVALID_REQUEST`, no read |
| Content type that is not JSON (plain text is read as a string and refused as `INVALID_REQUEST`) | `UNSUPPORTED_MEDIA_TYPE` |
| Unknown source | `NOT_FOUND` |
| Entity type the mapping does not name | `NOT_FOUND` on degree preview and coverage; `INVALID_REQUEST` on expand, search, lookup and the entity read |
| Coverage: no entries, more than 500, a duplicate | `INVALID_REQUEST`; a ref of another source: `SOURCE_MISMATCH`; coverage never reads the source |
| Expand `limit` below 1, a fraction, beyond the safe integers | `INVALID_REQUEST` |
| Expand `limit` above the source's `max_page` (default 50) | `QUERY_BUDGET_EXCEEDED`, with `maxPage` |
| Search more with a `limit`, more than 25 exact references, or references of another source, of an unmapped type, or sent to a group other than `related` | `INVALID_REQUEST`, no read |
| A stable ID of a keyed entity type that is not a token this server made for that source and type (forged, truncated, extended, another spelling, another source or type), in expand, preview, lookup, the entity path and the exact references of search more | `INVALID_REQUEST`, no read |
| A cursor that is edited, truncated, extended, of another version or spelling, signed right over a wrong payload, signed right for another source, principal, policy version, template, template version, sort or bound parameter, sent to another search group, expired, or minted before the policy version changed | `CURSOR_INVALIDATED`, with one body for all of them, and no read (search more: only the index-snapshot read it makes before it hands the cursor to the gate) |

Free text is accepted, and must reach the executor as a parameter only: search text, the stable ID of a type that is not keyed, and a lookup value (for a type that is not keyed, or a keyed type when unmasked). So are strings at their caps, with the body inside the 1 MiB bound.

A cursor is stateless and valid for 30 minutes. Replaying it unchanged in the same scope is served again; `limit` and the exact references of search more are not bound to it.

## A recorded run

Run on the commit that added this page, with `NBX_FUZZ_RECORD` set to a file; the fixed seed is **5017**, 120 runs for a property unless the file says otherwise. The counts include the requests that build the closed set.

| Route | Answers |
|---|---|
| `POST /v1/graph/expand` | `INVALID_REQUEST` 1152, `CURSOR_INVALIDATED` 751, `served` 536, `QUERY_BUDGET_EXCEEDED` 100, `NOT_FOUND` 60 |
| `POST /v1/search/entities` | `served` 643, `INVALID_REQUEST` 222 |
| `POST /v1/search/entities/more` | `CURSOR_INVALIDATED` 1938, `INVALID_REQUEST` 330, `served` 312 |
| `POST /v1/entities/lookup` | `INVALID_REQUEST` 487, `served` 361, `NOT_FOUND` 10 |
| `POST /v1/graph/preview-expansion` | `INVALID_REQUEST` 210, `NOT_FOUND` 205 |
| `POST /v1/graph/coverage` | `INVALID_REQUEST` 182, `NOT_FOUND` 64, `SOURCE_MISMATCH` 47, `served` 2 |

7,612 requests, 7,249 statements seen by the executor, at most 24 distinct statements in a file, all in the closed set. The oversized-page case is `fuzz/routes.test.ts`, "answers QUERY_BUDGET_EXCEEDED, naming the maximum".

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

## What it does not cover

Request rate and read slots, cancellation and timeouts (their own suites); the investigation routes, which do not read the source through the gate; the pattern templates; text produced for or by a language model; the web client; the network layer in front of the API. The real-server file uses Neo4j 5.26 only.
