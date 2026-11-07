# Supernode benchmark

The cost of one page of the paged expand (`POST /v1/graph/expand`, template `expand-neighbors`) and of the degree preview, on a node of 1,000, 10,000 and 100,000 relationships of each type, measured through the gate against a Neo4j server. Synthetic data only. Written by `pnpm bench:supernode`; the numbers are in [supernode.json](supernode.json).

## What a page costs the server

Each page still matches every relationship of the anchor for the asked type before it sorts and cuts. The statement matches all of them in each of its branches, orders them, and keeps the page and one row, so the work of a page grows with the number of relationships of the type on the node, whichever page is asked; the keyset cursor only decides which rows survive the cut. (TAS §8.2, "What keyset buys, honestly".)

The statement the gate renders has several branches, each of which matches the relationships of its type again (the profile tables give the count and the server's own db hits for each read set, size and position).

## How it was measured

- Neo4j 5.26.32 (enterprise); run on 2026-11-07. The server's address is not a loopback address. One benchmark process, one request at a time, no other load that the run made.
- One anchor per size, each with the same number of relationships of four types to one neighbor type: *dated* (an ID and a time), *undated* (an ID, no time), *aggregate* (no ID, a time, 10 relationships to each neighbor, read as one row per neighbor) and *plain* (no ID, no time, one relationship to each neighbor: the shape of the banking demo pack's 100,000-neighbor node, which is not loaded itself). *All* asks for the four together, as "expand neighbors" does for one neighbor type: at size 100,000 that is 400,000 relationships to 100,000 neighbors. "100k" below is the size 100,000 of every read set.
- Page size 25, the product's default. Time is the wall time of the gate call (resolve, validate, authorize, execute, normalize, redact, audit, with the driver and the network), in milliseconds. Budgets are the source's defaults (5 s read timeout, 10 s request).
- Positions: the first page, and the pages from 10 %, 50 % and 90 % of the order (rounded down to a multiple of 50 rows). A deep position is reached by walking the real chain of cursors the gate minted, at page size 50 and untimed, and its samples are taken as soon as the walk reaches it. At each position 30 consecutive pages are timed; if the order ends first, the position's page is requested again and *Repeated* says how many times.
- p95 is nearest rank: the smallest value that at least 95 % of the samples do not exceed (the 29th of 30). A call that fails (a timeout, a busy source) is a sample as long as the call took and is counted in *Failures*; a cell whose failures are over 5 % of its samples shows "at least", since a failed call's real length is not known.
- Before each read set, 5 untimed pages warm it. The very first request of the run is reported on its own and kept out of the cells.
- The cold first request took 1530 ms.
- The db hits and the server times come from one profiled run of the statement at each position, on a separate session; profiling adds cost of its own, so they are not comparable with the timed samples and a server time can exceed a wall-time p95.
- The walk fails the run on a repeated edge or on a page that is short before the last. The profile of each position runs the rendered statement once under PROFILE on a separate session and fails the run if the plan does not start from the stable ID index.

## Result

**Target met.** The worst p95 at 100,000 relationships is 1480 ms (all, first), under 3,000 ms (TAS §14, interactive latency).

### stored, dated (one relationship type with an ID and a time)

| Relationships | Position | Rows in the order | Samples | Failures | Repeated | p50 (ms) | p95 (ms) | max (ms) | Branches | db hits | Server ms (to first record / then to last) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | first | 1,000 | 30 | 0 | 0 | 44.6 | 343 | 787 | 4 | 782,191 | 196 / 666 |
| 1,000 | 10% | 1,000 | 30 | 0 | 0 | 40.0 | 64.6 | 78.1 | 4 | 10,889 | 146 / 10 |
| 1,000 | 50% | 1,000 | 30 | 0 | 1 | 57.9 | 75.1 | 75.2 | 4 | 9,689 | 0 / 11 |
| 1,000 | 90% | 1,000 | 30 | 0 | 7 | 41.6 | 62.8 | 63.3 | 4 | 8,489 | 1 / 14 |
| 10,000 | first | 10,000 | 30 | 0 | 0 | 106 | 126 | 363 | 4 | 827,191 | 1 / 397 |
| 10,000 | 10% | 10,000 | 30 | 0 | 0 | 108 | 149 | 154 | 4 | 107,189 | 1 / 80 |
| 10,000 | 50% | 10,000 | 30 | 0 | 0 | 92.2 | 113 | 134 | 4 | 95,189 | 1 / 63 |
| 10,000 | 90% | 10,000 | 30 | 0 | 0 | 65.6 | 97.0 | 125 | 4 | 83,189 | 1 / 49 |
| 100,000 | first | 100,000 | 30 | 0 | 0 | 891 | 1096 | 1552 | 4 | 1,277,191 | 139 / 1340 |
| 100,000 | 10% | 100,000 | 30 | 0 | 0 | 676 | 709 | 710 | 4 | 1,070,189 | 99 / 807 |
| 100,000 | 50% | 100,000 | 30 | 0 | 0 | 492 | 515 | 525 | 4 | 950,189 | 1 / 524 |
| 100,000 | 90% | 100,000 | 30 | 0 | 0 | 314 | 406 | 408 | 4 | 830,189 | 1 / 303 |

### stored, undated (one type with an ID and no time)

| Relationships | Position | Rows in the order | Samples | Failures | Repeated | p50 (ms) | p95 (ms) | max (ms) | Branches | db hits | Server ms (to first record / then to last) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | first | 1,000 | 30 | 0 | 0 | 43.3 | 127 | 159 | 2 | 6,160 | 49 / 5 |
| 1,000 | 10% | 1,000 | 30 | 0 | 0 | 47.0 | 88.4 | 128 | 2 | 5,960 | 22 / 5 |
| 1,000 | 50% | 1,000 | 30 | 0 | 1 | 44.4 | 59.0 | 64.5 | 2 | 5,160 | 0 / 4 |
| 1,000 | 90% | 1,000 | 30 | 0 | 7 | 47.3 | 60.7 | 68.3 | 2 | 4,360 | 2 / 15 |
| 10,000 | first | 10,000 | 30 | 0 | 0 | 53.2 | 80.0 | 107 | 2 | 60,160 | 0 / 30 |
| 10,000 | 10% | 10,000 | 30 | 0 | 0 | 53.2 | 75.0 | 77.1 | 2 | 58,160 | 0 / 39 |
| 10,000 | 50% | 10,000 | 30 | 0 | 0 | 54.3 | 79.4 | 81.9 | 2 | 50,160 | 1 / 29 |
| 10,000 | 90% | 10,000 | 30 | 0 | 0 | 44.6 | 52.6 | 60.6 | 2 | 42,160 | 0 / 24 |
| 100,000 | first | 100,000 | 30 | 0 | 0 | 166 | 207 | 383 | 2 | 600,160 | 19 / 188 |
| 100,000 | 10% | 100,000 | 30 | 0 | 0 | 165 | 201 | 202 | 2 | 580,160 | 22 / 215 |
| 100,000 | 50% | 100,000 | 30 | 0 | 0 | 141 | 157 | 158 | 2 | 500,160 | 0 / 136 |
| 100,000 | 90% | 100,000 | 30 | 0 | 0 | 125 | 155 | 163 | 2 | 420,160 | 0 / 89 |

### aggregate (one type with no ID, dated; ten relationships to each neighbor, read as one row per neighbor)

| Relationships | Position | Rows in the order | Samples | Failures | Repeated | p50 (ms) | p95 (ms) | max (ms) | Branches | db hits | Server ms (to first record / then to last) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | first | 100 | 30 | 0 | 7 | 53.4 | 150 | 316 | 2 | 16,082 | 59 / 6 |
| 1,000 | 50% | 100 | 30 | 0 | 15 | 44.1 | 98.6 | 116 | 2 | 16,082 | 59 / 6 |
| 10,000 | first | 1,000 | 30 | 0 | 0 | 68.1 | 90.7 | 93.5 | 2 | 160,082 | 0 / 52 |
| 10,000 | 10% | 1,000 | 30 | 0 | 0 | 59.4 | 87.3 | 109 | 2 | 160,082 | 1 / 59 |
| 10,000 | 50% | 1,000 | 30 | 0 | 1 | 60.0 | 89.6 | 160 | 2 | 160,082 | 0 / 53 |
| 10,000 | 90% | 1,000 | 30 | 0 | 7 | 63.4 | 86.8 | 92.0 | 2 | 160,082 | 0 / 52 |
| 100,000 | first | 10,000 | 30 | 0 | 0 | 295 | 336 | 578 | 2 | 1,600,082 | 47 / 415 |
| 100,000 | 10% | 10,000 | 30 | 0 | 0 | 288 | 341 | 349 | 2 | 1,600,082 | 48 / 401 |
| 100,000 | 50% | 10,000 | 30 | 0 | 0 | 286 | 329 | 359 | 2 | 1,600,082 | 1 / 336 |
| 100,000 | 90% | 10,000 | 30 | 0 | 0 | 278 | 313 | 367 | 2 | 1,600,082 | 0 / 248 |

### plain (one type with no ID and no time; one relationship to each neighbor, the shape of the banking demo pack's 100,000-neighbor node)

| Relationships | Position | Rows in the order | Samples | Failures | Repeated | p50 (ms) | p95 (ms) | max (ms) | Branches | db hits | Server ms (to first record / then to last) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | first | 1,000 | 30 | 0 | 0 | 44.2 | 72.3 | 90.0 | 1 | 5,081 | 17 / 4 |
| 1,000 | 10% | 1,000 | 30 | 0 | 0 | 42.8 | 89.5 | 107 | 1 | 5,081 | 2 / 4 |
| 1,000 | 50% | 1,000 | 30 | 0 | 1 | 30.7 | 49.6 | 51.0 | 1 | 5,081 | 1 / 3 |
| 1,000 | 90% | 1,000 | 30 | 0 | 7 | 31.6 | 48.1 | 84.1 | 1 | 5,081 | 1 / 6 |
| 10,000 | first | 10,000 | 30 | 0 | 0 | 54.5 | 90.3 | 99.6 | 1 | 50,081 | 1 / 22 |
| 10,000 | 10% | 10,000 | 30 | 0 | 0 | 54.7 | 82.9 | 82.9 | 1 | 50,081 | 1 / 35 |
| 10,000 | 50% | 10,000 | 30 | 0 | 0 | 42.1 | 60.0 | 83.0 | 1 | 50,081 | 0 / 30 |
| 10,000 | 90% | 10,000 | 30 | 0 | 0 | 46.6 | 70.5 | 128 | 1 | 50,081 | 1 / 23 |
| 100,000 | first | 100,000 | 30 | 0 | 0 | 174 | 201 | 536 | 1 | 500,081 | 12 / 170 |
| 100,000 | 10% | 100,000 | 30 | 0 | 0 | 174 | 347 | 358 | 1 | 500,081 | 13 / 229 |
| 100,000 | 50% | 100,000 | 30 | 0 | 0 | 166 | 331 | 344 | 1 | 500,081 | 1 / 186 |
| 100,000 | 90% | 100,000 | 30 | 0 | 0 | 156 | 337 | 430 | 1 | 500,081 | 17 / 245 |

### all four types together (the read of "expand neighbors" for one neighbor type)

| Relationships | Position | Rows in the order | Samples | Failures | Repeated | p50 (ms) | p95 (ms) | max (ms) | Branches | db hits | Server ms (to first record / then to last) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | first | 3,100 | 30 | 0 | 0 | 56.7 | 301 | 1110 | 9 | 38,219 | 196 / 19 |
| 1,000 | 10% | 3,100 | 30 | 0 | 0 | 54.6 | 78.0 | 104 | 9 | 37,320 | 206 / 22 |
| 1,000 | 50% | 3,100 | 30 | 0 | 0 | 51.1 | 85.1 | 93.8 | 9 | 33,266 | 0 / 31 |
| 1,000 | 90% | 3,100 | 30 | 0 | 2 | 40.6 | 55.3 | 72.1 | 9 | 27,086 | 0 / 11 |
| 10,000 | first | 31,000 | 30 | 0 | 0 | 158 | 236 | 284 | 9 | 380,219 | 1 / 160 |
| 10,000 | 10% | 31,000 | 30 | 0 | 0 | 142 | 163 | 173 | 9 | 370,920 | 1 / 175 |
| 10,000 | 50% | 31,000 | 30 | 0 | 0 | 96.3 | 129 | 157 | 9 | 331,166 | 1 / 130 |
| 10,000 | 90% | 31,000 | 30 | 0 | 0 | 134 | 222 | 233 | 9 | 270,086 | 0 / 196 |
| 100,000 | first | 310,000 | 30 | 0 | 0 | 1329 | 1480 | 1868 | 9 | 3,800,219 | 187 / 1440 |
| 100,000 | 10% | 310,000 | 30 | 0 | 0 | 1246 | 1369 | 1470 | 9 | 3,707,220 | 198 / 1987 |
| 100,000 | 50% | 310,000 | 30 | 0 | 0 | 664 | 759 | 915 | 9 | 3,310,166 | 333 / 1128 |
| 100,000 | 90% | 310,000 | 30 | 0 | 0 | 579 | 799 | 818 | 9 | 2,700,086 | 2 / 851 |

### Degree preview (bounded read)

| Relationships | Count labels | Samples | Failures | p50 (ms) | p95 (ms) | max (ms) |
|---|---|---|---|---|---|---|
| 1,000 | lowerBound / lowerBound / lowerBound / lowerBound | 30 | 0 | 33.8 | 79.7 | 91.8 |
| 10,000 | lowerBound / lowerBound / lowerBound / lowerBound | 30 | 0 | 34.5 | 44.8 | 47.9 |
| 100,000 | lowerBound / lowerBound / lowerBound / lowerBound | 30 | 0 | 45.1 | 89.5 | 94.5 |

## Not measured

- Neo4j 2026.x and other editions: only the dev server was measured. A 2026.x run needs the series check of the test helper (`testing/neo4j-server.ts`) widened and a server of that series.
- The banking demo pack's own node (the plain read set has its shape and size), concurrent readers, a cold server, the cost of a cancelled read and the CI supernode suite.
