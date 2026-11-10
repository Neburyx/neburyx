# Mapping guide

A **mapping** tells Neburyx what your Neo4j graph means: which labels are entity types, which relationship types connect them, which property identifies each record, and which properties may be searched, filtered, shown or masked. This guide takes you from an empty file to a mapping that passes `test-source`.

Every YAML example in this guide is a complete mapping file, and a test loads each one with the product's own loader, so the examples stay true.

## What a mapping is

- A mapping is one YAML file. It holds a list of **sources**. A source is one Neo4j database. A [domain pack](../domain-packs/README.md) holds one source per file; investigations never combine sources.
- Neburyx reads **only the properties the mapping names**. The mapping is also the projection list: a property that is not mapped is never read and never shown.
- The file holds names, not queries. It has no query text and never will: Neburyx asks the database only through fixed, parameterized templates.
- The path of the file is given by the environment variable `NEBURYX_CONFIG`. The credentials are named by environment variable (`auth`), never written in the file.
- Give Neburyx a login that can only read. `test-source` (below) checks it.

## A minimal mapping

Only an entity type's `type`, `label` and `stable_id` are required. Everything else has a default.

```yaml
sources:
  - id: my-graph
    uri: "neo4j+s://graph.example.test:7687"
    database: neo4j
    auth: { kind: basic, username_env: GRAPH_USER, password_env: GRAPH_PASSWORD }
    entities:
      - type: customer
        label: Customer
        stable_id: customerId
```

