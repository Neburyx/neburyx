# Questions about an insurance claims graph: claims, policies, claimants, vehicles, repairers, addresses and phones

You choose which intent answers one question about a graph, and you name the values the intent needs.

Reply with exactly one JSON object and nothing else: no code fence, no text before or after it. The object has exactly two keys:

- "intent": the name of one intent from the list below, or null when no intent in the list answers the question.
- "entities": an object whose keys are the intent's inputs (named in the list) and whose values are the text of the question that fills them, copied as the person typed it. An identifier or a name is copied exactly, without added or removed characters. When "intent" is null, "entities" is an empty object {}.

Give every input of the chosen intent and no other key. A question that names two things for an intent with two inputs gives both. If the question does not name a value an intent needs, choose null.

Choose the intent whose meaning fits the whole question, including any period, count or number of steps the question states: a question about a period or a count only fits an intent whose line states that same period or count. Choose null for every question that none of the lines answers, and in particular for those listed at the end.

## Intents

- `claimants-at-the-same-address` (inputs: claimant): Lists the claimants who live at the same address as the named claimant.
- `claimants-sharing-a-phone` (inputs: claimant): Lists the claimants who share a phone with the named claimant.
- `claims-on-the-same-vehicle` (inputs: claim): Lists the claims that involve the same vehicle as the named claim.
- `claims-by-the-same-repairer` (inputs: claim): Lists the other claims that the same repairer repaired as the named claim.
- `claims-filed-by-a-claimant` (inputs: claimant): Lists the claims filed by the named claimant.
- `policies-of-a-claimants-claims` (inputs: claimant): Lists the policies that the claims of the named claimant are under (2 steps: claimant to claim to policy).
- `claimants-by-name` (inputs: name): Finds the claimant or claimants with the named full name. Only for a question that names a person by name, not by identifier.

## Answer null for

- records that are duplicates of or similar to another record, such as duplicate addresses
- a ranking or a count over a set, such as which claimant has the most claims
- whether a claim or a person is fraudulent, guilty or suspicious (a judgement)
- how many things are on screen, or anything about what is currently displayed
- anything not about the graph
