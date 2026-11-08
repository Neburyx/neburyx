# Circuit breaker

What stops a source from being asked again when its reads keep timing out, what a person sees, how the source comes back, and the three settings that tune it.

## The rule

Each source has a breaker in the API process. It opens when `breaker_failures` reads of that source time out within `breaker_window_ms`, and stays open for `breaker_cooldown_ms`. All three are keys of the source's `budgets` in the mapping:

| Key | Default | Allowed |
|---|---|---|
| `breaker_failures` | 5 | 1 to 100 |
| `breaker_window_ms` | 60,000 | 1,000 to 600,000 |
| `breaker_cooldown_ms` | 30,000 | 1,000 to 600,000 |

A value outside its range fails the mapping at start-up with the key named.

## What counts as a timeout

A read counts when the source did not answer within the time it was given, and that time was a fair chance: the source's `timeout_ms`, or what the request's deadline left after the longest queue wait, whichever is less. These do not count: a read cancelled by the person, a read stopped by a request deadline that left it less than that, a read that never started, a refusal for want of a read slot (`SOURCE_BUSY`), a refusal for a missing index, and any other failure. An answer in between does not reset the count: the window alone decides. Reads the product makes by itself (the periodic check of the source, the schema read) count in the same way.

## What happens when it opens

While the breaker is open every read of that source is refused before it asks for a read slot and before it touches the source. The answer is HTTP 503 with the code `SOURCE_UNAVAILABLE`, `retryable: true`, `details.reason` `repeated-timeouts` and `details.retryAfterMs`, the time left of the cool-down; the `Retry-After` header carries the same wait in whole seconds. `SOURCE_BUSY` keeps its own meaning: no read slot freed within the wait. Reads that were already running or waiting for a slot when the breaker opened finish normally. Other sources are not affected.

## How the source comes back

When the cool-down has passed, one read is let through as a trial; reads that arrive while it runs are refused with the time left of the trial. The trial is the data read of a person's request. An answer closes the breaker and forgets the timeouts. A timeout opens it again for a full cool-down. Any other end (cancelled, another failure) decides nothing and the next read becomes the trial. The periodic check of the source never is the trial: it is refused while the breaker is not closed and the shown state of the source keeps its last value. The index-list read that comes first in a person's request is let through but does not decide.

With nobody using the product, the breaker stays half-open until the next person's read. The Sources page **Test** is a person's read, so it can be the trial.

## What a person sees

The status banner shows **Repeated timeouts** with the line "unavailable after repeated timeouts. The loaded graph remains available.", the wait counting down, and **Retry**, which is held until the wait is over and then sends the same request again. The loaded graph, the filters and the draft are as they were. A person's requests that the breaker refuses still count towards the source's request rate.

## What it does not do

The breaker lives in one API process; copies of the API each have their own. A restart closes it.

## Audit

A read that ends in a timeout is recorded as `failed` with the reason `timeout`; a read the breaker refuses is `failed` with no reason.
