# Cancelling a request

What happens when a person cancels a request that is reading the source, what the product does not promise about it, and what was tested.

## What happens

The browser aborts the request. The API sees the connection close before it wrote an answer, and the read stops at whatever stage it is in:

- **Waiting for a slot** (the person's or the source's read slot): the read leaves the queue, holds nothing, and the reads behind it keep their order.
- **Running on the source**: the adapter closes the read's session at once, with no rollback before it, and the read ends as cancelled. The read's slot is released when the connection is back.
- **Between the pages of one request** (an expansion of several neighbor types): the pages not yet read are not read.

The route writes no answer and the audit records the read as failed with the reason `cancelled`. The page keeps what it had: nothing is merged, the loaded graph and the filters are as they were, and **Run again** sends the same request.

## How the whole path is tested

A suite in [`tools/cancellation-suite`](../tools/cancellation-suite/README.md) runs the real API and the real web client and stores in one process and compares the whole client state (the investigation, the view with its hidden items and selection, the loaded graph, the paging progress of each node and what the API saved) before and after. It cancels a running expansion, a request that waits for a slot, a request between the pages of an expansion, a load more and a degree preview. It places the cancel at five points on the path of one answer, from the source's answer to after the client has finished the request, and checks that an answer is merged only when the request ended before the cancel and that the API audits what it did. Over a scripted source it runs in `pnpm test`, so in CI. Over a real Neo4j it cancels the expansion of a node of 100,000 relationships and checks that the server's transaction is gone, that no read slot is held and that the next read is served; that part runs with `pnpm test:neo4j` and is not in CI.

## What is not promised

No time is promised for the source to stop. Closing the session stopped the work in every test below, but how soon the source stops depends on the server, its load and the network between the two. The guaranteed stop of every read is the server-side transaction timeout of the source (5 seconds by default, 10 at most; see [query-timeout.md](query-timeout.md)). The figures in the [supernode benchmark](benchmarks/supernode.md) are observed times, not limits.

## What was tested

On a Neo4j Enterprise 5.26 server, with the Neo4j driver 6.3. Each test makes a database of its own and drops it.

| Case | Result |
|---|---|
| A running read of a synthetic node with 100,000 relationships, aborted once the server lists its transaction | The transaction is gone from the server's list within the server's next look; the times are in the [benchmark record](benchmarks/supernode.md) |
| The same for a degree preview, an entity read and a search | The same; short reads cannot be told from reads that ended by themselves, which the record says |
| A read aborted after its answer | Nothing changes; the answer stands |
| A login that can only read, ending its own running read with `TERMINATE TRANSACTION` | Permitted. The adapter reports a read ended this way as a failed read (`READ_FAILED`) |
| A write statement sent in a read-access session, by a login that may write | Refused by the server (`Neo.ClientError.Statement.AccessMode`); nothing is written. The product also sends only read-access sessions |
| Four reads cancelled together at a source limit of four (set for the test) | Every transaction is gone, no slot is held, no session stays open, and the next read is served |

The checks run with `pnpm test:neo4j` and `pnpm bench:supernode` against a server you own; they are not in CI. Run them again when the driver or a supported server version changes.

## Not verified

- Behind a proxy or a load balancer: whether a closed connection reaches the API when something sits in front of it is not tested.
- Neo4j AuraDB, and a cluster: not tested.
- Neo4j 2026.x: not tested here; the earlier [driver check](../tools/driver-check/README.md) looked at it for one query shape.
- Query shapes other than the ones above, and load beyond the source's read limit.
- A server that does not answer the close at all: the session is given up after the source's timeout and the read's slot is freed then.
