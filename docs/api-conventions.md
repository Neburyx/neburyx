# API conventions

The rules every endpoint follows, decided once so that each new endpoint does not invent its own. A route that cannot follow
a rule says so in its own documentation.

## Pagination

Applies to every list backed by the application database (investigations, saved views, saved patterns, users, audit events,
exports). Graph reads have their own page shapes and budgets: search is described under [Search](#search), and expansion is described in [filtered-expansion.md](filtered-expansion.md) (its optional request fields `filters`, at least 1 and at most 6, and `rank`, both bound by the cursor, and the meaning of `matchingTotal` when filters are given).

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

- **Matched properties.** The answer holds `exactMatches`, one entry `{ ref, matchedProperties }` for each entity of `exact`, in the same
  order: the `search` properties of the entity's type that hold the typed text, in the order of the mapping, or none when the answer
  cannot name one. A name is never a value, a property returned masked is never named, and a personal-data property is named only
  when the search is not masked. A related hit carries its `reference` properties the same way in `matchedProperties`.
- **Pages.** A group shows at most 25 hits (or the source's `max_page` when that is lower). A group whose read found more holds
  a cursor (`exactNextCursor` for the exact group, `nextCursor` in `related` and `evidence`) and its count is a `lowerBound` of
  the hits held; a group with no more has no cursor and an `exact` count.
- **The next page.** `POST /v1/search/entities/more` with `{ sourceId, text, group, cursor, mask?, entityTypes? }`, where
  `group` is `exact`, `related` or `evidence`, reads the next page of that group only, with the same masking, the same searched
  properties and the same index plan as the first page (the source's indexes are read again). The answer holds the page's hits (for
  the exact group, `nodes` and `matches`, the matched properties of each node as in `exactMatches`),
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
- **Relationship context.** A record in the `related` group may hold `context: { relationshipType, direction, with }`: one stored
  relationship between it and one of the answer's exact matches, read from the record's side (`out` when the relationship
  leaves it, `in` when it enters it; `with` is the exact match's reference). It carries no property value, so a client names
  the exact match by the title the answer already shows. It is read once for the answer's hits and exact matches (each at
  most the page size), after the groups, only when both hold a hit and each entity type's `stable_id` has an online index; a
  type whose index is not online is named in `related.context.disabledTypes` and its pairs are left out. A record with no
  such relationship holds no `context`, which says nothing about relationships to exact matches beyond the first page. A
  read that fails with a code of its own is named as the failure group `context` (never a result group): every hit stays,
  none holds a context, and a retry repeats the whole search. `POST /v1/search/entities/more` for the `related` group may
  carry `exactRefs` (the references of up to the page size exact matches the client holds, none for another group); the
  page then holds its records' contexts against them, a failed context read is named in `contextFailure` (the page keeps its
  hits, count and cursor), and the server checks that the references belong to the source, not that they are exact matches
  of the search.
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
- **Read by references.** `POST /v1/graph/read-refs` reads again the items a stored draft names, since a draft holds references and no property values: `entities` (the entity read), `edges` (stored relationships, the relationship read), `aggregates` (each read as its two ends and one member, so an end the person may not see ends the read as missing, and then as its member count and observed range) and `derived` (the derived-support read of its rule, with the cap of the derived-neighbor read). Each list takes at most 100 references (a template list parameter); each read is made under one lease for all the references of a kind: one for entities, one for stored relationships, two for aggregates (the ends and one member, then the count) and one for derived relationships, so a call holds at most five leases one after the other, and the call counts as one request for the rate limit, whatever it holds. The answer holds the nodes and edges that resolved and `missing`, the references that did not, once each and without a reason: an item gone from the source, one whose type or rule is no longer mapped and one the person may not read give the same answer. A reference of another source is `SOURCE_MISMATCH`; a reference of a keyed entity type that is not a token of this deployment for the source and type is `INVALID_REQUEST`; a failed read (`QUERY_TIMEOUT`, `SOURCE_BUSY`, `SOURCE_UNAVAILABLE`, `RATE_LIMITED`) returns nothing. An aggregate comes with its member count and the count's quality label, and no sample; a derived relationship comes only when its rule still finds it. The audit event of the call is `graph.read_refs` and holds counts only; the reads inside it are audited by the gate under their own actions.
- **Derived neighbors.** `POST /v1/graph/derived-neighbors` runs each derived rule of the mapping whose `from` type is the entity's type (one bounded read for each rule, through the gate, under one read slot): the other ends the rule finds, at most 25 (`DERIVED_NEIGHBOR_CAP`; a source that lowered `max_page` lowers it to that, and a larger `max_page` does not raise it), each with the first chain of nodes and relationships that supports it. The count of a rule is `exact` when the read found no other end beyond the cap and a `lowerBound` of the ends that remained when it did; a derived edge whose end or supporting edge is not shown is neither counted nor returned, and a count that stopped at the cap is never `exact` after one was dropped. When the read stops at the cap, the ends it returns are those the source finds first (the statement has no order, which would read every candidate). A relationship type with no `stable_id` supports as an aggregate edge whose member count is a `lowerBound`. The rule comes from the mapping, never from the request. When no rule finds anything, one entity read through the gate follows, with its own audit event, to tell an exact zero for an entity that exists from a node that is not there.
- **Evidence on relationships with no `stable_id`** is searched like any other. A hit is the aggregate `{ aggregate: { type,
  from, to }, members, memberCount, rules }`: the relationship type and both ends, its members on this page, each
  `{ records, observedAt? }`, and `memberCount`, a `lowerBound` while another page may hold more. A member has no ID: the
  element ID of the source database never leaves the server (it can name another relationship once that one is deleted), and the
  next page continues from a position that only the signed cursor holds. The web adds the members of the next page to the same
  aggregate and tells a member by its records and time, or "Member n" (with "of m" only when the member count is exact) when it has neither.
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

## A refused update

`CONFLICT` (409) without a reason means the item was changed elsewhere. With `details.reason` it says why the update was refused; `message` is the reason's sentence and `retryable` is `false` for each. `details.status` is sent only with `investigation-read-only`.

| `details.reason` | `details.status` | `message` | `retryable` |
|---|---|---|---|
| none | none | This item was changed elsewhere. Reload to continue. | `false` |
| `status-change-not-allowed` | none | An archived investigation must be reopened before it can be closed. | `false` |
| `investigation-read-only` | `closed` or `archived` | This investigation is closed or archived. Reopen it to make changes. | `false` |

A reason of `SOURCE_UNAVAILABLE` is not valid on `CONFLICT`, and a reason of `CONFLICT` is not valid on `SOURCE_UNAVAILABLE`.

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
| Request body | 1 MiB; `PUT /v1/investigations/{id}/draft` 2 MiB and 4 KiB (two documents of at most 1 MiB each, and their envelope) |

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
- Reopening after a mapping change: `GET /v1/investigations/{id}` answers `unmapped` whenever the source is as it was, the saved nodes and relationships the current mapping does not cover (an entity type, a relationship type, a derived rule or an end's entity type that is not mapped), and `mappingChange` only when the draft was written under another mapping than the source has now. `mappingChange.droppedFilters` names each saved property filter the mapping no longer supports, with one reason, the first that holds in this order: `property-removed`, `now-personal`, `not-filterable`; a property filter names no entity type, so its reasons are judged over all the entity types of the source. The draft in the answer no longer holds those filters. A saved type filter is never dropped: it stays as saved, so a type that is mapped again has the state it had. Nothing is read from the source, and neither key is present for a source that was removed or re-pointed.
- Drafts and views: send `If-Match: "<version>"`. A mismatch is `CONFLICTED_VIEW_VERSION` (409). `PUT /v1/investigations/{id}/draft` takes `{layout, queryContext, notes}` (all required; `notes` may be `null`), at most 1 MiB for each document; the version in `If-Match` is the draft's, which `POST` and `GET` of an investigation carry in `draft.version`, not the `ETag` of the investigation. A write whose content equals the stored draft, made under the mapping the draft was written under, answers 200 with the same version and changes nothing; made under another mapping, it stores the draft under the current one (the version moves, the investigation's last edit does not). A draft of an investigation whose source is no longer the one it was opened on (removed from the configuration, or pointing at another database) is not written: the answer is `CONFLICT`.
- Drafts and views: send `If-Match: "<version>"`. A mismatch is `CONFLICTED_VIEW_VERSION` (409). `PUT /v1/investigations/{id}/draft` takes `{layout, queryContext, notes}` (all required; `notes` may be `null`), at most 1 MiB for each document; the version in `If-Match` is the draft's, which `POST` and `GET` of an investigation carry in `draft.version`, not the `ETag` of the investigation. A write whose content equals the stored draft answers 200 with the same version and changes nothing. A draft of an investigation whose source is no longer the one it was opened on (removed from the configuration, or pointing at another database) is not written: the answer is `CONFLICT`.
- Investigations: `GET /v1/investigations` is paged as above (the most recently edited first, then the larger id first) and answers `{items, nextCursor, counts, matching}`. `status` (`open`, `closed` or `archived`; `open` when left out), `source` (a source ID) and `q` (2 to 200 characters) narrow the list; `q` matches a fragment of the title or of the case reference without regard to case, and `%`, `_` and `\` in it stand for themselves. A cursor is bound to the caller and to `status`, `source` and `q`, so any other value is `CURSOR_INVALIDATED`. A row that is edited or added between two calls is never listed twice, and may be missing from the pages that follow. `matching` is the exact number of rows the filters select; `counts` describes the whole library and does not change with the filters. Each item carries `nodeCount` and `edgeCount`, the counts of the caller's draft when it was last saved, or `null` when they were made under another policy version.
- Named views across investigations: `GET /v1/views` is paged as above (newest first by the time the view was made, then its id) and answers `{items, nextCursor, count}`, each item a view with the investigation it belongs to (`id`, `title`, `sourceId`, `sourceAlias`, `status`). It lists the views of the caller's investigations of every status on every source the caller may read, and `count` is exact.
- Named views: `GET /v1/investigations/{id}/views` is paged as above (newest first by the time the view was made, then its id) and answers `{items, nextCursor, count, draft}`, with `count` exact and the same on every page; `PUT /v1/investigations/{id}/views/{viewId}` renames a view with the view's version in `If-Match` and the body `{name}`, and changes nothing else; `POST /v1/investigations/{id}/views/{viewId}/restore` (no body, the draft's version in `If-Match`) copies the view over the draft and answers `{draft, save}` with the draft's new version as the `ETag`.
- Investigations, grants, settings, limits and saved patterns: send `expectedVersion` (an integer of 1 or more) in the JSON
  body. A mismatch is `CONFLICT` (409). `PUT /v1/investigations/{id}` takes `{title, expectedVersion}` and
  `POST /v1/investigations/{id}/status` takes `{status, expectedVersion}`; each raises the investigation's `version` by one, answers its new
  `ETag` and leaves `last_edited_at`. A request for the status the investigation already has answers 200 with the same version and writes nothing, whatever `expectedVersion` it carries (a second tab's retry helps); a rename to the title it already has needs the current `expectedVersion`, and a stale one is `CONFLICT`. A closed or archived investigation refuses a draft write, a rename, a view save, a view rename and a view restore (listing the views still works) with `CONFLICT` and the reason
  `investigation-read-only` (see *A refused update*); that check comes after the owner's investigation is found and before the version guard.
- A delete has no body, so its guard is always `If-Match`, whatever the resource; a mismatch answers the resource's own code.
  Deleting or restoring a resource that has a version is a modification and is guarded.
- A missing guard on a guarded call is `INVALID_REQUEST`.
- Two shapes stay as they were specified: saving a view (`POST /v1/investigations/{id}/views`, body `{name, notes, title?, expectedInvestigationVersion?}`, answer 201 with the view, the draft's new `version`, `notes` and `basedOnViewId`, and `save`) is guarded by the draft's ETag in `If-Match` and also carries
  `expectedInvestigationVersion` in the body when the title changes (a stale one is `CONFLICT` and nothing is stored); copy-to-notes takes the draft's version as `version`
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

## Reading one stored edge

`GET /v1/edges/{ref}` reads one stored relationship (an edge the mapping gives a `stable_id`) with its source records, or one derived relationship with its rule and supports (below), through the gate, as the calling principal. `{ref}` is one percent-encoded path segment of at most 2,048 characters:
the unpadded base64url text of the JSON of the stored edge reference `{ sourceId, type, from, to, stableId }` (`from` and `to` are entity type names; a client writes the keys in that order with no whitespace, and any key order is accepted). The source is the one the
reference names. `mask=true` is the only query parameter; any other, or a mask that is not `true` or `false`, is `INVALID_REQUEST`.

- A segment that is not that text, a reference with an unknown or missing key, or an edge type, entity types or `stable_id` the mapping does not hold is `INVALID_REQUEST`, and nothing is read. An unknown source, a source the person may not read and an edge the source does not hold are the same `NOT_FOUND`.
- The read is one fixed template of at most two rows, matched by the relationship's `stable_id` (as the text and, when canonical, as the integer too); the second row only says that another relationship has the same type, ends and ID, and the answer then carries the quality flag `conflicting-duplicate`. It needs an online index on the `stable_id` property and is refused without one (`SOURCE_UNAVAILABLE` with an `index-` reason). It takes a read slot, counts against the request rate and trips the circuit breaker like every other read.
- The answer is `200` with the type, the two ends (reference, title and entity type; a title is masked when `mask` asks), the time the mapping's `observed_at` gives as the source gave it, the mapped properties the edge holds other than its stable ID and observed time (which have their own fields), its quality flags and `evidence`. `evidence` is `{ status: "available", records }`, each record `{ sourceRecordId, linkable }` or `{ property, unreadable: true }`, or `{ status: "not-available", code: "EVIDENCE_NOT_AVAILABLE" }` when the source kept no record for the edge. That code is a state of an ordinary answer and is never returned as an error response. `linkable` is `true` only when the mapping gives the evidence a link, the record is held by the evidence property the link's placeholder names, and an address can be built from its value; no URL and no element ID is ever sent. There is no confidence or score.

## Opening a source record

`GET /v1/source-links/{ref}` opens the source record of an entity, or one record of a stored edge, in the organization's own system. `{ref}` is one percent-encoded path segment of at most 2,048 characters: the unpadded base64url text of the JSON of `{ sourceId, entityType, stableId }` for an entity (the `stableId` is a keyed type's token, never its value), or of the stored edge reference for an edge, which also needs `record`, the source record ID to open. `mask=true` is the only other query parameter; any other, a `record` on an entity reference, no `record` on an edge reference, and a reference of the aggregate or derived form are `INVALID_REQUEST`.

- The route reads the entity or the edge through the gate as the calling principal, writes one audit event (action `source.link`, with the source, the trace ID, `target` `entity` or `evidence` and the type name; never the address, the ID or the record) and answers `302` with the address in `Location`, an empty body, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. It is the only place an address appears: no response body of any route holds one, and the profile says only whether a type has a link (`recordLink`). If the audit event cannot be written, no redirect is sent and the answer is `INTERNAL_ERROR`.
- Every refusal after the reference parses is the same `404 NOT_FOUND`, with the same body and headers apart from the trace ID: a source that is not configured or not readable, a type or relationship with no link template, a keyed type while masked or without `link_carries_value`, an entity or edge the source does not have, a record the edge does not carry in the property the link names, a value an address cannot be built from, and a request that another site started (`Sec-Fetch-Site` neither `same-origin` nor `none`) or that is a prefetch (`Sec-Purpose` or `Purpose`). The answer is one short page (`text/html`, the same words for every reason, the trace ID in small text, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and a `Content-Security-Policy` that allows no script), because the link opens in a new tab; a request with `Accept: application/json` and no `text/html` gets the JSON error instead, with the same `Cache-Control` and `Referrer-Policy`; the page alone carries the `Content-Security-Policy` and `nosniff`.
- A link is built from the mapping's template only: the request names the element, never an address. The value is percent-encoded as one path segment or query value. A value that is only dots, one with an unpaired surrogate, and one that makes the address longer than the current default of 4,096 characters give no link (the limit is not final). A source failure answers as it does on the entity and edge routes, and a request cancelled by the client writes no `source.link` event. The route counts as a request against the source's rate and takes a read slot, like the entity read; it has no HEAD.
- The page opens it with `rel="noopener noreferrer"`.

**A derived relationship.** `{ref}` may also be the text of a derived reference `{ sourceId, derived: { ruleId, from, to } }` (`from` and `to` are entity references `{ sourceId, entityType, stableId }`, written in that key order). It is `INVALID_REQUEST`, and nothing is read, when the rule is not one of the source's, when `from` and `to` are not entities of the rule's types, when the two are the same entity or when an end names another source. An unknown source, a source the person may not read, an end that does not exist, a pair with no chain and a relationship with an end, a middle entity or a supporting relationship the person cannot see are the same `NOT_FOUND`, with nothing of the hidden element in the body.

- The read is one fixed template (`derived-edge-support`, audit action `edge.derived_support`) written by the gate from the rule's chain with both ends fixed. It returns at most one chain for each distinct tuple of middle entities, so parallel relationships between the same entities are one chain, and it stops at the same cap as the derived neighbors: the lower of 25 and the source's `max_page`, read as `LIMIT cap + 1`.
- The answer is `200` with `semantics: "derived"`, the rule's ID and version from the mapping, the two ends and `supports`: `count` (the number of chains found, `exact`, or `lowerBound` when the read was cut at the cap or a chain was left out because the mapping does not describe it) and `groups`, each with the `middle` entities of the chain in order and its `supports`. A support is `{ ref, type, from, to, evidence }`: a stored one carries its source records as the stored read does, and one whose relationship type has no stable ID carries its aggregate reference and `evidence: { status: "no-stable-id" }` and nothing else (no member count, time, property or record). There is no confidence or score field.
- Every chain the answer shows has been checked: the derived relationship is shown only if both ends, every middle entity and every supporting relationship of the chains returned are visible. A chain past the cap is neither read nor named, so the bounded read cannot check the visibility of a support it did not read.

**An aggregate relationship.** `{ref}` may also be the text of an aggregate reference `{ sourceId, aggregate: { type, from, to } }` (`from` and `to` are entity references, written in that key order): all relationships of one type between two entities that no stable ID tells apart (for a type that has a `stable_id`, those whose ID cannot be used). It is `INVALID_REQUEST`, and nothing is read, when the type is not mapped between the two entity types, when an end names another source, or when the stable ID of a keyed end is not a token of this source. An unknown source, a source the person may not read, a missing end, a pair with no such relationship and an end the person cannot see are the same `NOT_FOUND`.

- The answer comes from two fixed reads, one after the other, each written by the gate from the mapping row with both ends fixed, each under its own read slot and audit event (`edge.aggregate_sample`, then `edge.aggregate_summary`). The sample read returns the two ends and at most the lower of 25 and the source's `max_page` members as their observed time and the mapped `filterable` properties only: no relationship is returned, so no element ID reaches the gate's result. The summary read returns the count and the earliest and latest observed time of every member, apart from the sample, in the way the expansion counts the same pair, so a canvas label and the panel agree when no view filter applies.
- The answer is `200` with `semantics: "aggregate"`, the two ends, `members` (a count with the scope `aggregate:members`: every relationship of the type between the two ends, whatever filters a view applied), `observedFirst` and `observedLast` when the mapping maps an observed time, `sample` and the quality flags (`no-stable-id` for a type that has a `stable_id`, `mixed-time-kinds` when the times are of different kinds). `sample` is `{ order, rows, more }`: `order` is `observed-newest` (rows newest first, a member with no usable time last; the mapping maps an observed time) or `source-order` (the first members the source returns, in no order the product chose, which says nothing about time); a row is `{ observedAt?, properties }`; `more` is the members not shown and is absent when the count is unknown. There is no paging, and no element ID, member reference, record ID or URL is ever sent.
- `members` is `exact`. When the summary read times out, or is refused as busy, the answer is still `200`: `members` is `unknown` with no number, the observed range and `more` are absent, a warning says why and the sample stays. A timeout of the sample read, a source that is down, an open breaker and a cancelled request fail the whole answer. Neither read is capped or bounded by the number of members: the read timeout bounds each one, and a slow read, the summary read included, counts toward the source's circuit breaker like a slow read of any other template.

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
