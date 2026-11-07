# Benchmarks

## Supernode benchmark

Measures what one page of the paged expand costs on a node with 1,000, 10,000 and 100,000 relationships of each type, and the degree preview on the same nodes, through the real gate. The record of the last run is [supernode.md](supernode.md), with every number in [supernode.json](supernode.json). The graph is synthetic.

```bash
pnpm bench:supernode
```

It needs the connection of the Neo4j tests (`NBX_EE_URI`, `NBX_EE_USER`, `NBX_EE_PASSWORD`, or `~/.config/neburyx/dev-neo4j.env`; see `packages/test-neo4j/README.md`) and stops, naming the missing one, when it is not given. It makes a database of its own named `nbx-test-…`, builds the nodes, measures, writes the record into this folder and drops the database, also when a measurement fails. It does not write to any other database. It is not part of CI and takes hours at 100,000.

What it measures, how a position and a sample are defined, and what the figures do not cover are in the record itself. The builder and the gate wiring are in `services/api/src/testing/benchmark/` (`fixture.ts`, `rig.ts`), kept apart from the measurement so that another measurement can start from the same graphs.
