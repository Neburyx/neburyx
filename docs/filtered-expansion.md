# Filtered expansion and ranking by property

An expansion (`POST /v1/graph/expand`) can keep only the relationships that match conditions, and can order its pages by a property instead of the observed time. Both are part of the read itself: they apply to the paged read from the node, to its keyset cursor and to its count. They are not the filters of the canvas, which hide what is already loaded.

## What the mapping declares

Nothing can be filtered or ranked by a property the mapping does not name.

| Key | On | Meaning |
|---|---|---|
| `filterable` | an entity or a relationship row | Properties a condition may name. |
| `sortable` | an entity or a relationship row | Properties a rank may name. |
| `observed_at` | a relationship row | Always filterable and sortable for that row, without being listed. A time window is a condition on it. |

Property names are checked when the mapping loads: a name with a backtick, a backslash, a control character or only whitespace is refused. A request that names an undeclared property is answered `INVALID_REQUEST` and nothing is sent to the database.

## The request

```json
{
  "sourceId": "…", "ref": { "entityType": "…", "stableId": "…" }, "neighborTypes": ["…"],
  "filters": [
    { "on": "neighbor", "property": "band", "op": "eq", "value": { "kind": "text", "value": "high" } },
    { "on": "relationship", "property": "score", "op": "between", "from": { "kind": "number", "value": 10 }, "to": { "kind": "number", "value": 50 } }
  ],
  "rank": { "on": "relationship", "property": "score", "order": "desc" }
}
```

- **Operators.** `eq`, `in` (1 to 20 values of one kind) and `between` (inclusive; `from` or `to` may be left out, not both). Up to 6 conditions, combined with AND. There is no not-equal, contains, prefix, null test or OR.
- **Values** are typed: `text`, `number` (a finite number; a whole number beyond 2^53 is refused), `boolean` (not in a range), `date`, `dateTime` (with a zone), `localDateTime`, `time` (with a zone) and `localTime`. Temporal text is checked to be ISO when the request is read. A stored value of another kind than the condition's never matches and is never an error.
- **`on`** says whether the property is the neighbor's or the relationship's. One request may ask several neighbor types: a neighbor property must be declared by every asked type, and a relationship property by every mapping row the request reads, or the whole request is refused before any type is read.
- **Rank.** Without `rank` the order is the observed time, newest first, as before. With it, relationships whose value is of a comparable kind come in the order asked, numbers before text, and relationships with no comparable value come last. A node with many relationships to one neighbor that the mapping gives no stable ID (an aggregate) is ordered by the largest value among its matching relationships when descending and the smallest when ascending; its observed times are reported as before.

## Statement text, values and the cursor

The statement is written by the gate from the mapping rows. Names come from the mapping; operators come from the closed set; every value is a parameter (`$filters[i]`) and none is in the statement text. Conditions are put in a fixed order and repeated values are removed before the request is hashed, so the same conditions in another order are the same request and keep their cursor. The cursor binds the conditions and the rank: changing either gives `CURSOR_INVALIDATED`, and a client starts the chain again.

## Counts

With conditions and no cursor, the page's `matchingTotal` is the number of relationships the conditions match (the members of an aggregate counted), read by a second read from the same node. It is `exact`. When that read fails, the page returns anyway with a warning, and its total is the page's own when the first page holds everything (`exact`, or `lowerBound` when a row was dropped or a member count is not exact) and `unknown` otherwise. `filters` is a list of 1 to 6 conditions; an empty list is `INVALID_REQUEST`. It is not capped. A later page does not count again; the client keeps the first page's number.

## A time window

An expansion can also keep only the relationships observed in a period: `"window": {"days": 7}` or `"window": {"from": "2026-01-01", "to": "2026-01-31"}` (exactly one of the two; up to 3,650 days; `to` is included, UTC). Without `window` nothing is windowed: the request, the statement and the answer are as they were.

- **What it follows.** Each relationship type's own observed time (`observed_at` of its mapping row): a relationship is kept when that time, read as an instant (a zoned date time as it is; a local date time and a date as UTC), is from the start of the window up to but not including its end. A relationship with no such time (none, or a time stored as text or a number) is not in the window. A relationship type with no `observed_at` is not filtered, and the page says so; if none of the types read has one, the page is read as without the window. This is not a condition on one property for every row, as a filter is, and a request may use both.
- **Days are whole UTC days.** `{"days": n}` runs from 00:00 UTC of the day `n` days before today up to but not including 00:00 UTC of tomorrow, so it holds at least `n` x 24 hours and is the same for every request of one UTC day. That is what lets the cursor, which binds the two instants, carry a page to the next; after midnight UTC the cursor is refused (`CURSOR_INVALIDATED`) and the person starts again. (The template run route reads `{"days": n}` as the last `n` x 24 hours up to the request.)
- **In the answer.** `window` holds the two instants the request resolved to; each page's `window` says whether it applied to every relationship type read (`full`), to some (`partial`) or to none, and names the types it did not apply to; a count read for the window says how many relationships of a dated type had no usable time and were left out (`undatedLeftOut`).
- **Counts.** A count that comes from a read the window applied to has the scope `expand:window`: it is a number for the window, not the degree of the entity. A first page that holds everything is its own count; a cut first page is counted by the exact count read (see *Counts*), with the same window, and that read also counts the relationships with no usable time. The degree preview is all time and is unchanged.

## Masking

While masking is asked, a condition or a rank on a `pii` property of an entity is refused: a condition would let the next answer say whether a guess was right, and a rank would show an order. The panel does not offer such properties while masking is on, and takes them off when masking is turned on.

## Cost

No index is needed or used for a condition or a rank: every read starts at the node by its stable ID and reads that node's relationships of the asked type, as an unfiltered page does, so a page still costs in proportion to the relationships of that type on the node. A condition reads its property on every relationship the page matches, so a filter that keeps nearly everything costs more than no filter (about a third more db hits and time in the benchmark), and a selective one costs less, because less is sorted and returned. A rank by a relationship property costs about the same db hits as the observed time; a rank by a neighbor property reads one more property for each candidate. The count reads what a page reads without sorting or returning rows, and ends with the read's timeout like any other. The section "Filtered, ranked and counted reads" of [benchmarks/supernode.md](benchmarks/supernode.md), made by `pnpm bench:refined`, records these on synthetic nodes of 10,000 and 100,000 relationships; `pnpm test:supernodes` checks the payload bounds, the order, the chain and the count label of filtered and ranked pages at 1,000, 10,000 and 100,000.
