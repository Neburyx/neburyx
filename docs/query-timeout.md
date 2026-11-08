# Query timeout

How long a read of the source may take, what happens when it takes longer, what a person sees, and what was measured.

## The limit

Every read of a source is opened as a transaction with the source's own timeout, set by the source's `timeout_ms` budget: 5 seconds when the mapping names none, and 10 seconds at most. A mapping that asks for more fails to load. The server stops the read when the timeout passes; the adapter also holds a guard at the request's deadline, so a read that the server does not stop is still given up.

A request that reads several things (an expansion of several neighbor types) shares one deadline of 10 seconds for all of its reads. When that deadline stops a request before the source's own timeout would, the answer names the deadline, not the source's timeout, so the number a person reads is the limit that was actually hit.

## What the answer is

A read past its limit answers HTTP 504 with the code `QUERY_TIMEOUT`, `retryable: true` and `details.timeoutMs`, the limit that stopped it. The body holds no query text, address or value. The audit event of the request is `failed`.

An expansion is atomic. If any of its reads times out, the answer holds no page at all, not even the pages read before it; nothing is merged and no partial result is claimed.

## What a person sees

The status banner shows **Timed out**, with the source's name and the limit ("did not answer within 5 s"), the line "Loaded graph and filters preserved; nothing was merged", and **Retry**, which sends the same request again. The loaded graph, the filters, the selection and the draft are as they were. Search shows a timeout in its own results, as before.

If the person cancels a request, the banner shows Cancelled even if a timeout answer arrives afterwards. See [cancellation.md](cancellation.md).

## What was measured

On a Neo4j Enterprise 5.26.32 server, with the Neo4j driver 6.3: a read that runs for longer than the budget, under a budget of 1,000 ms, answered `QUERY_TIMEOUT` 1,148 ms after the call (one run; the earlier [driver check](../tools/driver-check/README.md) saw 1.4 to 1.6 seconds for the same budget on two server versions). The server's list of running transactions was seen listing the read while it ran, and no longer held it 9 ms after the answer, the read's slot was released, and the next read was served. These are observed figures, not promises; the guaranteed stop of a read is the server-side timeout.

The check runs with `pnpm test:neo4j` against a server you own and is not in CI.

## Not verified

- Behind a proxy or a load balancer.
- Neo4j AuraDB, and a cluster.
- Neo4j 2026.x through the product (the driver check looked at it for one query shape).
- Neo4j Community through the product.
- Load beyond the source's read limit.
