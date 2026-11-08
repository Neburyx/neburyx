# API conventions

The rules every endpoint follows, decided once so that each new endpoint does not invent its own. A route that cannot follow
a rule says so in its own documentation.

## Pagination

Applies to every list backed by the application database (investigations, saved views, saved patterns, users, audit events,
exports). Graph reads have their own page shapes and budgets: search is described under [Search](#search), and expansion is not covered here.

- Query parameters: `limit`, a positive integer, **default 25, maximum 100**; and `cursor`, the opaque string from the
  previous response.
- Paging is by keyset, not offset. Each endpoint declares a stable total order: its sort key or keys, then the row's id.
  Rows with a null sort value come last.
- The response is `{ items: [...], nextCursor: string | null }`. `nextCursor` is null on the last page. There is no total
  unless the endpoint returns a count with its quality label (`exact`, `estimated`, `lowerBound` or `unknown`).
- A cursor is opaque, signed, expiring, and bound to the user, the route, the sort, the filters, the source when the list is
  scoped to one, and the policy version. It is the text `v1.<payload>.<mac>` (base64url, HMAC-SHA256 under the key
  `NEBURYX_CURSOR_KEY`) and is valid for 30 minutes after it is given. A client must treat it as opaque: any change to it, an
  expired cursor, or one used for another user, route, source, policy version, sort or filter is `CURSOR_INVALIDATED`, with no
  detail about which, and the client starts the list again. A smaller `limit` may be sent with a cursor; the limit is not bound.
- `GET /v1/sources` is the one exception: it returns every configured source in one response, ordered by id, with `nextCursor` always `null`. The configuration file defines the list and it is small, so it is not paged, and it takes no query parameters (any is `INVALID_REQUEST`). Each item carries `lastTest`, a summary of the newest stored test made for the source's current connection and mapping, or `null`; it is read from the product's own record and never from the source.
- A limit above 100 is refused with `QUERY_BUDGET_EXCEEDED` (and the maximum in `details.maxPage`), never clamped. A limit that
  is not a positive integer is `INVALID_REQUEST`. A cursor that is invalid, altered, expired, or whose binding (user, route,
  source, policy version, sort or filters) does not match the request is `CURSOR_INVALIDATED`.

## Search

`POST /v1/search/entities` matches one whole text against one source and answers in result groups: `exact` (the entity
types' `search` properties), `related` (their `reference` properties) and `evidence` (the relationships' `evidence`
properties), with facet counts. With `typeahead: true` it adds a `startsWith` group and reads neither the related nor the
evidence group.

- **Pages.** A group shows at most 25 hits (or the source's `max_page` when that is lower). A group whose read found more holds
  a cursor (`exactNextCursor` for the exact group, `nextCursor` in `related` and `evidence`) and its count is a `lowerBound` of
  the hits held; a group with no more has no cursor and an `exact` count.
- **The next page.** `POST /v1/search/entities/more` with `{ sourceId, text, group, cursor, mask?, entityTypes? }`, where
  `group` is `exact`, `related` or `evidence`, reads the next page of that group only, with the same masking, the same searched
  properties and the same index plan as the first page (the source's indexes are read again). The answer holds the page's hits,
  `count`, `nextCursor`, `dropped` and `warnings`. `count` is the group's count: every hit of the pages read so far, this one
  included, a `lowerBound` while `nextCursor` is present and `exact` on the last page; a client shows it as it is. Pages follow the source's element ID order, so no hit is on two pages and none is skipped, and a
  node found through two properties is listed once.
- **The search cursor** follows the cursor rules above and is also bound to the group, the text, the selection and the
  masking; a cursor used for any other request is `CURSOR_INVALIDATED`, and the client searches again. Its position is the
  element ID of the last row shown, an opaque value that is never used as a reference.
- **A page that fails.** A read that fails with a code of its group (`QUERY_TIMEOUT` with `timeoutMs`, `SOURCE_BUSY`,
  `RATE_LIMITED` or `INTERNAL_ERROR`) is answered with `200`, the `failure`, no hit and an `unknown` count, and the cursor that
  was sent can be sent again. A value so common that sorting its matches passes the source's transaction timeout fails its
  page this way. Any other failure fails the request with its own status and code.
- **Type-ahead.** The `startsWith` group is read once, cut at the page and not sorted, so a short common prefix never makes the
  source read every match. It has no next page: its count is a `lowerBound` when the read was cut, and `/more` refuses the
  group with `INVALID_REQUEST`.
- **Facets** count the whole match set, whatever is selected, each up to the source's count cap (`heavy_op_threshold`, 500 by
  default): `exact` up to and including the cap and a `lowerBound` of the cap above it, so a facet says how far the pages go.
  An `exact` facet is never lower than the hits its group holds, a lower-bound facet below them is shown as at least the hits
  held, and no facet is the sum of others.
- **Indexes.** A property is searched only through an online index. A property that has none is left out and named in
  `disabledTypes` (`disabledRelationshipTypes` for evidence) with its reason: `index-unavailable` (no online index),
  `index-building` (the index is still being built) or `index-failed`. The type's other properties are still searched, and a
  type is marked as not searched (`typeSearched: false`) only when none of its properties is. A read that reaches the source
  for a property whose index is not online is refused as `SOURCE_UNAVAILABLE` before any data is read. A login that may not
  list indexes is the one case this cannot check: its reads run under the source's timeout and limits.
- **Entity types that share a label.** A node whose labels match several entity types is a hit of each type whose target
  matched it, never dropped for that. The entity read and the degree preview read a node as the entity type they ask for.
- **Nodes with no usable stable ID.** A hit whose stable ID property is missing, empty or not a usable ID (a fraction, an
  integer beyond the safe range, another type) is listed in its group as an unreferenced hit `{ entityType, title,
  properties, reason: 'no-stable-id' }`, masked as a node is, counted, and paged with the other hits; `dropped['no-stable-id']`
  is their number. It holds no reference, no cursor and no element ID, so it cannot be opened or added, and the web marks it
  "No usable stable ID: this item cannot be opened or added".
- **Estimated degrees.** `POST /v1/graph/preview-expansion` counts each mapped (relationship type, direction) pair of a node. When the mapping declares a degree property for an entity type (see [domain-packs/README.md](../domain-packs/README.md)), a pair whose live count stopped at the cap takes that number as `{ quality: 'estimated' }`, with `observedAt` when the mapping names a date property and it can be read. Only an `estimated` count has an `observedAt`. An exact count is never replaced. A property value that could not be used adds a `degree-property-ignored` warning for the relationship type. A total or neighbor-type count made from a single pair is that pair's count, `observedAt` included; a sum of two or more parts that includes an estimate is at best `estimated` and has no `observedAt`; a sum that includes a lower bound stays a lower bound and adds the cap, not the estimate, for an estimated part.
- **Evidence on relationships with no `stable_id`** is searched like any other. A hit is the aggregate `{ aggregate: { type,
  from, to }, members, memberCount, rules }`: the relationship type and both ends, its members on this page, each
  `{ elementId, records, observedAt? }`, and `memberCount`, a `lowerBound` while another page may hold more. A member's element
  ID is text only: nothing opens, copies or links by it, because it can name another relationship once that one is deleted.
  The web adds the members of the next page to the same aggregate.
- **Evidence values that cannot be read** (neither text nor a number) are kept as `{ property, unreadable: true }`, so the list
  and the count agree; the web says "Value cannot be shown" with the property name.

## An unavailable source

`SOURCE_UNAVAILABLE` (503) always carries `details.reason`, one of a fixed set. `message` is the reason's sentence and
`retryable` its flag, and the web offers Retry only when `retryable` is true.

| `details.reason` | `message` | `retryable` |
|---|---|---|
| `unreachable` | The source did not answer. Try again shortly. | `true` |
| `authentication` | The source refused the login. Ask an administrator. | `false` |
| `refused` | The source does not allow this read for the login. | `false` |
| `index-unavailable` | A needed index is not there, so the read was not run. | `false` |
| `index-building` | A needed index is still building, so the read is slow. Try again later. | `true` |
| `index-failed` | A needed index failed, so the read was not run. | `false` |
| `index-list-unreadable` | The source's indexes could not be listed, so the read was not run. | `false` |

`unreachable` covers a source that did not answer for any reason that a retry can cure, and an answer that names no reason.
A read that needs several indexes that are not online names the least recoverable: `index-failed`, then
`index-unavailable`, then `index-building`. An index list that cannot be read whole refuses the read
(`index-list-unreadable`) rather than run it without the check.

## Field limits

Every request is checked against a strict schema: unknown fields are rejected, and a violation is `INVALID_REQUEST`.

| Field | Limit |
|---|---|
| Investigation title | 200 characters |
| Case reference | 100 characters |
| View and pattern names | 120 characters |
| Notes | 10,000 characters |
| Search text | 2 to 200 characters |
| A template string parameter | 200 characters (a template's schema may be stricter) |
| A template list parameter | 100 items (a template's schema may be stricter) |
| Request body | 1 MiB |

Characters are counted as code points, as the database counts them, so the API and the database agree about a value's length.

## Idempotency keys

A retried create must not run twice.

- Send `Idempotency-Key`: 16 to 64 characters from letters, digits, `_` and `-` (a UUID fits). It is **required** on calls that
  create or run something that a retry could repeat: export creation, template and pattern runs, Ask runs, summary runs and
  alert creation. It is not asked of reads, of writes guarded by a version, or of deletes. A missing or malformed key is
  `INVALID_REQUEST`.
- For 24 hours the server keeps, for the user, the key, a fingerprint of the request (a SHA-256 of the method, the concrete
  path with its ids, the query string and the canonical JSON body) and the first response. A call that ended in a server error
  (status 500 or above) is not kept, so a retry runs it again.
- A repeat with the same key and the same fingerprint returns the first response with `Idempotent-Replay: true` and does not
  run the operation again. A repeat while the first call is still running is `CONFLICT`. The same key with a different
  fingerprint is `CONFLICT`.
- A replay is authorized like a new call: if the user's access has been revoked since the first call, the replay is
  `ACCESS_DENIED`. If the policy has changed since the first response, the stored response is not returned; the call is
  `CONFLICT` (send a new key) and the operation is not run again.
- Example: key `K` with an export of investigation A, then key `K` with an identical body for investigation B. The paths
  differ, so the second call is `CONFLICT`; A's export is never returned for B.

## Concurrency

Every edit of a resource that has a `version` is guarded, so a stale edit never overwrites a newer one.

- A response for a versioned resource carries `ETag: "<version>"` (a strong tag: the version as a quoted integer) and the
  `version` in its body. A successful write returns the new version.
- Drafts and views: send `If-Match: "<version>"`. A mismatch is `CONFLICTED_VIEW_VERSION` (409).
- Investigations, grants, settings, limits and saved patterns: send `expectedVersion` (an integer of 1 or more) in the JSON
  body. A mismatch is `CONFLICT` (409).
- A delete has no body, so its guard is always `If-Match`, whatever the resource; a mismatch answers the resource's own code.
  Deleting or restoring a resource that has a version is a modification and is guarded.
- A missing guard on a guarded call is `INVALID_REQUEST`.
- Two shapes stay as they were specified: saving a view is guarded by the draft's ETag in `If-Match` and also carries
  `expectedInvestigationVersion` in the body when the title changes; copy-to-notes takes the draft's version as `version`
  in its body.
- A content-hash `ETag` (the source profile) is a cache validator, not a version: send `If-None-Match` and get 304 when it
  still matches.

| Convention | Applies to |
|---|---|
| `Idempotency-Key` required | export creation, template and pattern runs, Ask runs, summary runs, alert creation |
| `If-Match` | draft saves, view saves, renames, deletes and restores, and every delete of a versioned resource |
| `expectedVersion` in the body | investigation edits, status changes and restores; grants; settings; limits; saved-pattern edits |
| Neither | reads, and calls that create or change nothing that has a version |

An endpoint with no version until its feature adds one follows these rules from then on.

## Permission per route

Every route says who may call it, in its route options:

```ts
app.get('/v1/me', { config: { permission: 'principal' } }, handler);
```

- `public`: no sign-in is needed (the health probes). `principal`: a signed-in principal; in Community that is the local one.
- There is no default. A route with no declaration, or with another value, fails a unit test that reads every route the
  application registers (`services/api/src/permissions.test.ts`). The web build's files are public by construction and are
  not part of the check.
- Nothing enforces the value at run time yet, because Community has one principal.

## Testing a source

`POST /v1/sources/{id}/test` runs reads on a configured source through the gate, as the calling principal (the capabilities of the server, the privileges of the login, the schema reads for the mapping: labels, relationship types, indexes and the stable-id check, and a degree probe for each entity type that has a mapped relationship),
and returns the report. The report says whether the login can write: `readOnlyCheck` is `privileges-inspected` and `loginCanWrite` is `true` or `false`, or `readOnlyCheck` is
`not-verified` and `loginCanWrite` is `null`, as on a Community server, which cannot list privileges. A login that can write gives outcome `warn` and the reason
"The login can write to the source; give Neburyx a login that can only read." A run that cannot show whether the login writes is not a failure. A listing the check cannot read (a row that is not five strings) is a `warn` with the reason "The server listed privileges that could not be read, so read-only is not verified." The report also carries `mappingChecks`: whether the labels, relationship types, indexes and stable ids that the mapping names exist on the source. Its `status` is `pass`, `warn`
(a missing sort index, an index still being built, a stable id that nothing enforces as unique), `not-verified` (the login may not list indexes, an answer that could not be read,
a duplicate check that ran out of time), `fail` (a missing label, relationship type or index, a stable id that is not indexed or not unique) or `not-run` (the source did not answer, or its
server version is not on the support matrix). A failure makes the outcome `fail` and the state `unavailable` with a reason that names the first problem and says what to do. A finding refuses no read by
itself: a read of what no finding names runs, a missing label or relationship type or a stable id that is not unique gives what the source holds, and an index
finding refuses only the reads that need that index (see [Search](#search)). A source that no check has reached yet is read the same way, its reads checked
against its indexes. Each finding names the entity type or relationship type, the property and the check, and never an address, a credential, a node value or a name the mapping does not use.
The report also carries `degreeChecks`: for each entity type that has a mapped relationship, whether the server answers a count of its neighbors from the degree of the node (`cheap`), by expanding its relationships (`not-cheap`) or in a way the check could not tell (`could-not-tell`), with the basis of the result, the relationship types probed and the server version it was found on (`foundOn`). The check runs the count under `PROFILE` on one node of the entity type and reads the server's plan; it never reads a count into the report, and the plan words are the server's, so a plan the check does not recognise is `could-not-tell`, not `not-cheap`. Its `status` is `pass` (every type is cheap), `warn` (any other, with one warning for each such type, such as "Degree counts are estimated for X: no cheap per-type degree index") or `not-run` (the source did not answer, the version is not on the support matrix, the mapping check failed, or no entity type has a relationship). Degree results never change the outcome or the state. A check is at most seven gate deadlines (capabilities, privileges, the mapping reads and the degree probes).
A source that stops answering during the schema reads or the degree probes gives an error (`504` or `503`) and no report, because that says nothing about the mapping. The route never runs the write probe,
which only the `test-source` command runs on request (`readOnlyCheck` is then `write-probe`). It declares `principal`; in Community every principal that the policy allows to read the source may
call it. It takes no body and no query parameters (either is `INVALID_REQUEST`) and no version header. An unknown id is
`NOT_FOUND`. A source that is reachable but on a server version outside the support matrix gives a report with outcome `warn`.
The report carries a fixed, plain reason and never an address, a credential or query text.
