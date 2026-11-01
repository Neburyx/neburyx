# driver-check

A by-hand check, not a test suite and not part of CI. It starts a throwaway Neo4j in a container,
writes 3,000 generated `Item` nodes into it, and reports what `neo4j-driver` and the server do when:

- a read in an explicit read transaction outlives its transaction timeout (1,000 ms);
- the client closes the transaction, or the session, while that read is running (20 s timeout).

The server's own transaction list (`SHOW TRANSACTIONS`) is sampled every 500 ms through a separate
connection, and the transaction under test is found by metadata the check puts on it, so the
report separates "the call ended" from "the server no longer lists the transaction". A sample
records when the look was sent and when its answer arrived; the report states the last look that
found the query running and the first later look that found the transaction gone, not the instant
it stopped. A reading that cannot be
established (the transaction was never seen running, or the list could not be read) is reported
as inconclusive.

```bash
pnpm check:driver                          # Neo4j 5.26 and the current calendar release (2026.x)
pnpm check:driver -- --image neo4j:5.26    # one image
```

Needs Docker. Exit codes: 0 when the check ran and cleaned up; 1 when an image could not be started
or run, or the arguments were invalid (a message on stderr, nothing on stdout); 2 when the report is
valid but a container, session or driver could not be cleaned up (the problems are on stderr and
in the report; remove a leftover container by hand). The numbers (3,000 nodes, the two timeouts, the 30 s settle limit, the 15 s tail) are
test values, not product limits.

Not tested: terminating a transaction as a read-only principal (Neo4j Community has no role-based
access control); whether a write sent in a read-access session is refused; behaviour behind a
proxy or in a cluster.

Run it from a clean state and let it finish: it takes about a minute per case. The Neo4j server
image is pulled only to run the check on the developer's machine and is not shipped.
