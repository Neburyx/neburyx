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

## Reading the log when a source stays unavailable

Each API copy writes the lines below. None holds a password, a server message or an entity ID. Only `source.ping_outcome` is written when the outcome changes; the others are written each time the event happens, as the last column says.

| Line | Level | Fields | Meaning |
|---|---|---|---|
| `source.ping_outcome` | `info` | `sourceId`, `outcome: reachable` | The ping reached the source after a tick that did not, or on the first tick. |
| `source.ping_outcome` | `warn` | `sourceId`, `outcome: unreachable`, `failure` | The ping did not reach the source. `failure` is `unreachable`, `authentication`, `credentials`, `database`, `refused` or `timeout`, the same kinds as the sentences on the Sources page. |
| `source.ping_outcome` | `info`, then `warn` once | `sourceId`, `outcome: skipped`, `cause` | The ping said nothing about the source, for example because its read slots were busy (`cause` is the error code and tag, such as `SOURCE_UNAVAILABLE:pool-full`). A skipped ping changes no state. The second skipped tick in a row writes the `warn` line; later ones write nothing. |
| `source.sign_in_refused` | `warn` | `sourceId`, `serverCode` | Written for every read that is refused at sign-in, so once per ping and once per check while the refusal lasts. A read was refused at sign-in. `Neo.ClientError.Security.AuthenticationRateLimit` means the server is locking the login after failed sign-ins and the lock ends by itself after the server's lock time; `Neo.ClientError.Security.Unauthorized` means the user name or password is wrong; `Neo.ClientError.Security.CredentialsExpired` means the password must be changed on the server. |
| `source.first_contact_check` | `info` for `pass`, `warn` otherwise | `sourceId`, `outcome`, `failure` when the server did not answer | Written each time that check ends. The full check runs after a ping reached a source with no settled check since the start, on every tick while it keeps being refused. A refused check stores its own state, which the next ping that reaches the source replaces. |
| `source.ping_overlap` | `warn` | none | Written once for a ping run that had not ended when the next one was due, however many ticks follow. |

`source.ping_outcome` is written only when the outcome differs from the tick before (a source skipped on several ticks in a row writes two lines), so a source that stays unavailable for an hour shows its first `source.ping_outcome` line and no more of them.
