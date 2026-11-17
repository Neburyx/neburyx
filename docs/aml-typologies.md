# The AML typologies of the banking pack

The banking pack ships four typologies as built-in definitions in its mapping (`domain-packs/banking-fraud/neburyx.yaml`, the `patterns` entries with a `definition`). Each is a pattern definition in the pack's own types (see [the pattern definition](pattern-definition.md)); none holds query text, and none is a verdict: a result lists accounts that have the shape, and what it means is for the analyst to decide. They are listed in the Patterns panel under "Built-in · AML typologies" and run from there on a starting account.

They are written from public typology descriptions only, simplified to what the definition can say. A real indicator is wider than its graph shape; the shape finds candidates to look at.

| Typology | Definition (banking pack) | What a run returns | Public basis |
|---|---|---|---|
| Fan-out | one step: `TRANSFERRED_TO` out, `fan: { atLeast: 10 }` | the accounts the starting account sends to, when it sends to at least ten different accounts | Many beneficiaries receiving transfers from one company: FFIEC Appendix F (below) |
| Fan-in | one step: `TRANSFERRED_TO` in, `fan: { atLeast: 10 }` | the accounts that send to the starting account, when it receives from at least ten different accounts | The funnel account: FFIEC Appendix F and FinCEN advisory FIN-2014-A005 |
| Cycles | three steps out, the last `closesAtAnchor` | the starting account itself, when money leaves it and comes back through two others | Funds moved to another bank and back: FFIEC Appendix F (below) |
| Rapid pass-through | two steps out, the second `after: previous` and `within: { hours: 24 }` | the accounts reached by a second transfer that is not earlier than the first and not more than 24 hours after it | Funds wired on "almost immediately": FFIEC Appendix F and FinCEN advisory FIN-2014-A005 |

**Ten is a sample.** The threshold of the two fans is the pack's own number, a place to start; an operator changes it in the pack's file (the mapping refuses a number above the source's `heavy_op_threshold`). The cycle has three steps, within the default of four hops a pattern may have.

**24 hours is a sample, as ten is.** The delay of Rapid pass-through is the pack's own number, a place to start; an operator changes `within` in the pack's file (a length of 1 minute up to 8,760 hours). "Almost immediately" has no number in the public text, so the pack says a day.

## Provenance

- **Funnel account (fan-in) and little time between deposits and withdrawals (rapid pass-through):** FinCEN, *Update on U.S. Currency Restrictions in Mexico: Funnel Accounts and TBML*, advisory FIN-2014-A005, 28 May 2014, https://www.fincen.gov/resources/advisories/fincen-advisory-fin-2014-a005. It defines a funnel account as an account that receives multiple deposits in one area with the funds withdrawn elsewhere, "with little time elapsing between the deposits and withdrawals" (read in the page of 2026-11-17). The graph shape here is a simplification: the advisory is about cash deposits, geography and thresholds, which the definition does not express.
Each typology below is a simplification of a published indicator to a shape a definition can say. All the FFIEC passages are from the FFIEC BSA/AML Examination Manual, Appendix F, *Money Laundering and Terrorist Financing Red Flags*, https://bsaaml.ffiec.gov/manual/Appendices/07 (a work of the US government), read on 2026-11-17, quoted as the page shows them.

- **Fan-out.** Under "Shell Company Activity": "Unusually large number and variety of beneficiaries are receiving funds transfers from one company." Under the terrorist-financing "Funds Transfers": "A large number of incoming or outgoing funds transfers take place through a business account, and there appears to be no logical business or other economic purpose for the transfers, particularly when this activity involves higher-risk locations." The definition keeps the count of different receiving accounts and drops the rest (company, purpose, location).
- **Fan-in.** Under "Efforts to Avoid Reporting or Recordkeeping Requirement": "A customer deposits funds into several accounts, usually in amounts of less than $3,000, which are subsequently consolidated into a master account and transferred outside of the country…" Under the terrorist-financing "Other Transactions That Appear Unusual or Suspicious": "Multiple accounts are used to collect and funnel funds to a small number of foreign beneficiaries, both persons and businesses, particularly in higher-risk locations." The funnel account is also defined in FinCEN advisory FIN-2014-A005 (below). The definition keeps the count of different sending accounts and drops amounts and places.
- **Cycles.** Under "Other Unusual or Suspicious Customer Activity": "Suspicious movements of funds occur from one bank to another, and then funds are moved back to the first bank." Under "Activity Inconsistent with the Customer's Business": "Unusual transfers of funds occur among related accounts or among accounts that involve the same or related principals." The definition keeps the return to the starting account through two others, and cannot say that the accounts are related or at different banks.
- **Rapid pass-through.** Under "Funds Transfers": "Many small, incoming transfers of funds are received, or deposits are made using checks and money orders. Almost immediately, all or most of the transfers or deposits are wired to another city or country in a manner inconsistent with the customer's business or history." The definition keeps one transfer followed by another no later than 24 hours after the first, which is its reading of "almost immediately"; it drops the small amounts, the other city or country and the customer's history.

The appendix itself says: "The mere presence of a red flag is not by itself evidence of criminal activity." A run of any typology is the same kind of thing: a candidate to look at, never a finding.

## Changing them and writing your own

Edit the `definition` of an entry in the pack's `neburyx.yaml`, or add an entry to your own mapping; the mapping is checked when it loads, exactly as a saved pattern is checked (see [the mapping guide](mapping-guide.md#built-in-definitions)), and a definition the source cannot run stops the load. A source with a `max_hops` below three does not load the pack's cycles typology, and a source whose `heavy_op_threshold` is below ten does not load the two fans (a threshold the source cannot count is refused when the mapping loads).

## Not expressible yet

Each of these is written down, not faked:

- **Amounts:** structuring below a reporting threshold, or a total over a window, needs a sum or a comparison of amounts across relationships; a definition can filter on a property of one relationship but not add them.
- **Velocity against a baseline:** a count compared with the account's own history.
- **Layering through intermediaries whose type the mapping does not hold:** shell companies and the like are only expressible when the mapping has a type and relationship for them.
- **Same beneficial owner behind a cycle:** a cycle shows accounts in a loop, not that the same person controls them.
- **A cycle longer than the source's `max_hops`.**
