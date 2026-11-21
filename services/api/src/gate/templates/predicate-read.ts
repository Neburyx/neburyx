/**
 * A property read of a node or a relationship, written for the condition of a match that has an anchor. The read is wrapped in a one-element list and `head`, which has the same value (a missing property is null in both,
 * and so is every kind of value) and which no index can serve: a plain `x.property` in such a condition lets the planner start the match from an index on the property and join to the anchor, instead of expanding from it.
 * On the server series this was measured on (5.26), a plan driven from an index by a negated type test also returned rows missing the elements that have no value for the property. The planner may one day see
 * through the wrapper: the plan test of the anchor statements and the oracle suite of the Neo4j tests fail then, and are the guard to run on every server upgrade. A lookup that a `USING INDEX SEEK` hint serves is not
 * written through this: the hint needs the direct read.
 */
export const predicateRead = (read: string): string => `head([${read}])`;
