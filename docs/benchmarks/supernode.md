# Supernode benchmark

> Db hit figures in this record are not to be cited without the section "Db hits of the first dated page".
>
> Rendered again from the stored run of 2026-11-07, not from a new run.

The cost of one page of the paged expand (`POST /v1/graph/expand`, template `expand-neighbors`) and of the degree preview, on a node of 1,000, 10,000 and 100,000 relationships of each type, measured through the gate against a Neo4j server. Synthetic data only. Written by `pnpm bench:supernode`; the numbers are in [supernode.json](supernode.json).

## What a page costs the server

Each page still matches every relationship of the anchor for the asked type before it sorts and cuts. The statement matches all of them in each of its branches, orders them, and keeps the page and one row, so the work of a page grows with the number of relationships of the type on the node, whichever page is asked; the keyset cursor only decides which rows survive the cut. (TAS §8.2, "What keyset buys, honestly".)

The statement the gate renders has several branches, each of which matches the relationships of its type again (the profile tables give the count and the server's own db hits for each read set, size and position).

## Db hits of the first dated page

The plan the server made the first time it saw the statement after the database was built reads the whole relationship index of the type seven separate times across the four branches of the statement, so the db hits of that plan are 7 x (N + 1) plus the work of the page, N being the relationships of the type in the whole database and not the node's. Plans made later for the same statement with another parameter shape expand from the anchor instead and take about 11,000 db hits for the same rows. Which plan a request gets follows when its plan was first made, not whether it has a cursor: asked with a cursor first, the plan with a cursor scans and the one without expands. A plan, once made, is kept for the run. In a small database the later plan scans as well.

Affected:
- the db hits and server times of the position whose plan was made first after the database was built: in this record the first position of the dated read set, at every size

Not affected:
- the db hits of the 10 %, 50 % and 90 % positions of the dated read set
- the other read sets show no extra db hits at their first position in this record; their plans were not examined

## How it was measured

- Run on the code of commit d51630f, before the read slots of a later commit: each read now waits for a slot, which this run did not.
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

## Cancel

- This measurement was taken on the code of commit 293557f with the cancel change on top, before that change was rebased onto the commits that add the heavy-operation warning, the request rate limit and the precomputed degree counts. It was not repeated after the rebase.

A running expand (the first page of the "all four types" read set) is aborted once the server lists its transaction as running, and the server's list of running transactions is then looked at, about every 25 ms, until the transaction is no longer listed. The time is the first look that found it gone, counted from the abort, so it is exact only to within one look and the round trip of that look. These are observed times and not promises: the guaranteed stop of a read is the server's transaction timeout (5 s here, TAS §13).

| Relationships | Aborted while running | Transaction gone: p50 (ms) | p95 (ms) | max (ms) | Finished before the abort | Still listed after the timeout | The same read, not aborted: p50 (ms) |
|---|---|---|---|---|---|---|---|
| 1,000 | 20 of 20 | 10.0 | 45.5 | 47.1 | 0 | 0 | 65.3 |
| 10,000 | 20 of 20 | 10.6 | 49.7 | 50.1 | 0 | 0 | 211 |
| 100,000 | 20 of 20 | 9.4 | 11.3 | 11.6 | 0 | 0 | 970 |

A read that finished before it could be aborted has no time and is counted on its own. A read that is short (a few milliseconds, as at 1,000 relationships) cannot be told from one that ended by itself, so only the sizes where the uncancelled read is much longer than the time to gone show a stop that the abort caused.

## Filtered, ranked and counted reads

Run on the code of commit 6bc4ba3 on 2026-11-08, on Neo4j 5.26.32 (enterprise), by `refined.benchmark.test.ts`, apart from the run of the rest of this record, which is as it was. The anchors are the dated relationships (`LINKED`) of the sizes below; each carries `score` (`i % 20`) and its neighbor `band` and `size`. Each cell is the first page of 25 (a page at any depth reads the same relationships), 30 timed reads after 5 untimed, through the gate; db hits are those of the server's plan for one profiled run. The count has no cap and is exact.

A page still matches every relationship of the type on the node before it sorts and cuts, whatever the filter or the rank; a condition reads its property on every relationship, so a filter that keeps nearly everything costs more than no filter and a selective one costs less, a rank by a neighbor property reads one more property for each candidate, and the count reads the relationships without sorting or returning rows. No index is used or needed.

| Relationships | Read | Result | p50 (ms) | p95 (ms) | max (ms) | db hits |
|---|---|---|---|---|---|---|
| 10,000 | no filter, most recent (baseline) | 25 rows | 81 | 145 | 365 | 110,266 |
| 10,000 | rank by a relationship property, highest first | 25 rows | 89 | 100 | 296 | 110,266 |
| 10,000 | rank by a relationship property, lowest first | 25 rows | 88 | 99 | 237 | 110,266 |
| 10,000 | rank by a neighbor property, highest first | 25 rows | 94 | 105 | 245 | 130,266 |
| 10,000 | selective filter (1 in 20) | 25 rows | 57 | 80 | 223 | 83,766 |
| 10,000 | loose filter (all) | 25 rows | 101 | 127 | 261 | 150,266 |
| 10,000 | selective filter, ranked by a relationship property | 25 rows | 55 | 70 | 217 | 82,766 |
| 10,000 | count, selective filter | 500 (exact) | 42 | 63 | 65 | 21,003 |
| 10,000 | count, loose filter | 10,000 (exact) | 46 | 62 | 66 | 40,003 |
| 100,000 | no filter, most recent (baseline) | 25 rows | 471 | 534 | 564 | 1,100,266 |
| 100,000 | rank by a relationship property, highest first | 25 rows | 549 | 615 | 646 | 1,100,266 |
| 100,000 | rank by a relationship property, lowest first | 25 rows | 534 | 615 | 617 | 1,100,266 |
| 100,000 | rank by a neighbor property, highest first | 25 rows | 581 | 649 | 661 | 1,300,266 |
| 100,000 | selective filter (1 in 20) | 25 rows | 189 | 206 | 213 | 835,266 |
| 100,000 | loose filter (all) | 25 rows | 614 | 718 | 720 | 1,500,266 |
| 100,000 | selective filter, ranked by a relationship property | 25 rows | 193 | 205 | 208 | 825,266 |
| 100,000 | count, selective filter | 5,000 (exact) | 58 | 67 | 70 | 210,003 |
| 100,000 | count, loose filter | 100,000 (exact) | 63 | 71 | 71 | 400,003 |

## Not measured

- Neo4j 2026.x and other editions: only the dev server was measured. The series check of the test helper accepts 2026.x, but no 2026.x server was reachable, so no run was made on it.
- The banking demo pack's own node (the plain read set has its shape and size), concurrent readers, a cold server, the cost of a cancelled read and the CI supernode suite.
