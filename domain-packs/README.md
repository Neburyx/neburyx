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

## An entity type whose identifier is personal data

Some records are identified by a value that is itself personal data, such as a phone number or an email address. List the identifier under `pii` as well as naming it as the `stable_id`:

```yaml
entities:
  - type: phone
    label: Phone
    stable_id: phoneNumber
    search: [phoneNumber]
    pii: [{ property: phoneNumber, class: phone }]
```

The type is then *keyed*. What changes:

- The API never puts the value in a reference. A node of a keyed type is referred to by an opaque token that only this deployment can read, so the value is not in a URL, a log line, an audit row or a saved investigation. It appears only in the node's own properties and display title, and only while masking is off.
- A token is tied to its source and entity type. A token from another source or type, or one that has been altered, is refused.
- A path carries a reference of at most 400 characters with no control character; any other reference, and any value, goes in a request body. A value may be up to 100,000 characters (UTF-16 code units), and entity type names must be well-formed Unicode.
- To find a node by its value, send the value in a request body: `POST /v1/entities/lookup` with `{ sourceId, value: { entityType, value } }`, or the `entity.value` form of `POST /v1/investigations`. While masking is on a raw value of a keyed type is refused, because naming a value to a masked view would confirm that it exists; use the token the API returned instead.
- Masked search does not search a `pii` property, so a keyed value is found by search only while masking is off.
- The token is made with a key the deployment creates on first start and keeps in its database. There is no key rotation, and a copy of the database holds the tokens and the key together, so protect it as you would the source of the values.
- Adding `pii` to the identifier of a type that investigations already use is allowed: stored investigations of the type are shown with tokens, and a generated title that held the value is shown as the type's display name.
- Taking `pii` off the identifier again keeps investigations opened in between working: they are shown with the plain ID and found again by it. The key stays in the deployment's database.
- An ID with a NUL or an unpaired surrogate, of any type, can be looked up, opened as an investigation, stored and read back exactly.
- A source link on a keyed type holds the value itself, so it is refused unless the mapping says so with `link_carries_value: true`, and it is built only while masking is off.

## A relationship type that is paged

Expanding a node reads its relationships page by page, newest first. How a relationship type is paged depends on its mapping:

- **With a `stable_id`** (and optionally `observed_at`), each relationship is an item of its own, ordered by its observed time and then by its ID. For the pages to continue without a repeat and without a gap, the `stable_id` property must be unique for the relationship type: create a uniqueness constraint on it. `test-source` reports it as advice (a finding of severity `info`, which does not change the state of the source) when a mapped relationship `stable_id` has no uniqueness constraint. Without the constraint the product still flags a repeated ID it sees inside one page or one run of pages (a relationship marked "duplicate relationship IDs in the source"), but it cannot see two relationships that share both the sort value and the ID across a page boundary, so a page may then miss one of them, and no gap-free claim is made.
- **Without a `stable_id`**, all relationships of the type between a node and one neighbor are shown as one aggregate relationship with its member count and the earliest and latest observed time; the pages are ordered by the latest observed time and then by the neighbor.
- A relationship of a type that has a `stable_id` but lacks it, or holds one that is empty or not text or a whole number, is shown as a member of the aggregate for its neighbor, marked "no stable ID".

## Search and the mapping

- Each `search`, `reference` and `evidence` property needs its own online index. A property without one is left out of search and named with the reason; the entity type's other properties are still searched.
- A node whose `stable_id` property is missing or holds a value that is not a usable ID is still found by search: it is listed and marked "No usable stable ID", and cannot be opened or added until it holds one.
- The `evidence` properties of a relationship type without a `stable_id` are searched too. A hit shows the relationships between the two ends as one aggregate, each member by its element ID as text.
- Two entity types may share a label: a node that a search matches as both types is a hit of each, and a node is opened and previewed as the type asked for.

## Rules for a pack

- Names that belong to a domain (entity types, labels, relationship types, property keys) live in the pack and only there. Code and tests read them from the pack.
- Use synthetic hosts such as `example.test` in link templates. A link template takes one placeholder, the identifier of the record, and never one marked `pii`, unless the type is keyed and the mapping says the link carries the value (see below).
- One source per pack file.