- `type` is the name Neburyx uses for the entity type; `label` is the label the nodes carry in your graph.
- `stable_id` is the property that identifies a record, and it must be unique (see [the mapping checks](#the-mapping-checks)).
- `uri` has the scheme `neo4j`, `neo4j+s`, `neo4j+ssc`, `bolt`, `bolt+s` or `bolt+ssc`, a host, and no credentials in it.
- `id` is the name you give the source. Letters, digits, dots, underscores and hyphens; at most 64 characters.

A mapping may name a relationship type between two entity types:

```yaml
sources:
  - id: my-graph
    uri: "neo4j+s://graph.example.test:7687"
    database: neo4j
    auth: { kind: basic, username_env: GRAPH_USER, password_env: GRAPH_PASSWORD }
    entities:
      - type: customer
        label: Customer
        stable_id: customerId
      - type: account
        label: Account
        stable_id: accountId
    relationships:
      - type: HOLDS_ACCOUNT
        from: customer
        to: account
```

## What YAML is accepted

A mapping file is a strict subset of YAML 1.2: block or flow mappings, sequences and scalars; plain, single-quoted and double-quoted strings; and comments. The product refuses everything else, with the line and column and never the value: any `%YAML` directive other than 1.2, any `%TAG` directive, explicit tags of any kind (`!!str` included), anchors, aliases, merge keys, keys that are not plain text, block scalars (`|` and `>`), more than one document, duplicate keys, and any parser error or warning.

An anchor, for example, is refused:

```yaml invalid
sources:
  - id: my-graph
    uri: "neo4j+s://graph.example.test:7687"
    database: neo4j
    auth: { kind: basic, username_env: GRAPH_USER, password_env: GRAPH_PASSWORD }
    entities:
      - type: customer
        label: Customer
        stable_id: customerId
    style_rules: [&anchor 1]
```

The message, as the product prints it:

<!-- message: anchor -->
```text
(line 10, column 27): uses an anchor, which a mapping does not allow
```

A message names the problem and, when the loader has them, its path in the file and the identifiers involved, followed by the line and column in brackets: `<path> (<context>) (line N, column M): <reason>`. A refusal by the YAML rules has only the position. A message never repeats a `uri`, `auth` or `link` value. At most ten problems are listed, then "and N more".

## The keys

Each table lists every key the product accepts at that level. "Required" means the file is refused without it. The depth for a few keys is in the [domain packs page](../domain-packs/README.md).

### The file

<!-- keys: file -->
| Key | Required | What it does |
|---|---|---|
| `sources` | yes | The list of sources. The product reads every source in the file |

### A source

<!-- keys: source -->
| Key | Required | What it does |
|---|---|---|
| `id` | yes | The source's name. Not a word the API uses as the first part of its own paths |
| `uri` | yes | Where the database is, with a Neo4j or Bolt scheme and no credentials |
| `database` | yes | The database name on that server |
| `auth` | yes | The environment variables that hold the login |
| `synthetic` | no | `true` marks a graph made of synthetic data and shows the *Synthetic data* badge |
| `demo_case` | no | The entity and case reference the product opens first; only on a synthetic source. See [the demo case](../domain-packs/README.md#the-demo-case) |
| `budgets` | no | Limits that may only be lowered, see [the budgets](#the-budgets) |
| `vocabulary` | no | What this domain calls the case reference |
| `entities` | yes | The entity types, at least one |
| `relationships` | no | The relationship types between entity types |
| `derived` | no | Relationships Neburyx computes along a path of mapped types; always shown as derived |
| `patterns` | no | Presets: a built-in template bound to your types, with labels |
| `style_rules` | no | Kept as written and hashed; plain data only |

<!-- keys: auth -->
| Key | Required | What it does |
|---|---|---|
| `kind` | yes | Only `basic` |
| `username_env` | yes | The name of the environment variable that holds the user name |
| `password_env` | yes | The name of the environment variable that holds the password |

<!-- keys: vocabulary -->
| Key | Required | What it does |
|---|---|---|
| `case_ref` | no | What the case reference is called in this domain |

<!-- keys: demo_case -->
| Key | Required | What it does |
|---|---|---|
| `entity` | yes | The entity the demo case opens on |
| `case_ref` | yes | The case reference the investigation carries |

<!-- keys: demo_case.entity -->
| Key | Required | What it does |
|---|---|---|
| `type` | yes | One of the source's entity types |
| `id` | yes | The stable ID of an entity of that type |

### An entity type

<!-- keys: entity -->
| Key | Required | What it does |
|---|---|---|
| `type` | yes | The name Neburyx uses for the type |
| `label` | yes | The label the nodes carry in your graph |
| `stable_id` | yes | The property that identifies a record; must be unique. It may be a `pii` field: the type is then *keyed*, see [keyed identifiers](../domain-packs/README.md#an-entity-type-whose-identifier-is-personal-data) |
| `title` | no | A title built from properties, such as `"Account {accountId}"`. Without one, the title is the stable ID. A title built from a `pii` field is masked with it |
| `search` | no | Properties that search reads. Each needs an index |
| `reference` | no | Indexed values that appear on other records; used only to list related records |
| `pii` | no | Critical fields: maskable on demand. A bare name, or `{ property, class }`; see [keyed identifiers](../domain-packs/README.md#an-entity-type-whose-identifier-is-personal-data) |
| `filterable` | no | Properties the client may filter loaded items by |
| `sortable` | no | Properties a page may be ranked by |
| `link` | no | An `https` template that opens the record in your own system; see [links](../domain-packs/README.md#links-to-a-source-record) |
| `link_carries_value` | no | `true` allows a link on a keyed type to carry the value itself |
| `display` | no | How the type looks |
| `degree` | no | A property you keep yourself that holds a node's relationship count, used above the cap; see [degree counts](../domain-packs/README.md#degree-counts-you-maintain-yourself) |

<!-- keys: display -->
| Key | Required | What it does |
|---|---|---|
| `name` | no | The name shown on the canvas, in the legend and in menus; without one, the label is shown exactly as written |
| `icon` | no | One of the product's fixed icons |
| `key_properties` | no | The properties shown first; without them, the stable ID, then the `search` and `filterable` properties in listed order, without `pii` properties, at most three |
| `state_property` | no | The property that gives the "Type · state" line on a node |

<!-- keys: pii -->
| Key | Required | What it does |
|---|---|---|
| `property` | yes | The property that holds personal data |
| `class` | no | Picks the shape of the mask: `name`, `email`, `phone`, `date` or `text`. A field with no class, or a class that does not fit, gets the full mask |

<!-- keys: degree -->
| Key | Required | What it does |
|---|---|---|
| `type` | yes | A relationship type this entity has in the mapping |
| `direction` | yes | `out` or `in` |
| `property` | yes | The node property that holds the count for that pair |
| `observed_at` | no | A node property that holds when the count was computed |

### A relationship type

<!-- keys: relationship -->
| Key | Required | What it does |
|---|---|---|
| `type` | yes | The relationship type in your graph |
| `from` | yes | The entity type at the start |
| `to` | yes | The entity type at the end |
| `stable_id` | no | Recommended: with it each relationship is an item of its own and pages continue without a repeat; without it the type is shown as aggregate relationships. See [a paged relationship type](../domain-packs/README.md#a-relationship-type-that-is-paged) |
| `observed_at` | no | The temporal property used to order and filter |
| `evidence` | no | Properties that refer to source records. Each needs an index |
| `filterable` | no | Properties the client may filter loaded relationships by |
| `sortable` | no | Properties a page may be ranked by |
| `evidence_link` | no | An `https` template for opening an evidence record in your own system; see [links](../domain-packs/README.md#links-to-a-source-record) |

### Derived relationships and presets

<!-- keys: derived -->
| Key | Required | What it does |
|---|---|---|
| `id` | yes | The name of the rule |
| `from` | yes | The entity type at the start |
| `to` | yes | The entity type at the end |
| `via` | yes | The path that links them: an odd number of entries, at least three, alternating relationship type and entity type |
| `rule_version` | yes | A whole number from 1; raise it when the rule changes |
| `stop_list_property` | no | A property that marks values to ignore, such as a device shared by many |

<!-- keys: pattern -->
| Key | Required | What it does |
|---|---|---|
| `id` | yes | The name of the preset |
| `name` | yes | The name shown to the person |
| `template` | yes | A built-in template: `shared-attribute` or `linked-entities` |
| `bind` | yes | Binds the template to your types: `anchor`, `attribute` and `via` for `shared-attribute`; `anchor`, `target` and `via` for `linked-entities` |
| `labels` | no | The labels of the preset's inputs |

### The budgets

A mapping may only lower a product limit, never raise it. `default_page` is 10 to 50 and not above `max_page`; when `max_page` is below 25 and `default_page` is omitted, the default page is `max_page`.

<!-- budgets -->
| Key | Minimum | Ceiling | Default | What it limits |
|---|---|---|---|---|
| `timeout_ms` | 1 | 10000 | 5000 | How long one read may run |
| `max_page` | 1 | 50 | 50 | The largest page a read may return |
| `default_page` | 10 | 50 | 25 | The page size when none is asked for |
| `max_hops` | 1 | 4 | 4 | The longest path a path read may take; no read in this release uses it |
| `path_results_cap` | 1 | 25 | 25 | The most results a path read returns; no read in this release uses it |
| `user_concurrency` | 1 | 8 | 2 | Reads one person may have running on the source |
| `source_concurrency` | 1 | 256 | 32 | Reads running on the source at once |
| `queue_wait_ms` | 1 | 5000 | 2000 | How long a read waits for a slot before the answer is `SOURCE_BUSY` |
| `breaker_failures` | 1 | 100 | 5 | Timed-out reads in the window that open the circuit breaker, see [the circuit breaker](circuit-breaker.md) |
| `breaker_window_ms` | 1000 | 600000 | 60000 | The window those timeouts are counted in |
| `breaker_cooldown_ms` | 1000 | 600000 | 30000 | How long the breaker stays open |
| `heavy_op_threshold` | 1 | no ceiling | 500 | The number of relationships above which a node counts as heavy: its count stops there and is reported as a lower bound, and an expansion estimated above it is warned about before it is sent (the warning never refuses) |
| `requests_per_minute` | 1 | no ceiling | 120 | Requests one person may make on the source in any 60 seconds, see [concurrency](concurrency.md) |

## Defaults

Only `type`, `label` and `stable_id` are required for an entity type, so a minimal mapping is usable on day one: a generic icon, the stable ID as the title, the first mapped properties as key properties, no style rules. The mapping is the projection list: a property that is not mapped is never read or shown.

## Checking a mapping

`test-source` checks one configured source. It needs the database of the application (`DATABASE_URL`, after `neburyx migrate` and one start of the API), the mapping (`NEBURYX_CONFIG`) and the variables that the mapping's `auth` names:

```bash
DATABASE_URL=… NEBURYX_CONFIG=… GRAPH_USER=… GRAPH_PASSWORD=… neburyx test-source --name my-graph
```

`--write-probe` also tries to create one node in a transaction that is always rolled back, to confirm the login cannot write. Use it only in a test environment, never against a source you cannot afford to touch.

It exits `0` for pass and warn; `1` for fail and for any configuration, mapping, database or run error; and `2` for a usage error or a source name that is not configured.

A mapping the product refuses when it starts, or when `test-source` loads it, prints the message described above: the problem, its place in the file and the identifiers involved, never a `uri`, `auth` or `link` value.

### The report

<!-- report-lines -->
| Line | Printed when |
|---|---|
| `Source` | always |
| `Outcome` | always: `pass`, `warn` or `fail` |
| `State` | always |
| `Reason` | the state has one |
| `Server` | always |
| `Version supported` | always |
| `Operations` | always |
| `Mapping` | always |
| `Keyed references` | an entity type has a personal-data stable ID |
| `Read-only` | always |
| `Login can write` | always |
| `Mapping checks` | always |
| `Checked at` | always |
| `Degree counts` | always |
| `Write probe` | with `--write-probe` |

`Mapping checks` is followed by one line for each finding, indented, with its severity and message.

### Read-only

`Read-only` says how the check came about. **Privileges inspected** means the server listed the login's privileges and none lets it write. **Write probe** means the opt-in probe was used. **Not verified** means neither could be done, and `Login can write` then says `unknown`. Not verified is stated honestly: it is not a pass. A Neo4j Community server cannot list privileges, so on a Community demo server the report says `Read-only: not verified` and `Login can write: unknown`.

A login that can write makes the outcome `warn`, never `fail`.

### The reason

When `Reason` is printed, it is one of these. Each says what to do.

<!-- reasons -->
| Reason | What to do |
|---|---|
| The source could not be reached. | Check the `uri`, the network and that the server is running |
| The source refused the sign-in. | Check the user name and password in the variables the mapping names |
| The credentials named in the mapping are not set. | Set the variables `username_env` and `password_env` name |
| The database named in the mapping does not exist on the server. | Check `database` |
| The source refused the read. | Give the login the right to read |
| The source did not answer in time. | Try again; if it repeats, check the load on the server |
| The server version is not on the support matrix. | Use a supported Neo4j version (Neo4j 5.26 LTS or a 2026 release) |
| The server listed privileges that could not be read, so read-only is not verified. | Read-only stays unverified; check the login by hand |
| The login can write to the source; give Neburyx a login that can only read. | Give Neburyx a read-only login |

When the mapping does not fit the source, the reason takes one of three forms, depending on the findings. The reasons above come first: a login that can write, an unsupported version and privileges that could not be read take precedence over the two warning forms, and `(and <n> more)` is printed only when more than one check fails.

<!-- reasons: mapping -->
| Form | When |
|---|---|
| `The mapping does not fit the source: <message> (and <n> more). Fix the source, then run test-source or test it from the Sources page.` | a finding fails |
| `The mapping could not be fully checked: <message>` | something was not verified |
| `The mapping has warnings: <message>` | a finding warns |

### The degree counts

For each entity type that is the start or the end of a relationship type, `test-source` asks whether the server can count a node's relationships cheaply, and prints `cheap`, `not cheap` or `could not tell` for it, and the server it was found on. A degree count adds warnings and never changes the outcome or the state.

## The mapping checks

`test-source` reads the database's schema, one read after another through the same gate as every other read, and compares it with the mapping. It never creates anything: when a check asks for an index or a constraint, you or your database owner creates it, using the database's own documentation on [indexes](https://neo4j.com/docs/cypher-manual/current/indexes/) and [constraints](https://neo4j.com/docs/cypher-manual/current/constraints/).

A **fail** stops the start of a source the API can reach and shows the source as unavailable with the reason; a **warn** does not. **info** is advice.

<!-- checks -->
| Check | Severity | What it means, and what to change |
|---|---|---|
| `label` | fail | No node carries the entity type's label. Fix `label`, or the graph |
| `relationship-type` | fail | No relationship of the type exists. Fix `type`, or the graph |
| `search-index` | fail | A `search` property has no index. Create a single-property RANGE or TEXT index on that label and property |
| `reference-index` | fail | A `reference` property has no index. Create a single-property RANGE or TEXT index on that label and property |
| `evidence-index` | fail | An `evidence` property has no index. Create a single-property RANGE or TEXT index on that relationship type and property |
| `index-failed` | fail | An index exists but cannot be used. Rebuild it |
| `stable-id-unindexed` | fail | An entity's `stable_id` has neither a uniqueness constraint nor a RANGE index. Create a uniqueness constraint |
| `stable-id-unique` | fail | The `stable_id` holds a value on more than one node. Make the values unique, then create a uniqueness constraint |
| `sort-index` | warn | A relationship's `observed_at` has no index. Create a single-property RANGE or TEXT index on that relationship type and property |
| `index-building` | warn | An index is still being built. Wait and run the check again |
| `stable-id-unenforced` | warn | The `stable_id` has a RANGE index but no constraint. No duplicate was found; create a uniqueness constraint so it stays unique |
| `rel-stable-id-unindexed` | warn | A relationship's `stable_id` has no index. Create an index on that relationship type and property |
| `rel-stable-id-unconstrained` | info | A relationship's `stable_id` has no uniqueness constraint. Advice: create one for paging without a repeat or a gap |
| `schema-refused` | warn | The login may not list the schema. The checks were not verified |
| `schema-unreadable` | warn | The answer about the schema could not be read. The checks were not verified |
| `stable-id-unverified` | warn | The duplicate scan did not finish in time. The `stable_id` was not verified |

The messages, with the names in quotes written as placeholders. `<kind>` is `search`, `reference` or `stable id` for an entity type, and `evidence` or `sort` for a relationship type:

<!-- messages -->
| Check | Message |
|---|---|
| `label` | `Entity type "<entity type>" (label "<label>"): no node carries the label` |
| `relationship-type` | `Relationship type "<relationship type>" from "<from>" to "<to>": no relationship of the type exists` |
| `search-index` | `Entity type "<entity type>" (label "<label>"): no index on the search property "<property>"` |
| `reference-index` | `Entity type "<entity type>" (label "<label>"): no index on the reference property "<property>"` |
| `evidence-index` | `Relationship type "<relationship type>" from "<from>" to "<to>": no index on the evidence property "<property>"` |
| `sort-index` | `Relationship type "<relationship type>" from "<from>" to "<to>": no index on the sort property "<property>"` |
| `index-building` | `Entity type "<entity type>" (label "<label>"): the index on the <kind> property "<property>" is still being built` |
| `index-building` | `Relationship type "<relationship type>" from "<from>" to "<to>": the index on the <kind> property "<property>" is still being built` |
| `index-failed` | `Entity type "<entity type>" (label "<label>"): the index on the <kind> property "<property>" cannot be used` |
| `index-failed` | `Relationship type "<relationship type>" from "<from>" to "<to>": the index on the <kind> property "<property>" cannot be used` |
| `stable-id-unindexed` | `Entity type "<entity type>" (label "<label>"): the stable id property "<property>" needs a uniqueness constraint or a RANGE index` |
| `stable-id-unique` | `Entity type "<entity type>" (label "<label>"): <n> values occur more than once in the stable id property "<property>"` |
| `stable-id-unique` | `Entity type "<entity type>" (label "<label>"): 1 value occurs more than once in the stable id property "<property>"` |
| `stable-id-unenforced` | `Entity type "<entity type>" (label "<label>"): no constraint enforces that the stable id property "<property>" is unique; no duplicate was found` |
| `stable-id-unverified` | `Entity type "<entity type>" (label "<label>"): the stable id property "<property>" could not be checked for duplicates in time` |
| `rel-stable-id-unindexed` | `Relationship type "<relationship type>" from "<from>" to "<to>": no index on the stable id property "<property>"` |
| `rel-stable-id-unconstrained` | `Relationship type "<relationship type>" from "<from>" to "<to>": advice: a uniqueness constraint on the stable id property "<property>" is needed for paging without a repeat or a gap` |
| `schema-refused` | `The index checks were not verified because the login may not list indexes (grant SHOW INDEX and SHOW CONSTRAINT); a search on this source may scan.` |
| `schema-refused` | `The label and relationship type checks were not verified because the login may not list them.` |
| `schema-refused` | `The stable id checks were not verified because the login may not read the nodes.` |
| `schema-unreadable` | `The answer of the source about its <labels and relationship types, indexes or stable ids> could not be read, so that part of the mapping was not verified.` |

A check that could not finish never passes: when the schema read was refused or could not be read, or the duplicate scan timed out, the result is **not verified** (`schema-refused`, `schema-unreadable` and `stable-id-unverified`), and the report's `Mapping checks` line says `not verified`, unless a check also fails, in which case it says `fail`.

A `search` property without an online index is left out of search and named with the reason; the entity type's other properties are still searched.

## A worked example

This builds a mapping of the synthetic banking demo graph, which the demo environment loads (see [`deploy/demo`](../deploy/demo/README.md)). The shipped [`banking-fraud` pack](../domain-packs/banking-fraud/neburyx.yaml) is the complete mapping to copy from; the steps below build a part of it.

**Step 1: one entity type.**

```yaml
sources:
  - id: banking-demo
    uri: "bolt://demo-banking-graph:7687"
    database: neo4j
    auth: { kind: basic, username_env: DEMO_NEO4J_USER, password_env: DEMO_NEO4J_PASSWORD }
    synthetic: true
    entities:
      - type: account
        label: Account
        stable_id: accountId
```

**Step 2: more types and the relationships between them.**

```yaml
sources:
  - id: banking-demo
    uri: "bolt://demo-banking-graph:7687"
    database: neo4j
    auth: { kind: basic, username_env: DEMO_NEO4J_USER, password_env: DEMO_NEO4J_PASSWORD }
    synthetic: true
    entities:
      - type: account
        label: Account
        stable_id: accountId
      - type: customer
        label: Customer
        stable_id: customerId
      - type: device
        label: Device
        stable_id: fingerprint
    relationships:
      - type: HOLDS_ACCOUNT
        from: customer
        to: account
      - type: USES_DEVICE
        from: account
        to: device
        stable_id: eventId
        observed_at: lastSeen
        evidence: [sourceRecordId]
```

**Step 3: search, display and personal data.**

```yaml
sources:
  - id: banking-demo
    uri: "bolt://demo-banking-graph:7687"
    database: neo4j
    auth: { kind: basic, username_env: DEMO_NEO4J_USER, password_env: DEMO_NEO4J_PASSWORD }
    synthetic: true
    entities:
      - type: account
        label: Account
        stable_id: accountId
        title: "Account {accountId}"
        search: [accountId, holderName]
        pii: [{ property: holderName, class: name }, { property: phone, class: phone }]
        filterable: [status, accountKind]
        display: { icon: money, key_properties: [accountKind, status, openedOn], state_property: status }
      - type: customer
        label: Customer
        stable_id: customerId
        title: "{fullName}"
        search: [customerId, fullName]
        pii: [{ property: fullName, class: name }, { property: dateOfBirth, class: date }]
        display: { icon: person, key_properties: [customerId, segment] }
      - type: device
        label: Device
        stable_id: fingerprint
        search: [fingerprint]
        filterable: [platform]
        display: { icon: terminal, key_properties: [platform, firstSeen] }
    relationships:
      - type: HOLDS_ACCOUNT
        from: customer
        to: account
      - type: USES_DEVICE
        from: account
        to: device
        stable_id: eventId
        observed_at: lastSeen
        evidence: [sourceRecordId]
        filterable: [channel]
```

Run on the demo graph, the check passes with no finding. On a Neo4j Community server it prints `Read-only: not verified`, as explained above. If a label is wrong, say `Acount` for `Account`, the check fails and says so:

```text
  fail: Entity type "account" (label "Acount"): no node carries the label
```

The two shipped packs, [`banking-fraud`](../domain-packs/banking-fraud/neburyx.yaml) and [`insurance-claims`](../domain-packs/insurance-claims/neburyx.yaml), are each a working mapping you can copy: its README explains [how to start from a pack](../domain-packs/README.md#start-from-a-pack). A pack holds no code, and the same image serves every pack.

## Saved investigations when a mapping changes

A saved investigation is tied to its source, not to a mapping version, so editing the mapping does not break saved work. When an investigation is opened and the mapping has changed since it was saved, a banner says so and each change is handled:

- An entity or relationship type that is no longer mapped shows as “No longer mapped”.
- A saved filter on a property that is no longer mapped, or no longer filterable, is dropped and listed in the banner. A filter on a field that is now a `pii` field is dropped too and listed as "now a sensitive field".
- A field newly marked `pii` is masked under the current setting, never the setting at the time of saving. The banner names the field only when a saved filter on it was dropped, because the previous mapping is not kept; otherwise it says “Some fields are newly sensitive and are shown masked.”

The next autosave records the current mapping. A source ID that is pointed at a different database is a different case, handled by the operator; see the install guide.

## Where to go next

- [Domain packs](../domain-packs/README.md): two working mappings, and the depth on keyed identifiers, links, paging and degree counts.
- [Run it locally](run-locally.md): run the app against your own Neo4j.
