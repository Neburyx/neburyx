# tools/summary-suite

Tests of the safety and quality claims of the AI case summary: the real enterprise summarizer (its assembly of the text, size guard, drafting loop, checks, sealing, run record and audit events) over a scripted model that the test controls, on a labelled set of 15 small synthetic views. No server of its own, no network beyond the loopback and no model call; they run in `pnpm test`. The live scoring of real summaries against the labelled set is a separate, later command.

| Command | Runs |
|---|---|
| `pnpm test` (from the root, or in this folder) | Every suite of this package. |

## How it is built

- `src/testing/rig.ts` (in the folder the open-core check exempts, because it imports the enterprise package) starts the real `createCaseSummarizer` over a scripted provider (the replies a case gives, in order; a reply may be a function of the request and of the abort signal) and keeps what the provider received, the events of the audit sink and the rows of an in-memory run store.
- `src/view.ts` builds small synthetic views; `src/cases.ts` loads the labelled set and turns a case into the reading the summarizer takes, and finds the key each element received in the sent text.
- `src/checks.ts` holds the suite's own statements of the rules (every sentence cited, every number a standalone number on a cited line, a count with its label, no verdict wording, no invented name, an expected text compared by hand, hashes worked out here). They are written apart from the product's checks, so that a product check that is removed leaves a sentence the helpers catch. Every helper has a canary: a test that gives it a deliberately bad output and expects it to fail.
- `src/score.ts` is the pure scorer of the method below.

A check removed from the product fails the suite, and `src/removed-checks.test.ts` shows it on every run: it takes one test out of the source text of the product's own checks (the citation, number, unknown-count, count-label, name or verdict test, one at a time), builds the summarizer from that changed source, and expects the suite's own helpers to fail on the sentence that is then kept, and to pass with the product as it is. If the product's source no longer holds the text a mutation removes, the test fails and says which mutation to update.

## The labelled set and its method

`cases/cases.yaml` holds 15 views: 8 demo views, each restating in small synthetic elements a case of the banking-fraud or insurance-claims pack's `cases.yaml` (named by `source_case`), and 7 AML views, each a synthetic arrangement of one shape of the typology (`shape`: fan-in, fan-out, cycle, rapid pass-through, shared device, shared address, and a fan-in whose count of further accounts is not known). Each case has:

- `entities` (a local `key`, a type, an id, a name, properties) and `relationships` between them, which `readingOf` turns into what the gate would have returned;
- `facts`: what a summary of the view must mention, each with the `phrases` that count as mentioning it and the elements it `rests_on`;
- `claims`: what a summary must not say, each with the phrases that make the claim;
- `invented_names`: names that are in no element of the view, for the invented-name measurement;
- `sentences`: candidate sentences a human labelled `keep` (must survive every check) or `remove` with the rule that must remove it (`citation`, `number`, `name` or `verdict`). The tests run each sentence through the real checks, so a label that disagrees with the product fails the suite.

How a case is written and reviewed:

1. A new case restates a case of a demo pack or one shape of the typology, in synthetic names only: no real, employer or private AML data, no real-looking e-mail address, phone number or account number (a test scans for them).
2. The facts are what a careful analyst would say of the view; the claims are what the view does not support (a verdict, a count it does not give, a link it does not show).
3. A change of a case or of the set is reviewed by a second person, and the whole set is reviewed whenever the prompt or the typology file changes.

How a summary is scored (`scoreSummary`, `scoreLabelled`): a fact is found when a kept sentence holds one of its phrases and cites a key it rests on; a claim is made when a kept sentence holds one of its phrases; an invented name is kept when a kept sentence holds it. Against the labelled sentences, a `keep` sentence that was not kept is a good sentence removed wrongly (a sentence whose key was taken out of its text counts as kept), and a `remove` sentence that was kept slipped through a check. Only the reply that was checked is compared with the sentences kept from it, so a reply that a further call replaced is never counted.

