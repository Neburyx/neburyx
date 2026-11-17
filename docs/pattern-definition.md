# The pattern definition

A pattern built in the app is a declarative definition: a start type and one to four steps. Nothing in it is query text. The gate writes the statement from the source's mapping, with every name from the mapping and every value as a parameter; the definition only chooses among fixed forms. This page lists those forms, the three added for typologies that need more than a chain (a fan, a time order and a cycle), the limits each has, and what each refusal says.

## The shape

```json
{
  "anchorType": "account",
  "steps": [
    { "relationshipTypes": ["TRANSFERRED_TO"], "direction": "out", "arrivesAt": "account" }
  ]
}
```

A step has `relationshipTypes` (one to six, no repeat), `direction` (`out`, `in` or `both`), `arrivesAt` (a node type), and optionally `conditions` (equality, a list or a range on a property the mapping declares filterable) and `window` (the last N days, or two dates, on the relationship's time property). The first step starts at the entity a run is given; each later step starts at the node the previous one reached. A node never appears twice on a path.

Every object is strict: a key that is not listed is refused (`unknown-key`).

## Three kinds added for typologies

All three are optional fields of a step. A definition saved before they existed has none of them, loads as it was and runs with the same statement, byte for byte (the golden file of the compiler is the proof; it is never regenerated to make a test pass).

| Field | Meaning | Refused when |
|---|---|---|
| `after: "previous"` (a time order) | The step's relationship has a time at or after the previous step's relationship (equal times pass). Both are read on the `observed_at` the mapping names for the rows each step crosses. | It is on the first step (`bad-value`); a row either step crosses has no `observed_at` in the mapping (`time-not-mapped`). A relationship whose time is missing or is not a date and time is left out of the run, and the run says so (`undatedExcluded`). |
| `fan: { "atLeast": n }` (fan-out for `out`, fan-in for `in`) | The step's origin node (the start for the first step) has at least `n` distinct neighbours of the step's arrival type over the step's relationship types and direction, that meet the step's conditions and window. A neighbour reached by several relationships counts once; a node already on the path counts; the time order is not applied to the count. | `n` is not a whole number of 2 or more (`bad-value`); `n` is above the source's count cap, the setting `heavy_op_threshold` (`over-ceiling`). |
| `closesAtAnchor: true` (a cycle) | The last step arrives at the start node itself: the pattern is a cycle of as many hops as it has steps. The nodes between differ from each other and from the start, and no relationship is used twice. | It is not on the last step, the pattern has one step, or the last step arrives at another type than the start's (`bad-value`); the cycle has more steps than the source's `max_hops` (`cycle-too-long`; a pattern with more than four steps is refused by the schema as `too-many`, first). |

### What a run returns for each

- **Time order.** The matches of the usual chain, kept to the paths whose relationships are in time order.
- **Fan.** The matches of the chain, from the origins that have the fan. An origin that has more relationships over the step's types than the count cap (the anchor included) is a supernode: it is not evaluated, it is named in the `supernodesSkipped` notice and the count is a lower bound. Within the cap the fan is counted completely, so a threshold is only ever decided on a full count. The neighbours of a skipped node stay reachable through the expansion's own paging.
- **Cycle.** The match is the start entity itself: the run answers whether it lies on such a cycle. All cycles to it make one match, with the first of the cycles the run read (in the order of the stable IDs along the path, among the bounded candidates it kept) as its shown path. The count is 1 or 0.

### Counts

The count of a run is labelled by what the read did, as for every pattern: `exact` only when nothing was cut, nothing was skipped and no entity was left out for a stop-list; otherwise `lowerBound`. Every read of every kind is bounded by the count cap, and a run that would read more than the source's `heavy_op_threshold` stops first with the estimate, as before.

## Versions and old definitions

- The templates `pattern` and `pattern-count` moved to versions 3 and 2. A page cursor written before the upgrade is refused as invalid (it binds the template version and the definition's parameters); a client asks the run again. Changing any of the three fields also invalidates a cursor.
- No migration. A saved definition is stored as JSON and read again with the current schema on every load.
- A saved definition whose mapping no longer gives the time property a time order needs is listed as unavailable (`bad-definition`, at the step). One whose source later lowers `heavy_op_threshold` or `max_hops` stays available and is refused when it is run (`over-ceiling` is `INVALID_REQUEST`; `cycle-too-long` is `QUERY_BUDGET_EXCEEDED`, like `too-many-hops`).
- After a downgrade to a version without these fields, a definition that uses one of them cannot be read (the schema is strict) and is shown as unavailable. Nothing is lost: upgrading again shows it as it was.

## What the checks prove

- The golden file of the compiler pins every statement fragment, each alone; the three kinds add entries and change none (`services/api/src/gate/templates/pattern-fragments.golden.json`).
- The fuzz suite (see [fuzz-suite.md](fuzz-suite.md)) enumerates and draws shapes with the new fields, and checks every statement against the grammar learned from the compiler.
- The demo graphs and a graph made for the edge cases run each kind on a real Neo4j and compare with sets computed from the export: boundary counts, parallel relationships, both directions, a supernode origin, self-loops, one relationship read back, two cycles through one entity.
- The cancellation suite aborts the estimate and the run of each kind, directly, from a saved pattern and from the panel, and shows on a real Neo4j that an aborted read's transaction ends (see [cancellation.md](cancellation.md)).

A mapping can ship definitions as built-in patterns (see [the AML typologies](aml-typologies.md) and [the mapping guide](mapping-guide.md#built-in-definitions)).
