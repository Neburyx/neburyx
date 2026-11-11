/**
 * What one export holds at most; above any of these it is refused, never cut. The figures were measured on 2026-11-10 on an Apple M5 Max (36 GB, macOS 27.2, Node 24), one client, reads one after the other,
 * 3 runs each, on the synthetic AML demo graph in a Neo4j Enterprise 5.26 server on the local network, through a read-only login; the time is the whole `POST …/exports` call for a JSON export, against the 10 s request deadline
 * (the target is at most half of it):
 *
 * - entities (one batched read of up to 100 for each run of one type): 300 take 0.35 to 0.48 s, 1,000 take 0.9 to 1.0 s;
 * - stored relationships (one batched read of up to 100 for each run of one type and ends): 300 take 0.35 to 0.44 s, 1,000 take 0.84 to 0.98 s;
 * - aggregated relationships (each read on its own, with its ends and one member): 96 take 4.0 to 4.2 s, 193 take 7.6 to 7.7 s, 285 take 16.0 to 16.7 s, 379 take 20.2 to 20.5 s;
 * - derived relationships (each its own statement, the rule's support read): 50 take 1.2 to 1.4 s, 100 take 2.1 to 2.2 s, 150 take 3.0 to 3.3 s, about 21 ms each;
 * - mixed: 300 entities and 300 stored relationships take 0.56 to 0.69 s; adding 100 aggregates makes it 4.3 to 4.6 s and adding 100 derived instead makes it 2.6 to 2.7 s; 300 entities, 300 stored relationships and 285 aggregates take 11.6 to 16.9 s.
 *
 * Aggregates cost about 40 ms each and more beyond 200, so their limit is lower. A derived relationship is also read as one statement of its own, so it counts with the aggregates, though it costs about half as much.
 */
export const MAX_EXPORT_ENTITIES = 300;
export const MAX_EXPORT_RELATIONSHIPS = 300;
export const MAX_EXPORT_AGGREGATES = 100;

/** Pending rows and temporary files older than this are the leftovers of a call that never finished. */
export const STALE_EXPORT_MS = 15 * 60_000;
