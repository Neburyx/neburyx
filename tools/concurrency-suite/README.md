# tools/concurrency-suite

Tests that the read slots, the request rate and the circuit breaker hold under many simultaneous requests. The limits and their numbers are in [docs/concurrency.md](../../docs/concurrency.md).

The rig starts the real API on a loopback port (the real gate, read slots, request limiter and circuit breaker, composed as the Community install composes them) over a scripted source that holds, answers or times out each data read on the test's command. The gate, the slots' timers, the breaker and the limiter share one clock that the test moves, so a wait, a lease's expiry, the rate window and a cool-down pass only when the test says. A case starts its own rig; nothing carries over between cases.

| Command | Runs |
|---|---|
| `pnpm test` (from the root, or in this folder) | The scripted cases. No server is needed. They run in CI. |
| `pnpm test:neo4j` (from the root) | Also ten simultaneous reads of one person against the real adapter on a database of this run's own. Needs a Neo4j Enterprise server you own, as the other Neo4j tests do (see [`packages/test-neo4j`](../../packages/test-neo4j/README.md)); not in CI. |

The stored edge read, the derived edge read, the derived neighbors read and the source link share the slots, the request rate and the breaker of the entity read (`edge.test.ts`, `derived.test.ts`, `link.test.ts`). `routes.test.ts` compares the rig's routes with the routes the API registers, less a named list with a reason for each, so a new route cannot be left out.

The index-list read that comes before each data read is answered at once and not counted: the cases count, hold and assert on the data read.

The Neo4j case borrows the real-adapter rig of [`tools/cancellation-suite`](../cancellation-suite/README.md) by relative import.

Synthetic data only. Nothing here prints an address or a login.
