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

## Masking

While masking is asked, a condition or a rank on a `pii` property of an entity is refused: a condition would let the next answer say whether a guess was right, and a rank would show an order. The panel does not offer such properties while masking is on, and takes them off when masking is turned on.

## Cost

No index is needed or used for a condition or a rank: every read starts at the node by its stable ID and reads that node's relationships of the asked type, as an unfiltered page does, so a page still costs in proportion to the relationships of that type on the node. A condition reads its property on every relationship the page matches, so a filter that keeps nearly everything costs more than no filter (about a third more db hits and time in the benchmark), and a selective one costs less, because less is sorted and returned. A rank by a relationship property costs about the same db hits as the observed time; a rank by a neighbor property reads one more property for each candidate. The count reads what a page reads without sorting or returning rows, and ends with the read's timeout like any other. The section "Filtered, ranked and counted reads" of [benchmarks/supernode.md](benchmarks/supernode.md), made by `pnpm bench:refined`, records these on synthetic nodes of 10,000 and 100,000 relationships; `pnpm test:supernodes` checks the payload bounds, the order, the chain and the count label of filtered and ranked pages at 1,000, 10,000 and 100,000.
