# API conventions

The rules every endpoint follows, decided once so that each new endpoint does not invent its own. A route that cannot follow
a rule says so in its own documentation.

## Pagination

Applies to every list backed by the application database (investigations, saved views, saved patterns, users, audit events,
exports). Graph reads (search and expansion) have their own page shapes and budgets and are not covered here.

- Query parameters: `limit`, a positive integer, **default 25, maximum 100**; and `cursor`, the opaque string from the
  previous response.
- Paging is by keyset, not offset. Each endpoint declares a stable total order: its sort key or keys, then the row's id.
  Rows with a null sort value come last.
- The response is `{ items: [...], nextCursor: string | null }`. `nextCursor` is null on the last page. There is no total
  unless the endpoint returns a count with its quality label (`exact`, `estimated`, `lowerBound` or `unknown`).
- A cursor is opaque, signed, expiring, and bound to the user, the route, the sort, the filters, the source when the list is
  scoped to one, and the policy version.
- A limit above 100 is refused with `QUERY_BUDGET_EXCEEDED` (and the maximum in `details.maxPage`), never clamped. A limit that
  is not a positive integer is `INVALID_REQUEST`. A cursor that is invalid, altered, expired, or whose binding (user, route,
  source, policy version, sort or filters) does not match the request is `CURSOR_INVALIDATED`.

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
- Nothing enforces the value at run time yet, because Community has one principal. Enterprise adds roles and capabilities as
  further values when its policy exists.
