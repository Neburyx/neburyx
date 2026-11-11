# Benchmarks

## Supernode benchmark

Measures what one page of the paged expand costs on a node with 1,000, 10,000 and 100,000 relationships of each type, and the degree preview on the same nodes, through the real gate. The record of the last run is [supernode.md](supernode.md), with every number in [supernode.json](supernode.json). The graph is synthetic.

```bash
pnpm bench:supernode
```

It needs the connection of the Neo4j tests (`NBX_EE_URI`, `NBX_EE_USER`, `NBX_EE_PASSWORD`, or `~/.config/neburyx/dev-neo4j.env`; see `packages/test-neo4j/README.md`) and stops, naming the missing one, when it is not given. It makes a database of its own named `nbx-test-…`, builds the nodes, measures, writes the record into this folder and drops the database, also when a measurement fails. It does not write to any other database. It is not part of CI and takes hours at 100,000.

With `NBX_BENCH_RECORD_DIR` set to a folder, it writes the record there instead and leaves this folder as it is (the release checks use that).

What it measures, how a position and a sample are defined, and what the figures do not cover are in the record itself. The builder and the gate wiring are in `services/api/src/testing/benchmark/` (`fixture.ts`, `rig.ts`), kept apart from the measurement so that another measurement can start from the same graphs.

## Rendering the record again

`pnpm bench:refined` measures only the filtered, ranked and counted reads (rank by a relationship property and by a neighbor property, a selective and a loose filter, and the exact count) at 10,000 and at 100,000 relationships, in a database of its own, and adds them to `supernode.json` and `supernode.md` as a section that names the commit it ran on and the date. It changes nothing else in the record, and `pnpm bench:supernode` keeps that section when it rewrites the rest. It takes about 20 to 30 minutes.

`pnpm bench:render` renders `supernode.md` again from the stored `supernode.json` with no server, adding what is known of the extra db hits of the first page of the dated read set for the series of the stored run, and says so in the text. It fails, and exits non-zero, when the stored data is not the data of a run.

## Supernode test suite

`pnpm test:supernodes` runs the suite of `services/api/src/testing/supernodes/` against the Neo4j server of the Neo4j tests (it is also run by `pnpm test:neo4j`). It builds the three anchors of this benchmark once, in a database of its own that it drops at the end, and checks that no payload exceeds the page bound, that every count carries its quality, and that load-more reaches every row once. With `NBX_SUPERNODE_RECORD` set to a file, it also writes the wall time, size and (from one profile of the statement) db hits of the first page of every read set at each size and of the deep pages. Db hits of a first page of the dated read set carry the cause and the notice of the benchmark record. The suite has not been run on Neo4j 2026.x: no such server was reachable.
