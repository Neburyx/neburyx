/** The longest one read of a source may take on the server, its wait for a read slot included: the deadline the gate gives every read. */
export const SOURCE_REQUEST_DEADLINE_MS = 10_000;

/**
 * How many source reads one request makes one after another, for each request that makes more than one: each has its own deadline, so the server can still be answering after this many deadlines.
 * A server test per request counts them.
 */
export const SOURCE_READS_IN_A_ROW = {
  /** The indexes, the first group, the other groups together, the relationship context of the related records. */
  search: 4,
  /** The indexes, the page, its relationship context. */
  searchMore: 3,
  /** The indexes, the exact matches, the matches that start with the text. */
  typeahead: 3,
  /** The rules, then the entity itself when no rule gave a row. */
  derivedRows: 2,
  /** The sample of the members, then their count. */
  aggregateEvidence: 2,
  /** The same two reads, for the aggregate relationships a stored answer cites. */
  aggregateRefs: 2,
} as const;
