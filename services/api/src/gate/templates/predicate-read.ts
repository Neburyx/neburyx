/**
 * A property read of a node or a relationship, written for the condition of a match that has an anchor. The read is wrapped in `coalesce` with the one argument, which has the same value (a missing property is null in both,
 * and so is every kind of value) and which no index can serve: a plain `x.property` in such a condition lets the planner start the match from an index on the property and join to the anchor, instead of expanding from it.
 * On the server series this was measured on (5.26), a plan driven from an index by a negated type test also returned rows missing the elements that have no value for the property. A one-argument `coalesce` is more
 * plausibly folded away by a planner than a wrapper that builds a value (such as `head([x])`), so the plan test of the anchor statements (`anchor-seek`) and the oracle suite (`index-oracle`) are what guard it: recheck both on every Neo4j upgrade. A lookup that a `USING INDEX SEEK` hint serves is not
 * written through this: the hint needs the direct read.
 */
export const predicateRead = (read: string): string => `coalesce(${read})`;
