# AI runtime: manual expand beside AI requests

Records the workload and the margin that keep AI requests from slowing a manual expand, and the figure at which a reply check leaves the main thread. The figures are in `ai-runtime.json`; the acceptance test (`tools/concurrency-suite/src/ai-load.test.ts`) holds the code to them, and a second test fails when the defaults of the share and of the offload threshold differ from them.

```bash
pnpm --filter @neburyx/concurrency-suite calibrate
```

writes `ai-runtime.json` again from a full run. A plain run of the tests never writes it.

## What is measured

- **The workload.** 48 AI requests are in flight, half Ask questions (`POST /v1/ask`) and half summary clicks (`POST /v1/summary`), through the real application and the real enterprise extension, with a stub classifier and a stub summarizer in place of the model. The reads of both go through the core's gate client, which marks them as AI reads. 48 is more than the 32 slots of a source and the 2 of a person; the test client holds at most 64 sockets and the expand needs one of them.
- **The source and the expand.** A scripted source answers each read after a set time of the suite's own clock. The manual expand is `POST /v1/graph/expand` for one entity with one neighbor type, which makes two reads in turn (the entity, then its neighbors), by the same person as the AI requests.
- **The repetitions.** Nine, one for each source read time from 10 to 50 ms in steps of 5. Each repetition times the expand alone, with the 48 AI requests under the share, and with the 48 AI requests and no share.
- **The statistics.** The median and the nearest-rank 95th percentile of the nine times, in milliseconds of the suite's clock. The clock is the suite's (the waits of the read slots and the time of the source are its own), so the figures do not depend on how busy the machine is; what a busy event loop adds is the other half of the claim and is covered by the check offload (below).
- **The margin.** The measured regression is the 95th percentile of the ratio of the time with AI requests to the time alone. The margin is that ratio with a quarter of headroom, rounded up to a twentieth. The acceptance test requires both the median and the 95th percentile with AI requests to be within the margin of the same statistic alone.

## Figures

| | Median (ms) | 95th percentile (ms) |
|---|---|---|
| Manual expand alone | 60 | 100 |
| With 48 AI requests, share 0.5 | 60 | 100 |
| With 48 AI requests, no share | 780 | 1,300 |

The margin is 1.25. With the share off the expand waits behind the queue of AI requests, 13 times its time alone, so the acceptance test also runs with the share off and fails the margin (a test that it can detect a slowdown).

## The check offload

The shared reply check on the largest view (300 elements, 30 sentences) measured a 95th percentile of 11.806 ms over 200 runs on a development machine. A check that measures over four times that, rounded up to 5 ms (50 ms), runs in a worker thread from then on. The measurement is per check, kept for the life of the process, and a check that measures under the threshold again runs in place again.

## What this does not cover

Real assistant turns (the dispatcher of the assistant, which is not built yet); the proof with them is added when it is. A source with real latency: the source's own contention is bounded by the budgets, not by this share. Event-loop delay under a heavy load, which the check offload's own tests measure with a deliberately slow check.
