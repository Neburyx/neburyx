# Insurance claims pack

A deliberately small mapping for a synthetic graph of insurance claims. It shows the same image serving an unrelated domain with no code change.

- **Source:** `insurance-demo`, flagged synthetic. It expects a graph at `bolt://demo-insurance-graph:7687`, database `neo4j`, with the user and password in the environment variables `DEMO_NEO4J_USER` and `DEMO_NEO4J_PASSWORD`.
- **Case reference:** a case is called a *Claim no.*
- **Entity types (7):** claims, policies, claimants, vehicles, repairers, addresses and phones. Claimant names and dates of birth are marked `pii`. A claim has a link to its source record.
- **Derived rule:** claimants who share a phone number, with a property that stops shared numbers from linking people.

| Preset | Template | What it asks |
|---|---|---|
| Shared addresses | `shared-attribute` | Which claimants live at the same address as this claimant |
| Claims by claimant | `linked-entities` | Which claims this claimant has filed |

Each preset gives its parameters a label ("Starting claimant").

**Demo data.** `demo.yaml` describes the synthetic demo graph of this pack, built by `tools/demo-graph`: rings of claimants that share a phone or an address, a phone on the stop list, duplicated addresses (the same street and city under different IDs) and some missing timestamps. The graph has no supernode: no record has more than 100 neighbors.

To adapt the pack to your own graph, follow [Start from a pack](../README.md#start-from-a-pack).

**Demo cases.** `cases.yaml` holds one scripted case with a known answer for the default seed: four claimants who share one phone, and the phone on the stop list that thirty claimants share. It also holds the preset investigation, which starts at one of those claimants.
