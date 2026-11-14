# Banking fraud pack

A mapping for a synthetic graph of bank accounts and the things that connect them. It is the first pack and shows most of what a mapping can say.

- **Source:** `banking-demo`, flagged synthetic. It expects a graph at `bolt://demo-banking-graph:7687`, database `neo4j`, with the user and password in the environment variables `DEMO_NEO4J_USER` and `DEMO_NEO4J_PASSWORD`.
- **Case reference:** a case is called a *Referral*.
- **Entity types (6):** accounts, customers, devices, IP addresses, transactions and merchants. Holder names, dates of birth and phone numbers are marked `pii`.
- **Relationships:** account activity on a device or an address is stored with an event identifier, a time and a source record (with a link template); customer-to-account, account-to-account and merchant links are aggregate types.
- **Derived rules:** accounts that share a device, and accounts that share an address, each with a property that stops shared devices and networks from linking people.

| Preset | Template | What it asks |
|---|---|---|
| Shared devices | `shared-attribute` | Which accounts use the same device as this account |
| Shared addresses | `shared-attribute` | Which accounts connect from the same address as this account |
| Connected accounts | `linked-entities` | Which accounts this account has transferred to |

Each preset gives its parameters a label ("Starting account"). To adapt the pack to your own graph, follow [Start from a pack](../README.md#start-from-a-pack).

**Demo data.** `demo.yaml` describes the synthetic demo graph of this pack: customers, accounts, devices, addresses, transactions and merchants, with three supernodes (of 1,000, 10,000 and 100,000 neighbors), rings of accounts that share a device and an address, devices on the stop list, and some missing timestamps. `tools/demo-graph` builds it into a demo database; see its README. The dates of the data are relative to the day the graph is built (the definition states the `reference_date` its ranges were written for; `--build-date` sets the day, and the default is today in UTC), so a question about the last days finds data: the devices of every ring were last seen in the five days before the build day, and the first ring account initiated ten transactions in the twenty days before it. The answers about the last 7, 30 and 90 days hold for a few days after a start; a restart builds the graph again for the new day, which moves the window.

**Demo cases.** `cases.yaml` holds four scripted cases with known answers for the default seed: a ring of six accounts on one device and one address, a device on the stop list with 1,000 accounts, an address on the stop list with 10,000 accounts, and a merchant with 100,000 payments. It also holds the preset investigation, which starts at one of the ring's accounts.

## Ask

The `ask/` folder holds what Ask knows about this pack's source: `classification.md` (the text the model reads, with [the reply form](../../docs/ai-preview.md#the-reply-form)) and `intents.json` (one intent for each demo question, as a built-in template with its values fixed, and one query that finds a person by full name). Copy it as it is to `config/ask/banking-demo/` of an install (the folder is named by the source id; see [the AI preview](../../docs/ai-preview.md#the-ask-folder)). `questions.yaml` lists the demo questions as a person types them, each with the intent and the entities Ask should find, or `refuse`. The JSON is data, not code.