Limits of the method: phrases are matched as lower-case text, so a paraphrase is a missed fact and a phrase that is not listed is not a made claim; the name check finds identifier-like, quoted and capitalised words only, so a lower-case name or an unquoted alphabetic id may slip through (accepted, and measured here: each case holds one such sentence, labelled a known slip, and the tests fail if the name check ever catches it, so that the label is updated); the verdict check is a fixed phrase list, so a scheme it does not name is not caught. A later live run scores real summaries through the same scorer.

## Named tests

`src/named-tests.test.ts` fails if a test named here is not found in its file. The first column says what the row proves; the rows with files outside this folder name existing tests of the product that the suite relies on and does not repeat.

| What it proves | File | Test |
|---|---|---|
| A whole click answers ok with cited sentences, a token that opens, one request, its events with the run id and its run row | `src/first-path.test.ts` | answers ok with cited sentences and a token that opens |
| No event holds the text of the values or of the reply | `src/first-path.test.ts` | keeps no text of the values or of the reply in any event |
| The citation helper fails on a sentence that cites nothing or a key not sent | `src/checks.test.ts` | canary: expectCited fails |
| The text helper fails when a record holds a sentinel, also one with a line break, a quote or a control character | `src/checks.test.ts` | canary: expectNoText finds a sentinel with |
| The set holds 15 views, 8 demo and 7 AML, every shape of the typology | `src/cases.test.ts` | holds 15 views |
| The set is synthetic | `src/cases.test.ts` | is synthetic: every name is from the list |
| An invalid file fails with the case named, for each invariant of the set | `src/cases.test.ts` | names the case when the file is invalid |
| The labels agree with the real checks and with the rule each names | `src/cases.test.ts` | has labels that agree with the real checks and with the rule each names |
| The keep sentences state every fact and make no claim | `src/cases.test.ts` | has keep sentences that state every fact |
| The scorer catches a missed fact, a made claim and an invented name | `src/cases.test.ts` | canary: a summary that says nothing misses every fact |
| The scorer counts a good sentence removed and a sentence that slipped | `src/cases.test.ts` | counts a good sentence that was removed |
| A sentence with a supported fact and forbidden wording is not a wrong removal | `src/cases.test.ts` | does not count as wrongly removed a sentence that holds a supported fact |
| A sentence whose key was taken out of its text counts as kept, on the real checked output | `src/cases.test.ts` | counts a good sentence as kept when the checks took a key out of its text |
| Only the checked reply is scored, through a real regeneration | `src/cases.test.ts` | scores only the reply that was checked |
| The accepted name slips are measured on real checked replies | `src/cases.test.ts` | measures the accepted slips |
| What is sent is the expected text, written by hand, and equals the disclosure | `src/assembly.test.ts` | is, for a view of two entities and a stored relationship, exactly the expected text |
| The same for masked values, aggregates, derived relationships, an end not read and a reference not read | `src/assembly.test.ts` | is, for a view with a masked value |
| A dropped field, a duplicated element and a leaked value are caught | `src/assembly.test.ts` | canary: a text that drops a field |
| Every view sends each element once and holds no element text in the instructions | `src/assembly.test.ts` | holds in its instructions no element text |
| An end that was not read is sent as returned, gets no key and cannot be cited | `src/assembly.test.ts` | sends the type and id of an end the gate returned |
| A masked value is sent as the analyst sees it and the unmasked value goes nowhere, through the real gate | `src/assembly.test.ts` | sends a masked value as the analyst sees it on screen |
| The names an analyst sees are sent when the mask is off | `src/assembly.test.ts` | sends the names an analyst sees when the mask is off |
| An element the gate withheld or could not read goes nowhere | `src/assembly.test.ts` | sends nothing of an element the gate withheld or could not read |
| A number only on an element the sentence does not cite, an estimated or lower-bound count without its label, and a number beside an unknown count are removed, each with its control, on every view | `src/checks-on-views.test.ts` | and keeps the sentence that follows the rule |
| An uncited sentence, a key not sent, a name not sent and verdict wording are removed beside a good sentence, on every view | `src/checks-on-views.test.ts` | removes a sentence that cites nothing, a key that was not sent |
| Twelve sentences are kept and thirteen are a format failure, on every view | `src/checks-on-views.test.ts` | keeps 12 sentences and makes a format failure of 13 |
| A verdict earns a further call and is removed at the last call, on every view | `src/checks-on-views.test.ts` | earns a further call, and a last reply that still holds it has the sentence removed |
| An emptied reply earns a further call | `src/checks-on-views.test.ts` | earns a further call when no sentence is left |
| The helpers of the rules fail on what the checks should have removed, and on a number supported only by the digits of an id | `src/checks-on-views.test.ts` | canary: a number is not supported by the digits of an id or a key |
| Each test of the product's own checks taken out of its source, in turn (citations, numbers on the cited lines, the unknown count, the label of an inexact count, names, verdict wording), leaves a sentence the suite fails on, and the suite passes with the product as it is | `src/removed-checks.test.ts` | fails the suite when the source of the product no longer tests |
| The coverage line is the server's and a model's coverage claim changes nothing of it | `src/coverage-and-events.test.ts` | is built from the counts and their labels |
| An unknown count gives no number | `src/coverage-and-events.test.ts` | gives an unknown count no number |
| A lower bound keeps its label | `src/coverage-and-events.test.ts` | gives a lower bound its label |
| The closing event holds the counts of the checked reply and no text | `src/coverage-and-events.test.ts` | holds the sentences kept and removed of the reply that was checked |
| The closing event keeps the counts of the last checked reply when a later call fails | `src/coverage-and-events.test.ts` | holds the counts of the last checked reply when a later call fails |
| The closing event holds neither count when no reply was checked | `src/coverage-and-events.test.ts` | holds neither count when no reply was checked |
| The closing event keeps the counts when the time limit ends a later call (existing) | `../../ee/ask/src/case-summary/summarizer.test.ts` | keeps the counts of the last checked reply when the time limit ends a later call |
| The scanner for offence words finds each word | `src/typology.test.ts` | canary: finds |
| The shipped typology words each shape without an offence and forbids asserting one | `src/typology.test.ts` | has a typology that names each shape |
| The shipped prompt prohibits verdicts and the instructions hold both files | `src/typology.test.ts` | has a prompt that expressly prohibits stating or implying guilt |
| A shape is cited, never asserted | `src/typology.test.ts` | is kept when the sentence says the arrangement has the shape of a fan-in |
| A verdict about a shape is regenerated, then removed | `src/typology.test.ts` | earns a further call and, when the last call still holds it, is removed |
| A replacement typology file reaches the instructions and hash that the real extension's own summarizer sends to a scripted provider, and changes neither the format nor the checks | `src/typology.test.ts` | carries the file into the instructions and their hash that the summarizer of the extension sends |
| Hostile element text, in a title or a property value, stays in the values and forges no key | `src/injection.test.ts` | changes nothing of the instructions, stays inside the values and forges no key |
| A reply that obeys the injection leaves no uncited sentence, no verdict, no forged key | `src/injection.test.ts` | has its extra sentence with no citation |
| Extra fields in a reply change nothing of the answer's structure | `src/injection.test.ts` | answers in the structure of the reply format only |
| A reply of more than 12 sentences is a format failure | `src/injection.test.ts` | is a format failure, and not a draft |
| A forged reply around the text is not a draft | `src/injection.test.ts` | is not a draft when the reply is the forged reply of an element |
| Hostile text reaches no event and no log line of the real application | `src/injection.test.ts` | reaches the model inside the values and no event and no log line of the application |
| The log check fails when a log line holds the text | `src/injection.test.ts` | canary: the log check fails when a log line holds the text |
| The call limit holds, default and configured, on every view | `src/limits.test.ts` | makes exactly the configured number of requests |
| A reply that does not fit earns one further call with a fixed note | `src/limits.test.ts` | makes one further call for a reply that does not fit |
| The total time limit aborts the call on a clock the test moves and makes no further call | `src/limits.test.ts` | aborts the call in flight when the clock passes the limit |
| A cancel before the text is assembled makes no call and ends the run cancelled, on every view | `src/limits.test.ts` | before the text is assembled makes no call |
| A cancel while the call is in flight makes no second call, even for a late reply, on every view | `src/limits.test.ts` | while the first call is in flight aborts it |
| A cancel while the gate reads the view stops the read and makes no model call (on the application's own two-widget view: the test source serves no other) | `../../services/api/src/profile/ee-summary-cancel.test.ts` | aborts the read, makes no further read and no model call |
| A cancel over a real connection aborts the call and reads the source no more | `../../services/api/src/profile/ee-summary-cancel.test.ts` | aborts the call, makes no second call, reads the source no more |
| A cancel while a call is recorded as begun never asks the model (existing) | `../../ee/ask/src/case-summary/summarizer.test.ts` | never asks the model when the cancel arrives while the call is recorded as begun |
| A cancel while a failed call's end is recorded marks the call cancelled (existing) | `../../ee/ask/src/case-summary/summarizer.test.ts` | marks a call whose provider failed cancelled when the cancel arrives while its end is recorded |
| A cancel while an answer is recorded marks the call cancelled (existing) | `../../ee/ask/src/case-summary/summarizer.test.ts` | marks the call cancelled when the cancel arrives while its answer is recorded |
| A cancel while the run row is finished ends run and event cancelled (existing) | `../../ee/ask/src/case-summary/summarizer.test.ts` | ends the run and the closing event as cancelled, not ok, when the cancel arrives while the run row is finished |
| A cancel while the closing event is written changes nothing (existing) | `../../ee/ask/src/case-summary/summarizer.test.ts` | changes nothing when the cancel arrives while the closing event is being written |
| A cancel before the text is measured is cancelled, not too large (existing) | `../../ee/ask/src/case-summary/summarizer.test.ts` | ends a click that was cancelled before its text was measured as cancelled |
| The counts of the closing event are those of the checked reply when the client cancels after it (existing) | `../../ee/ask/src/case-summary/summarizer.test.ts` | keeps the counts of the reply that was checked |
| The run holds the exact instructions, text sent and reply of each call | `src/limits.test.ts` | holds, for each call, the exact instructions |
| A run is removed after the retention period through the summarizer's store | `src/limits.test.ts` | removes a run after the retention period |
| Removal runs at start-up with the default retention (existing) | `../../ee/ask/src/case-summary/retention.test.ts` | runs at start-up with a cutoff of the retention period |
| The retention setting is the one used (existing) | `../../ee/ask/src/case-summary/retention.test.ts` | uses the retention days the setting names |
| Removal repeats on a timer and stops with the sink (existing) | `../../ee/ask/src/case-summary/retention.test.ts` | runs again on the interval, and stops when the sink is closed |
| A run that started at the cutoff is kept (existing) | `../../ee/ask/src/case-summary/retention.test.ts` | keeps a run that started exactly at the cutoff |
| The events hold the metadata, the run id and the hashes worked out here, and no text | `src/limits.test.ts` | is one per-call event for each request and one closing event |
| No event holds the instructions, and the check fails on one that does | `src/limits.test.ts` | holds no text of the instructions in any event |
| The reply the checks judged last is the last that fits the reply format, and an object answer is captured | `src/rig.test.ts` | is the last reply that fits the reply format |
| A scripted answer given as an object is captured | `src/rig.test.ts` | is captured for a scripted answer given as an object |
| The scanner for verdict wording finds each kind of wording | `src/checks-on-views.test.ts` | canary: the verdict scanner finds the wording of |
| A provider failure ends the click at once, recorded | `src/limits.test.ts` | ends a click whose provider fails at once |
| The record of a click on a real Postgres (existing) | `../../services/api/src/migrate/preview-tables.integration.test.ts` | a whole click |
