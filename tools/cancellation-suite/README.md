# tools/cancellation-suite

Tests of what a cancel, a timeout and a source that stops answering leave of the client.

Each case runs the real API (the gate, the read slots, an app store) on a loopback port and the real web client, expand and degree-preview stores, request tracker and status banner in front of it, in one process with the real `fetch` and `AbortController`. Behind the gate is either a scripted source that holds, answers, fails or times out on the test's command, or the real Neo4j adapter on a database of this run's own. A case takes a snapshot of the client before and after (the investigation, the view, the loaded graph, the paging progress of each node, and what the API saved) and compares them.

| Command | Runs |
|---|---|
| `pnpm test` (from the root, or in this folder) | The scripted cases. No server is needed. They run in CI. |
| `pnpm test:neo4j` (from the root) | Also the cases on a real Neo4j: the expansion of a node of 100,000 relationships cancelled while the server lists its transaction, a read forced past a budget of 1,000 ms, and the source port closed in the middle of a read. They need a Neo4j Enterprise server you own, as the other Neo4j tests do (see [`packages/test-neo4j`](../../packages/test-neo4j/README.md)); each file makes its own database and drops it. Not in CI. |

The forced slow read swaps a slow statement into the adapter's call; the session, the transaction timeout and the connection are the adapter's. It is not the statement of the expansion.

Synthetic data only. Nothing here prints an address or a login.
