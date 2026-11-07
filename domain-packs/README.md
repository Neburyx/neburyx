# Domain packs

A domain pack is a directory of plain YAML and Markdown that describes one kind of graph to Neburyx. It holds no code: the same image serves every pack, and adding a pack changes nothing in `services/api`, `apps/web` or `packages/contracts`.

| Pack | Domain |
|---|---|
| [`banking-fraud`](banking-fraud/README.md) | Accounts, customers, devices, IP addresses, transactions and merchants |
| [`insurance-claims`](insurance-claims/README.md) | A deliberately small mapping: claims, policies, claimants, vehicles, repairers, addresses and phones |

## What is in a pack directory

| File | Purpose |
|---|---|
| `neburyx.yaml` | A complete mapping file for **one source**: connection address, credentials by reference, entity and relationship types, display settings, derived rules and pattern presets. Run it as it is with `NEBURYX_CONFIG`. |
| `README.md` | The pack in plain words: what it maps, its presets, and the address and variables it expects. |
| `demo.yaml` | Only for a pack that has a demo: the definition of its synthetic demo data, built into a graph by `tools/demo-graph`. |
| `cases.yaml` | Only for a pack that has a demo: its scripted demo cases, each with a known answer for the default seed, and the preset investigation that "Open demo case" opens (a starting entity and a case reference). Tests check the answers against the loaded demo graph. |

Every pack here describes a **synthetic** graph (`synthetic: true`). The address in each file is a host name on the demo network, and the credentials are the names of environment variables, never values.

## The demo case

A source flagged `synthetic: true` may name a `demo_case`: the entity the product opens first, and the case reference that investigation carries. The product offers it as **Open demo case** on its first page and as **Open the demo case** on Home.

```yaml
sources:
  - id: banking-demo
    synthetic: true
    demo_case:
      entity: { type: account, id: AC-0002000 }
      case_ref: "REF-DEMO-1001"
```

- `entity.type` is one of the source's entity types, `entity.id` is the stable ID of an entity of that type, and `case_ref` is the case reference. A type or an ID may hold up to 200 characters and a case reference up to 100, and none holds a control character or an unpaired surrogate (a `\uD800`-style escape).
- A source without `synthetic: true` cannot have one, and the mapping is refused.
- A pack states its preset once, in `cases.yaml`; the pack's own `neburyx.yaml` holds no `demo_case`. `pnpm demo-graph combine` copies the preset into the combined mapping that the demo environment and `pnpm dev` use. A mapping without `demo_case`, such as a pack's own `neburyx.yaml` run as it is, shows no demo case, and the product offers no action for it.
- To offer one from a mapping you write yourself, add the key to a synthetic source as above.

## Start from a pack

1. Copy `neburyx.yaml` to a new file.
2. Change the `id`, the `uri`, the `database` and the two credential variable names to match your graph, and remove `synthetic: true` (the flag shows the *Synthetic data* badge and belongs only to a graph made of synthetic data).
3. Change the entity types, relationship types and property names to match your graph. Only `type`, `label` and `stable_id` are required for an entity type; everything else has a default. `label` is the label the nodes carry in your graph and is what the product reads with. To show an entity type under another name, give it a display name: `display: { name: IP address }`. The display name is what the canvas, the legend and the menus show; without one the label is shown, exactly as written.
4. Point `NEBURYX_CONFIG` at the file and start the server. A mistake is reported with its place in the file and never repeats an address, a credential or a link.

A command that checks a mapping against a running graph (`neburyx test-source`) is planned; this page will describe it when it exists.

## Rules for a pack

- Names that belong to a domain (entity types, labels, relationship types, property keys) live in the pack and only there. Code and tests read them from the pack.
- Use synthetic hosts such as `example.test` in link templates. A link template takes one placeholder, the identifier of the record, and never one marked `pii`.
- One source per pack file.
