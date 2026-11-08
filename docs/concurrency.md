# Concurrency limits

What limits the load one API process puts on a source, the numbers, and what the concurrency suite proves about them. The settings are keys of a source's `budgets` in the mapping.

## The limits

| Limit | Default | Setting | What happens beyond it |
|---|---|---|---|
| Reads one person has in flight on a source | 2 | `user_concurrency` | The read waits for a slot |
| Reads everyone together has in flight on a source | 32 | `source_concurrency` | The read waits for a slot |
| The wait for both slots | 2,000 ms | `queue_wait_ms` | HTTP 503 `SOURCE_BUSY`, `retryable: true`; the source is never asked |
| Requests of one person on a source in any 60 seconds | 120 | `requests_per_minute` | HTTP 429 `RATE_LIMITED`, `retryable: true`, `details.retryAfterMs` |
| Timeouts of a source that open the circuit breaker | 5 in 60,000 ms, open for 30,000 ms | `breaker_failures`, `breaker_window_ms`, `breaker_cooldown_ms` | HTTP 503 `SOURCE_UNAVAILABLE`, reason `repeated-timeouts`; see [circuit-breaker.md](circuit-breaker.md) |

Each read takes the person's slot on the source, then a slot of the source, within one wait. Waiting reads are served in the order they came. A read gives both slots back when it ends, however it ends. A read whose release is lost, or never made, inside a running process loses its slots by itself when its lease expires: at most 10,000 ms (the time left to the request's deadline) plus the source's `timeout_ms` (5,000 ms by default). The slots are in the process's memory, so a restart clears them too. A request that reads several pages holds one lease for all of them.

Before the data read of a request, the gate reads the source's index list as the system principal, which is held by the source limit alone. So when a source is saturated, a new request can be refused at that first read, before it takes its own slot.

The request rate is a sliding window: a request counts for 60 seconds, a request sent after exactly the wait that a refusal named is admitted, and a refused request is not counted. Requests the breaker refuses still count. Health probes and `GET /v1/me` are not counted.

The limits live in one API process. Several copies of the API each have their own, and a restart clears them.

## What the suite proves

[`tools/concurrency-suite`](../tools/concurrency-suite/README.md) sends many simultaneous requests through the real API, gate, read slots, request limiter and circuit breaker, composed as the Community install composes them, over a scripted source that holds, answers or times out each read on the test's command. A wait, a lease's expiry, the rate window and the cool-down run on one clock that the test moves, so no result depends on how long anything takes.

- Ten requests of one person at once: exactly 2 reach the source and 8 wait; one read ending starts exactly one more; the most reads at the source over the whole run is 2.
- Forty people at once: exactly 32 reach the source and 8 wait for it; a person who sends five is held to 2 without blocking the others; a saturated source does not slow another.
- A read refused for want of a slot answers `SOURCE_BUSY` at 2,000 ms and not before, never reaches the source, and gives back the slot it took on the way.
- A lease that is never released frees both slots at its time to live and not a millisecond before, and a late release afterwards frees nothing twice.
- Two hundred requests at once: 120 are not refused and 80 answer `RATE_LIMITED`; the named wait is exact to the millisecond; a refused request is not counted; a steady 120 a minute is never refused.
- Five concurrent timeouts open the breaker (four do not; the window includes its last millisecond); while open, fifty simultaneous reads are refused before any slot and another source is served; after the cool-down exactly one of twenty reads is the trial; an answer closes the breaker, a timeout opens it for a full cool-down; a cancelled read, a busy refusal and a failure that is not a timeout count for nothing.
- Sixteen breaks were made in scratch copies of the code, and the suite failed on each: a user limit of 3, a source limit of 33, a wait of 3,000 ms, a rate of 121, a window of 59 seconds, a refused request counted, a threshold of 6, a cool-down of 29 seconds, a window that excludes its last millisecond, an ignored cool-down, a second trial, any failure counted as a timeout, a lease that never expires, a user slot not given back, a slot of a refused read kept, and a source slot not given back.
- On a real Neo4j (`pnpm test:neo4j`, not in CI), ten reads of one person at once never show more than two of their transactions on the server, and the slots are all given back.

## What it does not cover

Several API copies and a shared store for the limits. The web banners for these states have their own tests. How long a read takes on a real server is not asserted anywhere in the suite.
