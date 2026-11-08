# Source state with several API copies

What state the Sources page shows for a source, which stored check decides it, and what stays different between API copies. Applies to one copy as well; with one copy nothing below is visible.

## The rule

Every API copy stores the checks it makes (the start-up check, the Sources page Test, `test-source`) in the `source_checks` table, and every copy reads them back. The state a source shows after a ping reached it is that of **one check**: the newest check, made by any copy, that

- reached the source (its report holds the server's answer), and
- was made for the connection and the mapping this copy runs (the stored identity hash and mapping hash equal the copy's own).

"Newest" is the time the check says it was made; two checks with the same time are ordered by their ID, the larger one wins. No copy's start time is part of the rule, so a copy started later shows what a copy started earlier shows. If no check qualifies, the state is `unknown` with the reason "The source has not been checked since the start."

The rule is applied in two places, and a third write is an observation:

- **A ping that reaches the source** sets the state from the rule.
- **A start whose check ended on a gate failure that says nothing about the source** (so no check was stored; the source may even have answered) sets `unknown` only when no check qualifies. It never overwrites a state another copy decided.
- **A check that is stored** sets the state from the newest stored check of the source, whatever its connection or mapping and whether or not it reached the source: a test that has just found the source down shows it down, and a run against a re-pointed mapping shows its own result. The next successful ping decides again by the rule.

A ping that could not reach the source sets `unavailable` with the sentence of the failure, unless a check was stored after the ping's read began. A change to a source's connection or mapping resets its state to `unknown` until a check for the new one is stored.

## What changed for a single copy

After a restart whose start-up check could not reach the source, the last stored state for the same connection and mapping is shown again once a ping reaches the source. Earlier it stayed `unknown` until a new check. A fresh install, a changed mapping or connection, and a source that was never reached still show `unknown`.

## What is not shared

- Copies that disagree about whether the source can be reached (one can, one cannot) write different states on their pings. Pings store no check.
- The time of a check is the clock of the copy that made it. A copy whose clock runs behind or ahead can lose or win "newest" by that difference.
- A source keeps its newest 50 checks. Fifty newer checks that did not reach the source remove the last qualifying one, and the state is then `unknown`.
- Copies running different mappings or connections of one source (during a rolling upgrade, for example) each decide against their own, and each start resets the stored state, so their pings disagree until all copies run the same mapping.
- The circuit breaker's state is kept in each copy's own memory. Copies can differ on whether they refuse reads of a source; they do not differ on the state shown.
