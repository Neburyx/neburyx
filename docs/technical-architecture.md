# Neburyx — Technical Architecture & Engineering Specification

| | |
|---|---|
| **Version** | 1.1-draft (supersedes 0.9) |
| **Date** | 2026-10-30 (1.1: TypeScript backend, Postgres in both editions, Valkey for Enterprise, single-tenant, domain packs) |
| **Status** | Design for implementation; parts are built, and §13 records measured behaviour. |

**Phasing.** Sections describe the target design. Where something isn't in Community v0.1, it's
tagged **[W2]** (the second wave) or **[Later]**.

**C** = Community, **E** = Enterprise.

---

## 1. Scope, invariants and decisions

**Invariants.** Every design choice must keep these true:

1. **Neburyx never owns or mutates the customer graph.** All source access is read-only.
2. **One investigation, one source.** No implicit federation.
3. **Every source read goes through one gate:** policy → template → budget → execute → normalize →
   redact → audit. Search, expand, path, Ask and export all use it. There is no side door.
4. **No arbitrary query text reaches Neo4j.** Not from the browser, and not from the LLM.
5. **Never fetch a full neighborhood.** Supernodes are paged and faceted, and every count is
   labelled exact, estimated, lower bound or unknown. A number is never invented (§6, §8).
6. **Boring to operate.** One image, config-driven, no customer-specific code.

**Architecture decisions**

| ADR | Decision | Reason / trade-off |
|---|---|---|
| ADR-01 | **Modular monolith**; jobs run in-process (C) or as a `worker` process from the same image (E). Process roles from one image: `api`, `worker`, optionally `ask`. Split a module into its own service only for different scaling, security isolation or release cadence, with evidence. **Language and framework (decided 2026-10-30): TypeScript on Node 24 LTS; Fastify, Zod schemas (which generate the OpenAPI), Kysely with plain SQL migrations, the official `neo4j-driver`, graphile-worker for jobs.** The Ask evaluation harness may stay a separate Python tool, because it only calls the API. | Minimal operational surface; modules can be split later. One language across the web app, the API, the contracts and the tools. Fastify over NestJS: the gate is the architecture, so the framework stays thin |
| ADR-02 | React + TypeScript + Vite client; renderer **Cytoscape.js** (decided 2026-11-03 after a spike on the demo supernode case; frame-rate target: steady median ≥ 55 fps and 5th percentile ≥ 30 fps at 300 elements, adding 25 nodes with no frame over 100 ms, all at 4× CPU throttle on the recorded laptop). Compound nodes, grouping and edge styling are built in; both candidates are MIT. Keep the renderer behind a thin `GraphCanvas` component so the choice is cheap to reverse; an incremental layout fixes every node already placed and places only the new ones. | Clear canvas state; both renderers are OSS-licensed |
| ADR-03 | Neo4j 5.x first, behind a narrow `GraphSourceAdapter` | Avoids premature multi-engine work |
| ADR-04 | **One OCI image, Postgres in both editions** (revised 2026-10-30; SQLite dropped). Community = the image + a Postgres container (compose file) + local disk; Enterprise = the image + the customer's managed Postgres + S3-compatible object store **[Later]** + Valkey (ADR-12). | One artifact and one SQL dialect to build, test and support. The Postgres job queue and progress notifications (`LISTEN/NOTIFY`) work the same in both editions. Cost: Community installs with `docker compose up` instead of a single `docker run` |
| ADR-05 | Read-only, **allowlisted, parameterized Cypher templates** only | Protects source availability, permissions and correctness |
| ADR-06 | REST for commands. v0.1 runs interactive calls synchronously, with a server timeout and client abort. A durable job table with SSE progress comes later, for long paths and exports **[Later]**. | Simple first; jobs stay auditable once added |
| ADR-07 | **Ask is template-bound**: the LLM picks a template and its parameters, and never writes Cypher. This includes the conversational assistant (§9.6), which only routes to answer-from-view, a confirmed plan, or a refusal | Safety, auditability and citations by construction |
| ADR-08 | LLM provider is pluggable and customer-chosen; no data goes to a model unless the policy allows it | Regulated buyers must control where data goes |
| ADR-09 | Open core in one repo and one image: Community and the `ee/` directory are both under Apache-2.0. The public image compiles `ee/` in; its code path is off unless both `NEBURYX_PROFILE=enterprise` and `ai.preview: true` in `neburyx.yaml` are set. These switches are safety rails, not a lock. | One repo, one CI, solo-maintainable |
| ADR-10 | Schema mapping is **declarative YAML**, a strict YAML 1.2 subset (see §5), validated at startup and by `test-source` | Onboarding without code |
| ADR-11 | **AI output is a reviewable draft**: placeholders in, structural citation check and numeric check on the way out, a built-in versioned prompt (the operator may override it, §9.4) with no tools, never auto-saved or exported. The summarizer reuses the `AskPlanner` seam and Ask's model settings. | Gen-AI value without a black box or a data leak |
| ADR-12 | **Valkey in the Enterprise profile, for coordination only** (2026-10-30). It holds concurrency leases, rate-limit counters, circuit-breaker state, login challenges and sign-in throttles, all with expiries. It **never holds customer data**, query results or PII, and nothing in it needs a backup. Community keeps the same state in process memory. The result cache stays per process in both editions (§3). | Several API copies must share per-user and per-source read limits (§14). Holding a Postgres connection for up to 10 s per Neo4j read does not scale to hundreds of reads in flight. Valkey is the BSD-licensed Linux Foundation fork of Redis, offered as a managed service by AWS and Google Cloud; elsewhere the customer runs it with a replica and failover |
| ADR-13 | **Single-tenant**: one organization per deployment (2026-10-30). No `tenant_id`. Covers self-hosted deployments now and a dedicated instance run on a customer's behalf later. A multi-tenant SaaS is not built. | Regulated buyers keep the product next to their Neo4j; no tenancy isolation to build or test |
| ADR-14 | **Domain-neutral engine, configured in three layers** (2026-10-30). *Product* (code): screens, tools, count rules, masking, errors, the gate. *Source* (YAML, per source): types, display, key properties, presets, vocabulary, style rules (§5). *User* (UI): columns, density, layout, saved views. No entity, relationship or property name appears in code. Domain content ships as **domain packs** (§5.1). The mapping is not editable in the UI (validate-only editor Later). | Security-relevant config (pii, search, derived edges) stays under the customer's change control in git. A minimal mapping works with defaults; `neburyx init` drafts one. Domain-specific screens would be customer-specific code |
| ADR-15 | **Two Enterprise identity modes** (2026-10-30): SSO (roles and teams from identity-provider groups) or user-based (local accounts with Argon2id passwords and mandatory TOTP, roles and teams managed in the console). One mode per deployment; an SSO deployment keeps one audited break-glass local Administrator (§10). | Some customers have no SSO for this tool; a single mode per deployment avoids reconciling two sources of roles and teams |

## 2. Deployment

```
            ┌──────────────── neburyx image (one artifact) ────────────────┐
 Browser ──►│  Fastify app  ── serves built web assets + /v1 API + SSE      │
            │     │  gate: policy → template → budget → execute → normalize │──► Neo4j (customer, read-only, TLS)
            │     ├─ job runner: graphile-worker (in-process C | `worker` E) │
            │     └─ Ask planner ──► LLM provider (E, customer-chosen)       │
            └─────┬──────────────────────┬────────────────┬───────────────┘
                  │ PostgreSQL (C and E) │ C: /data/exports│ E: Valkey (leases, counters,
                  │                      │ E: S3-compatible│    login challenges; no customer data)
```

| Profile | Run it | State | Auth |
|---|---|---|---|
| **Community** | `docker compose up` with the published compose file: the Neburyx image + a Postgres container, `neburyx.yaml` mounted | Postgres (container volume) + local files | None. The compose file publishes only on `127.0.0.1`, and Postgres is not published at all. The app can't see Docker's port mapping, so the README carries the warning; the app warns only when run outside a container with a non-loopback bind. |
| **Enterprise** | Same image, `NEBURYX_PROFILE=enterprise`; container platform or Helm chart (Later); several `api` copies behind the customer's load balancer, plus `worker` copies | The customer's managed PostgreSQL + Valkey + object store + secrets manager | SSO (OIDC; SAML through the customer's gateway) or user-based local accounts with mandatory TOTP; break-glass admin in SSO mode (ADR-15) |
| **Demo** | `docker compose up` in `deploy/demo/`: two Neo4j Community containers (one per domain pack, because Neo4j Community has one standard database per instance) + loader + Postgres + Neburyx | Synthetic graph, one domain pack per source (§5.1) | None |

Only the Neburyx image is ours. Postgres, Valkey and the object store are standard infrastructure the
customer already runs, so invariant 6 (one image) holds.

**Scaling (E) [Later].** Design target: 500–1,000 analysts per deployment (a hypothesis to measure,
not an SLO).
- `api` copies are stateless: sessions are in Postgres (`sessions`), cursors are signed, and the
  result cache is per process. Any copy can serve any request.
- Per-user and per-source read limits are shared through Valkey leases (§14, ADR-12).
- Where the customer runs a Neo4j cluster, reads use `neo4j://` routing with read access mode, so
  they go to secondaries.
- The customer's Neo4j is the expected bottleneck, not Neburyx; the source limits exist to protect it.

**Upgrades.** Change the image tag. A one-shot `neburyx migrate` process from the same
image runs the SQL migrations (Kysely's `Migrator` with a small provider that loads plain `.sql`
files, under a Postgres advisory lock) with its own migration credential; `api` and `worker` never
hold it. The Community compose file runs `migrate` as a service that must finish before `api`
starts; the Helm chart (Later) runs it as a pre-upgrade job. Migrations always run before serving,
with no manual step. A migration must be backward compatible for one minor version, so a rollback to
the previous tag works. Every release is tested by upgrading from the previous tag.

**Trust boundaries**

| Boundary | How it's secured |
|---|---|
| Browser → API | HTTPS (TLS terminated at the customer's ingress in E); session cookie with CSRF protection, or a bearer token |
| API → Neo4j | TLS; a read-only principal; driver-level transaction timeouts |
| API → Postgres / object store | Dedicated least-privilege identity; encryption per customer policy |
| API → Valkey (E) | TLS and an access-controlled user; holds no customer data, so a compromise exposes only counters and lease tokens |
| API → LLM (E) | Customer-configured endpoint; only policy-filtered, redacted context is sent (§9.4) |
| Referral system → browser | Deep links carry IDs only. Enterprise links are signed (HMAC with expiry). An ID in a URL is never treated as authorization. |

## 3. Modules

```
services/api/src/
  api/           Fastify routes, Zod request validation, error model
  gate/          the single source-access pipeline (policy, budget, audit hooks)
  sources/       GraphSourceAdapter + neo4j adapter, connection pools, health, schema drift
  mapping/       YAML schema mapping: load, validate, resolve entity types and stable IDs;
                 builds the source profile (display, presets, vocabulary) for the UI (§5)
  coordination/  concurrency leases, rate limits, circuit breaker (memory C | Valkey E)
  templates/     built-in Cypher template catalog + parameter schemas
  investigations/ investigations, saved views, notes
  exports/       plain exports (C)
  jobs/          graphile-worker tasks, job table, SSE, cancellation
  diagnostics/   /healthz, diagnostics bundle (redacted)
  db/            Kysely schema types, SQL migrations, repositories
ee/              (Enterprise scope; Apache-2.0 like Community; off unless the preview switch is set)
  auth/          OIDC, local accounts with TOTP, sessions, roles, source grants
  policy/        authorization + PII redaction applied inside gate/
  audit/         append-only audit events + minimal viewer API
  evidence/      evidence packs: manifest, checksums, object store, verify CLI
  ask/           planner, assistant router, case summarizer, LLM providers, citation checker
```

Community code never imports from `ee/`. Enterprise plugs in through interfaces defined in
Community (`PolicyProvider`, `AuditSink`, `EvidenceStore`, `AskPlanner`, which also serves the case summarizer,
and `Coordinator`, whose Community default is in-memory and whose Enterprise implementation uses Valkey),
each with a no-op or single-user default. This keeps the line between editions obvious, and keeps Community fully usable
by itself.

**The preview switch is a safety rail.** `ee/` is open source and ships in the one public image. Its code path
runs only when both `NEBURYX_PROFILE=enterprise` and `ai.preview: true` in `neburyx.yaml` are set; a start with only
one of them is refused with a clear message. With an open licence, nothing stops a person who controls the deployment
from setting both, so the switches guard against AI features reaching real data by accident, not against a determined
operator. With the switch off the AI paths are unknown routes (404) and nothing is audited; the AI route group also
refuses a call (`ACCESS_DENIED`, reason `ai-preview-off`) and audits the refusal if a loaded extension is ever told the
preview is not on. The AI route group works on any source (accepted 2026-11-12); what protects real data is the request data rules
(§9.4) and the audit of every model call.

**Client state is kept in four partitions:**

| Partition | Holds |
|---|---|
| Server state | Query results. Cached by (source, principal, policy version, filter hash, params). |
| Investigation state | Element refs, source, expansion history, filters, notes, view version |
| Presentation state | Positions, selection, pins, hidden/grouped items, panel sizes, viewport |
| Job state | Operation ID, phase, cancel-requested flag, result cursor (fed by SSE) |

## 4. Persistence

PostgreSQL in both editions (ADR-04), with plain SQL migrations run by Kysely's migrator. The full
column lists, JSON document shapes, lifecycle rules and sizing are in the schema and its migrations.
This section is the summary.

| Group | Tables | Ed. |
|---|---|---|
| Identity and access | `deployment` (one row: edition and the identity mode fixed at first start), `users` (Community seeds one `local` row), `user_preferences` · `sessions`, `source_grants`, `teams`, `team_members`, `local_credentials`, `user_invites` (user-based mode and break-glass) | C · E |
| Sources | `sources` (seeded from the YAML; secrets by reference only), `source_checks` (one row per `test-source`, replaces `source_capabilities`) · `source_limits` (versioned rows, so the change history is kept) | C · E |
| Work product | `investigations` (bound to one source; `open`, `closed`, `archived`; soft delete), `saved_views` (one autosaved `draft` per user plus `named` snapshots, per investigation), `exports` · `investigation_shares` | C · E |
| Patterns | `saved_patterns` [W2] · `pattern_shares` [Later] | C · E |
| Jobs | graphile-worker's own schema (maintenance tasks from v0.1) and `jobs` (user-visible operations, §13) [Later] | C |
| Assistant and Ask | `assistant_threads`, `assistant_turns`, `ask_plans`, `ask_runs` [W2] | E |
| Governance | `settings` (versioned rows) [Later], `audit_events` (append-only, no raw PII) [W2, a plain table; monthly partitions Later], `audit_seals` (chained, anchored tamper evidence) [Later] | E |
| Later | `evidence_packs`, `template_defs`, `alert_rules`, `alert_runs`, `channel_checks` | E |

No table stores property values from the customer graph. What is stored: element refs, counts,
filter and template-parameter values the user chose, timestamps inside placeholder-form AI text, and text the user typed. There is no `tenant_id` (ADR-13).

**Identifiers.** A canonical element ref is `{sourceId, entityType, stableId}`. `stableId` comes
from the property configured in the mapping. Relationships should also have a configured
`stable_id`; without one, see the pagination caveat in §8.2. Neo4j only guarantees `elementId()`
within a single transaction, so it's used only inside one query and never stored as a key.
Cross-source refs are rejected.

## 5. Schema mapping

`neburyx.yaml`, validated at startup and by `neburyx test-source <id>`:

```yaml
sources:
  - id: fraud-demo
    uri: neo4j+s://neo4j.internal:7687
    database: neo4j
    auth: { kind: basic, username_env: NEO4J_USER, password_env: NEO4J_PASSWORD }
    synthetic: true                   # shows the Synthetic data badge
    budgets: { timeout_ms: 5000, max_page: 50, default_page: 25, max_hops: 4,
               path_results_cap: 25, user_concurrency: 2, source_concurrency: 32,
               queue_wait_ms: 2000, heavy_op_threshold: 500 }
    vocabulary: { case_ref: "Referral" } # what the case reference is called in this domain

    entities:
      - type: claim
        label: Claim
        stable_id: claimId            # must be unique; checked against a constraint or index
        title: "Claim {claimId}"
        search: [claimId]             # indexed properties only; checked at startup
        display:                      # optional; defaults apply when omitted (§5.2)
          icon: document              # from the product's fixed icon set
          key_properties: [status, amount, filedAt]
          state_property: status      # the "Type · state" line on the node
        filterable: [status, amount]  # properties the client may filter loaded items by
      - type: account
        label: Account
        stable_id: accountId
        search: [accountId, holderName]
        pii: [holderName, dob, phone] # critical fields: maskable on demand (C); masked by role policy unless the role allows (E)
      - type: customer
        label: Customer
        stable_id: customerId
        title: "{fullName}"           # a title built from a pii field is masked with it
        pii: [fullName, { property: dob, class: date }]   # a bare name is a pii field with no class; the object form adds one: name, email, phone, date or text (§10.1)
        reference: [authId]           # indexed values that appear on other records; used only to list related records (§8.3)
        link: "https://cases.example.test/customers/{customerId}"   # optional "Open source record" target; ID only (§8.3)
      - type: device
        label: Device
        stable_id: fingerprint

    relationships:
      - type: USES_DEVICE
        from: account
        to: device
        stable_id: eventId            # recommended; without it the type is shown as aggregate edges (§8.2)
        observed_at: lastSeen         # temporal property for filters and sorting
        evidence: [sourceRecordId]    # properties that reference source records
        filterable: [channel]
        evidence_link: "https://auth.example.test/events/{sourceRecordId}"   # optional; without it the record ID is plain text

    derived:                          # edges computed by Neburyx; always labelled "derived"
      - id: shared-device
        from: account
        to: account
        via: [USES_DEVICE, device, USES_DEVICE]
        rule_version: 1
        stop_list_property: isShared  # e.g. ignore NAT/shared devices

    style_rules: []                   # kept as written and hashed; the format is decided with style rules

    patterns:                         # presets: a built-in template bound to mapped types, with labels
      - id: shared-devices
        name: "Shared devices"
        template: shared-attribute
        bind: { anchor: account, attribute: device, via: USES_DEVICE }
        labels: { anchor: "Starting account", limit: "Max matching accounts" }
```

**Accepted YAML (decided 2026-11-01).** `neburyx.yaml` is a strict subset of YAML 1.2:
block or flow mappings, sequences and scalars; plain, single-quoted and double-quoted strings; and
comments. Everything else is refused at startup and by `test-source`, with the line and column and
never the value: any `%YAML` directive other than 1.2, any `%TAG` directive, explicit tags of any kind
(`!!str` included), anchors, aliases, merge keys, keys that are not plain text, block scalars (`|` and
`>`), more than one document, duplicate keys, and any parser error or warning. The loader is an
allowlist: a node type it does not list fails, it is never skipped.

The file's path comes from `NEBURYX_CONFIG`; unset, the server starts with no sources. The `budgets`
block may only lower the product ceilings (§10), `default_page` is 10 to 50 and not above `max_page`
(when `max_page` is below 25 and `default_page` is omitted, the default page is `max_page`), and
`path_results_cap` defaults to its ceiling of 25. An omitted entity `title` is the stable ID, and omitted
`key_properties` are the stable ID, then the `search` and `filterable` properties in listed order,
without `pii` properties, at most three. A `stable_id` may be a `pii` field: the type is then *keyed* (§10.1, "Keyed references"). A preset binds
`anchor`, `attribute` and `via` for `shared-attribute`, and `anchor`, `target` and `via` for
`linked-entities`. A load failure message names the problem, its path in the file and the
identifiers involved; it never repeats a `uri`, `auth` or `link` value.

`test-source` checks connectivity and read-only access. Read-only is checked by **inspecting
privileges** (`SHOW USER PRIVILEGES` where the server allows it), never by writing to the
customer graph. If privileges can't be inspected, the report says "read-only not verified". The
report carries `loginCanWrite` (true, false, or null exactly when the check is not verified); a
login that can write makes the outcome `warn`, never `fail`. An
optional `--write-probe` flag exists for test environments only: it runs inside an explicit
transaction that is always rolled back, and it is off by default. The verdict is conservative: a
privilege the function does not know, or a write right on a graph name that may be an alias of the
source's database, gives "not verified" and never a guess. It also checks that labels and
relationship types exist, uniqueness of `stable_id`, indexes on `search` and sort properties and
on `reference` (node) and `evidence` (relationship) properties, `link` and `evidence_link`
templates (§8.3),
supported server version, and degree-probe behavior (§8.1). The checks, one read each through the gate and one after another: the mapped labels and relationship types exist; a RANGE or TEXT single-property index covers each `search`, `reference` and `evidence` property (a missing `observed_at` index is a warning); an entity `stable_id` has a uniqueness constraint, or a RANGE index and a streamed duplicate scan that proves it unique; a relationship `stable_id` has an index. A failure makes the report outcome `fail` and the state `unavailable`, stops the start for a source the API can reach, and shows a source that was down at the start as `unavailable` with the reason after its first-contact check; a finding refuses no read by itself (the index findings act through the index guard, §8.3). The degree-probe check follows: for each entity type that is the `from` or the `to` of a relationship row, one `degree-probe` read per (entity type, relationship type) pair (§8.1), whose result and the server version it was found on are in the report as `degreeChecks`; it adds warnings and never changes the outcome or the state. A check takes at most seven gate deadlines (capabilities 1, privileges 1, mapping stage 3, degree stage 2), the write probe one more. It prints a pass/warn/fail report, which
is also stored in `source_checks`.

### 5.1 Domain packs and the no-domain-words rule (ADR-14)

- **No domain words in code.** No entity type, relationship type or property name appears in
  `services/api`, `apps/web` or `packages/contracts`. A CI check fails the build if an identifier
  taken from the shipped packs' mappings (entity types, labels, relationship types, property keys)
  appears in those directories as a string literal. Plain English words such as "account" in UI
  copy ("account settings") are not flagged; domain-specific copy belongs in a pack's vocabulary.
- **A domain pack** is a directory of YAML: the mapping, display settings, pattern presets, style
  rules, vocabulary, and a seeded demo dataset for `tools/demo-graph`. It contains no code.
- **Two packs ship with v0.1**: `banking-fraud` (accounts, customers,
  devices, IP addresses, transactions, merchants) and a deliberately small `insurance-claims`
  (claims, policies, claimants, vehicles, repairers, addresses, phones; one scripted case, no
  supernode). The demo compose file loads one source per pack.
- **Release check:** both packs run on the same image with zero code changes (§17).
- **Built-in templates are graph shapes, not domain concepts.** `shared-attribute` and
  `linked-entities` (§7) take mapped types as parameters. A pack's presets give them names and
  labels ("Shared devices", "Starting account").

### 5.2 Defaults and the source profile

Only `type`, `label` and `stable_id` are required for an entity type. Everything else has a
default: a generic icon, the stable ID as the title, the first mapped properties as key properties,
no style rules. A minimal mapping is therefore usable on day one.

The mapping is also the **projection list**: Cypher returns only mapped properties, never whole
nodes, which keeps responses small. A property that is not mapped is never shown.

`GET /v1/sources/{id}/profile` returns the validated display model for the UI: entity and
relationship types, icons, titles, key properties, filterable and sortable properties, `pii` flags,
the `properties` list of each type (every property the mapping names for it, the same list a record
is projected to, built by the same function; names only) and, for a relationship type, the property
that holds its stable ID (none for an aggregate type), pattern presets, style rules (id, label, condition text, effect), vocabulary and a redacted mapping
excerpt. It never contains secrets or the URI. The response carries the source's `config_hash` as its
ETag, so the client fetches it once per session and again only after a config change.

### 5.3 Onboarding tools

- **[W2]** `neburyx init --source <id>` reads the Neo4j schema (labels, relationship types, property keys,
  indexes, constraints) through a read-only session and writes a draft mapping with `TODO` markers.
  It never reads property values. A platform engineer then fills in stable IDs, `pii` and search fields.
- `neburyx test-source` validates the result (above).
- **[W2] Dev mode** (`NEBURYX_DEV=1`) reloads the YAML on save, so the engineer sees each change in the
  UI at once. In production a config change is a reload or restart.

Saved views survive config changes. A source ID re-pointed at a different database is detected
and its investigations open read-only until an operator confirms with `neburyx source rebind`.

## 6. Adapter contract and normalized model

```ts
interface GraphSourceAdapter {
  capabilities(src): Capabilities                      // ops supported, index report, version
  searchEntities(ctx, q: SearchInput): SearchPage
  getEntity(ctx, ref: EntityRef): NodeDetail
  getRelationship(ctx, ref: EdgeRef): EdgeDetail
  previewExpansion(ctx, req: PreviewInput): FacetPreview   // degree probe; never full adjacency
  expandNeighbors(ctx, req: ExpansionRequest): GraphPage
  findBoundedPaths(ctx, req: PathRequest): PathPage
  runTemplate(ctx, templateId, version, params): GraphPage // used by built-ins and Ask
  cancel(ctx, operationId): CancelResult
}
```

The interface describes product operations, not a query language. Unsupported operations are
declared in `capabilities`, never faked.

```ts
Node = {
  ref: { sourceId, entityType, stableId, technicalId? },
  display: { title, type, badges?: string[] },
  properties: { key, value, dataClass, masked, observedAt? }[],   // dataClass: the kind of the value (text, number, boolean, date, ...); the Redact stage replaces it with the mapping class for pii fields (§10.1)
  qualityFlags: string[], provenanceRefs: string[],
  authorization: { canInspect, canExport }          // always true in Community
}
Edge = {
  ref: { sourceId, type, from, to, stableId }                 // a stored relationship with a stable_id: the relationship type and the entity types of its two ends, because a stable ID is unique per relationship type and per mapping row, not across types
     | { sourceId, aggregate: { type, from, to } }            // all of one type from → to, no stable_id (§8.2)
     | { sourceId, derived: { ruleId, from, to } },           // a derived edge (decided 2026-11-02)
  memberCount?: Count,                                        // aggregates only
  from: EntityRef, to: EntityRef, type, direction,
  semantics: "stored" | "derived" | "unknown",
  observedFirst?, observedLast?,                              // aggregates: earliest and latest observed time of the members, each as the member's own value with no zone added (§8.2)
  derivation?: { ruleId, ruleVersion, supportingEdgeRefs: EdgeRef[] },
  properties: [], evidenceRefs: string[], observedAt?, validFrom?, validTo?, qualityFlags: []
}
Count = { value?: number, quality: "exact" | "estimated" | "lowerBound" | "unknown", scope: string }
// lowerBound: "at least value", e.g. a capped probe that overflowed (LIMIT cap + 1 returned cap + 1)
GraphPage = {
  sourceId, operationId, nodes: Node[], edges: Edge[],
  counts: { returned: number, matchingTotal: Count, hiddenInView?: Count },
  nextCursor: string | null, partial: boolean, warnings: string[],
  budget: { rowLimit, timeoutMs }, sourceAsOf?: string
}
```

**Count rules.**
- `matchingTotal` and `hiddenInView` are meaningful only within the same filter scope.
- Never subtract an estimate as if it were exact; the result of mixing them is `estimated` at best.
- When there is no value, `quality` is `unknown` and `value` is omitted.
- `lowerBound` renders as "≥ value" or "value+". Never show it as an exact total.

**Normalization.** Rows reach the normalizer as plain values; the Normalization suite (§17) runs on records captured from the demo containers through the real adapter, committed under `tools/demo-graph/fixtures/normalization/` and recaptured by a container test on both supported images. A `Node` property carries the kind of its value in `dataClass` (the Redact stage replaces it with the mapping class for `pii` fields, §10.1); a tagged scalar is shown as its text. An edge's `direction` is `from-to` until a template that expands from an anchor adds `out` and `in`.

## 7. Query templates and the safety gate

All source reads are **templates**: versioned, parameterized Cypher with a JSON-schema for the
parameters. Built-in catalog for the first release:

| Template | Purpose | Key params | Ed. |
|---|---|---|---|
| `search` | Prefix or exact search on configured properties; also lists, separately, records that reference the ID through properties the mapping marks `reference` | type, text, limit | C |
| `entity` | One entity + properties + evidence | ref | C |
| `degree-preview` | Per-type degree / facet counts | ref, direction | C |
| `expand` | Paged one-hop by type, direction, time window, sort; one page per neighbor type | ref, relTypes, neighborTypes, window, sort, limit, cursor per type | C |
| `shortest-paths` | Bounded shortest paths | from, to, relTypes, maxHops ≤ budget, limit | C |
| `shared-attribute` | Entities of the anchor's type that share an attribute node (for example a device, address or phone) with the anchor, with stop-list | ref, attributeType, via, window, minShared, limit | C |
| `linked-entities` | Entities of a chosen type linked to the anchor through shared attributes, with stop-list (was `connected-accounts`) | ref, targetType, via, maxHops ≤ 2, window, limit | C |
| `derived-rule-run` | The other ends of one derived rule of the mapping from the anchor, each with the first chain of nodes and relationships that supports it; at most the cap (25, or a lower `max_page`) and one more to learn of a cut | ref, ruleId, limit | C |
| `derived-edge-support` | The chains of one derived rule between the two ends of a derived edge, one for each distinct tuple of middle entities, each with the first path that supports it; at most the cap (25, or a lower `max_page`) and one more to learn of a cut; the statement is written by the gate from the rule's chain with both ends fixed | ruleId, two entity references, limit | C |

The built-in patterns in the UI are **presets** from the domain pack (§5.1) over these templates. In the `banking-fraud` pack, Shared devices and Shared addresses use `shared-attribute` (attribute device or address), and Connected accounts uses `linked-entities` with target type `account`. Suspicious transaction chains is not in the MVP. Customer-authored templates are Later. When they arrive, they go through an admin approval
and signing flow (E).

### 7.1 Gate pipeline

1. **Resolve context:** principal, source, policy version (E). Community uses `local`.
2. **Validate:** the template exists and is enabled for this source, parameters match the schema,
   label/type allowlists come from the mapping, and limits are ≤ budgets.
3. **Authorize before executing (E):** the source grant, then label/property/relationship policy.
4. **Execute** in an explicit read transaction (`session.beginTransaction({ timeout })` on a
   session opened with `defaultAccessMode: READ`), **not** a managed `executeRead` function. Managed functions retry on transient
   errors and can double the cost of a timed-out budgeted query. Also apply a row limit
   (`LIMIT $limit + 1` to detect overflow), a trace ID and the request deadline, plus a per-source
   pool and concurrency quota. The server-side transaction timeout is the main cancellation
   mechanism (§13).
5. **Normalize**: the adapter hands the gate **plain values** (a 64-bit integer beyond the safe range, a temporal value, a point, a node, a relationship and a path are tagged, JSON-safe objects; nothing is rounded, and no driver object reaches the gate), and the template's `normalize(rows, plan, context)` gets a context with the source of the request, whether the page was cut and the source's model. `normalizeRows` maps the records to `Node`/`Edge` via the mapping: identity is the entity type of a label and the stable ID, under the request's `sourceId`; a record the mapping does not describe, or that has no usable stable ID, is left out and counted by reason (`not-mapped`, `ambiguous-type`, `no-stable-id`) with one fixed sentence in the page's `warnings` (a search lists a `no-stable-id` record as an unreferenced hit instead, and resolves a record of several mapped labels as the type it asked for, §8.3); only mapped properties are shown (§5.2); a stored relationship with a `stable_id` is an edge, the rest are aggregate edges with a member count (`exact` for a whole answer, `lowerBound` for a cut page, counted once by element ID); a derived edge is built only from a rule of the mapping and supports that follow it. De-duplicate, and build the signed
   cursor.
6. **Redact**: mask PII per role (E) and, when the request asks for it (`GateRequest.mask`, never for the system runner), the `pii` fields (C, §10.1): the properties of the nodes of a normalized result become `{ value: <mask>, dataClass: <the mapping class>, masked: true, maskedBy: 'request' }`, and a title built from a `pii` field is rebuilt with the masks. Drop derived edges unless both their ends and every supporting edge are in the result (with or without the flag); each one dropped is dropped without a word (no count, no warning, no `dropped` key, nothing a hidden element would reveal; a policy that hides an element is one cause of it, and the policy layer keeps it so; a server that needs the number keeps it in its audit, never in the answer). While masking is asked, a request whose template uses a `pii` property to search, filter or sort (`usedProperties`) is `INVALID_REQUEST`.
7. **Audit (E)** and emit metrics. No raw sensitive values in logs.

**System reads go through the gate too** (decided 2026-10-30). `test-source`, `capabilities()` and the `/readyz`
connectivity ping are fixed, built-in **system templates**. They run in the same read
transaction with a timeout and return no user data.
- **The system principal** can run only these fixed system templates. It is created inside the
  server and can't be named or minted from any request.
- **`test-source`** started by a user runs as that user: it is audited (E) and recorded in
  `source_checks.triggered_by`. The startup check runs as the system principal.
- **`/readyz`** never waits on the gate's queue. It reports the cached result of a ping that a
  scheduled task runs every 30 seconds through the gate. Those pings are counted in metrics, not
  written to the audit log.
- **The one write path** is `--write-probe`. It is CLI-only and for test environments, runs in a
  write transaction that is always rolled back (§5), and is never reachable from the API.

So the architecture test (§17) has no other exceptions: any call to the adapter outside the gate
fails it.

Template parameters are always Cypher parameters. Labels and relationship types are interpolated
**only** from the validated mapping allowlist, backtick-quoted. Recent Neo4j versions (5.26+) add
dynamic labels (`$(...)`), but static allowlisted names keep plan caching and index use
predictable. User text is never interpolated.

### 7.2 Saved patterns, template authoring and alerts

**Saved patterns [W2 personal, Later shared].** A saved pattern is a row in `saved_patterns`: a
template ID, its version and typed parameters. Running one calls the same endpoint as running the
template by hand (`POST /v1/templates/{id}/run`), so the gate applies current policy and budgets. If the template was withdrawn or
its schema changed incompatibly, the pattern shows as unavailable. Team visibility (E) only changes who
can list and run it; it grants no access to data.

**Template authoring [Later].** The MVP has no builder and no config-added templates. Built-in
templates ship with the product, and a new one is a reviewed code change. A later builder form, or
config-added templates, must use the same declarative definition, and nothing more:

- A definition is declarative: entity and relationship types from the mapping, hop cap, optional time
  window, typed parameters, result cap and sort. There is **no field that accepts query text**.
- The server renders Cypher from fixed fragments, using the allowlist rules above.
- A validator rejects a definition that writes, is unbounded, uses an unmapped label, or whose
  estimated cost exceeds the budget. The estimate uses `EXPLAIN` through the gate, never a run.
- A new definition is a draft. An administrator approves it, and it is then versioned and signed.
  Withdrawing it removes it from Patterns and from the Ask registry (§9).

**Alerts [Later].** An alert rule is a saved pattern, a schedule, a condition ("returns
something new since the last run") and a channel (email or webhook).

- Runs use the scheduler in the same image (the `worker` process where the Enterprise profile has one, ADR-01): there is still one image. A run is a job
  (§13) under the rule owner's policy. If the owner loses access, the rule pauses itself.
- Runs count against query budgets. The schedule has a floor (one hour at first) and each user a rule
  cap, so alerts cannot become a load generator on the customer's graph.
- "New since last run" needs the previous result's element refs. These are stored in `alert_runs` as
  refs and counts only, with no property values.
- A notification carries a count and a signed link to the alert-run page (`/alerts/{rule}/runs/{run}`),
  which re-checks the viewer's access. The link holds no element refs, because a stable ID can itself
  identify a person. The subject line is generic and never includes the pattern name or any value, so a
  mailbox is not a PII exit.
- Nothing is written to the source graph, and a run never creates or changes an investigation.

## 8. Supernodes, pagination and search

### 8.1 Degree probe

- Never materialize a neighborhood to learn its size.
- Preferred: per-type degree via `COUNT { (n)-[:T]->() }` with no property predicate. Neo4j can often
  answer this from its relationship-group metadata for dense nodes. **Verify with `PROFILE`** on each
  supported version during `test-source` (look for a degree-based operator, not an expand), and
  record the result in `source_checks`. The check is the `degree-probe` system template: `PROFILE MATCH (n:L) WITH n LIMIT 1 RETURN COUNT { (n)-[:T]->() } AS outgoing, COUNT { (n)<-[:T]-() } AS incoming`, with the label and the relationship type written in by the gate from the mapping. The plan comes back through the executor (the operators, flattened); an operator whose name contains `Expand` gives `not-cheap`, otherwise an operator whose details contain `getDegree(` gives `cheap`, otherwise `could-not-tell` (the plan words are the server's and not a stable interface). Verified on Community 5.26.32 and 2026.10.1, where the cheap form plans as one `getDegree` projection costing the same few db hits on a node with 30,000 relationships as on one with 10, and by hand on one Enterprise 5.26.32 server (same plan and db hits; a login with only access and match may run `PROFILE`); an Enterprise 2026 server and AuraDB are not verified. If a server planned the count as an expand, PROFILE would run it over the relationships of one node inside the read transaction, bounded by the source's timeout. The report holds the result per entity type, never a count or a plan.
- If the probe needs a property filter (such as a time window), the count is not cheap. Use a
  bounded probe (`LIMIT cap + 1`) and report `exact` when under the cap, otherwise `lowerBound`
  with `value = cap`.
- **Policy-aware counts (E).** A plain degree count includes neighbors the user may not be allowed
  to see. Under label- or property-level policy, either count only permitted relationship and
  neighbor types (this can lose the cheap path), or report `unknown`. Never reveal the existence or
  number of restricted neighbors. Negative tests are required (§17).
- The mapping can point to precomputed degree properties maintained by the customer; those counts
  are reported as `estimated` with their `observedAt`.
- **Derived-neighbor counts** (decided 2026-10-30) ("Linked accounts · 1 · rule-derived") run the derivation
  rule's bounded template with `LIMIT cap + 1`, the cap being 25 (`DERIVED_NEIGHBOR_CAP`, decided 2026-11-09), or the source's `max_page` when the source lowered it below 25 (a raised `max_page` does not raise the cap; the gate keeps its one rule, `limit ≤ max_page`): `exact` when the read found no other end beyond the cap, otherwise `lowerBound` ("≥ cap · rule-derived · lower bound", "≥ 25" by default). A read that is cut returns the ends the source finds first (the statement has no order). They
  are computed only when the inspector opens. A derived neighbor counts only if the viewer can see
  both endpoints and every supporting edge (§10), so the count never reveals hidden links. If the
  gate drops hidden rows after the `LIMIT cap + 1` read and the cap was reached, the count is
  `lowerBound`, never `exact`. The same applies to every bounded count in §8.3.
- **"Not yet retrieved"** (decided 2026-10-30) (the canvas scope line, `GraphPage.coverage.notRetrieved`) is
  computed by the server. It counts **relationships**, not entities: the sum of (degree − loaded
  relationships) over the loaded nodes. It uses only degree previews already fetched (cached per
  draft and policy version) and never runs a probe just for this line. Two loaded nodes can share
  an unloaded neighbor, and an edge between two loaded nodes appears in both previews. So the total
  is `exact` only when a single loaded node contributes, and at best `estimated` otherwise. It also
  never claims better than the weakest quality of its parts. If any loaded node has no cached
  preview, the total is a `lowerBound` of the largest remainder known, and `unknown` with no number
  when that is 0. The response also says how many of the
  entities in the request it could not count (`uncounted`: no cached preview, or one with no total), so
  the header, the Export dialog and the exported file can say why a count is a lower bound. A cached
  preview is counted while it is used at least every five minutes and for at most an hour after it
  was read (hypotheses); a degree preview request is served from the cache for five minutes after the
  read, whatever its use by this count.
- **Heavy-operation estimate** (decided 2026-10-30): an expand reuses the degree preview the panel already
  shows (no extra read). A pattern or path run first does a bounded count probe in the same call.
  If the estimate is over the source's `heavy_op_threshold` (default 500), the run stops with the
  estimate and the UI offers "Refine filters" or "Continue with 25". An `unknown` estimate gives no
  warning; the page caps still apply.

### 8.2 Expansion and pagination

- **Keyset pagination only.** The order is `(sortProperty DESC, relStableId DESC)`, and the cursor
  carries the last `(sortValue, relStableId)`.
  - Cypher has no row-value comparison, so the predicate is written out:
    `r.ts < $ts OR (r.ts = $ts AND r.eventId < $id)`.
  - The tie-breaker is the **relationship's** stable ID, because several relationships can lead to
    the same neighbor. Without a configured relationship `stable_id`, relationships of that type are
    never paged or saved one by one: all relationships of one type between the same two entities
    become one **aggregate edge** `{type, from, to}` (direction is from → to), with its member count
    (a Count with quality) and first and last observed time. Paging orders aggregates by
    `(max sortValue DESC, neighbor stableId DESC, type DESC, direction DESC)`. That is the
    aggregate's full unique key, so no two aggregates tie and none is skipped or repeated. Members
    have no stable key, so they are **never referenced one by one**, and an expansion does not page
    them: the evidence panel shows a bounded sample (the first 25, or `max_page` when lower, by the row's observed time, newest first, when the mapping maps one, else the first members the source returns, labelled with the order used)
    with the member Count (exact, as the expansion counts it; see §12). The evidence search is the one read that lists members page by page
    (this reverses the earlier rule that members are "never paged or
    referenced one by one" for that read): it pages them by their element ID, which travels only inside the
    signed cursor and is never a field of a response, shown or used as a reference (§8.3: a
    member is told by its records and time, or "Member n"). `test-source` reports which relationship types have no
    `stable_id`.
  - **Nulls:** rows with a null sort value go last, in their own phase of the cursor (ordered by
    the tie-breaker only). The demo graph deliberately has missing timestamps to test this.
  - **What keyset buys, honestly:** it avoids `SKIP` and avoids sending the whole neighborhood to
    the app. It does **not** avoid the scan: Neo4j has no per-node ordered relationship index, so
    each page still expands and sorts every type-`T` relationship of the node (about 100k rows of
    work per page on the 100k demo node). Mitigations: require a time window or other selective
    filter above a degree threshold, use customer-maintained summaries where they exist, and
    measure this cost in the supernode benchmark. An external accelerator is the long-term option (§18).
- **The cursor is signed** (HMAC) and binds source, principal, policy version, filter hash, sort,
  template version and expiry. Any mismatch returns `CURSOR_INVALIDATED`. The cursor is the text `v1.<payload>.<mac>` (base64url; HMAC-SHA256 over `v1.<payload>`; the payload holds source, principal, policy version, filter hash, sort, template, template version, expiry and the position as a flat record), valid **30 minutes**; the gate verifies it in the validate stage and signs the next one in the normalize stage (a template only says where the next page starts); the filter hash is an HMAC-SHA-256, under its own key derived from the deployment's reference key (§10.1, "Keyed references"), over the canonical JSON of the validated parameters, so that a cursor of a keyed type holds no value to confirm by hashing; a cursor position that names a keyed entity holds its token, which the gate reads before it builds the keyset parameters; the key is `NEBURYX_CURSOR_KEY` (base64, at least 32 bytes), optional in Community (a key per process, with a start warning) and required, shared by all copies, in the Enterprise deployment profile; the key is never logged.
- **Search paging.** The search templates `entity-search`, `entity-related` and `relationship-evidence` are `paged` with the sort `elementId`: each branch adds `($cursor IS NULL OR elementId(n) > $cursor.after)` (`r` for evidence) and reads `ORDER BY elementId(…) LIMIT $limit + 1`, and the union does the same, because the element ID is the one order every branch of a union shares. The cursor is the signed cursor above; its position holds `{ after: <element ID of the last row shown> }` as an opaque keyset value, never a reference, and its filter hash covers the validated parameters (the text and the targets, so another text, selection or masking, or a changed index plan, gives `CURSOR_INVALIDATED`, as do another source, person, group, a changed byte and expiry). A page seeks the index and sorts the matches of the typed value only (a value is one whole stored text); a value so common that the sorted read passes the source's transaction timeout fails that page with `QUERY_TIMEOUT` (with `timeoutMs`), no row, and the previous cursor stays usable. A node found through two properties is one row and on one page. The type-ahead prefix read `entity-search-prefix` is **not paged** (a deliberate decision): each branch and the union read `WITH n LIMIT $limit + 1` with no sort and no `$cursor`, the template declares `cutMeans: 'lowerBound'`, and its count is a lower bound of the hits held when it is cut, so a common prefix never makes the source read every match.
- **By neighbor type** (decided 2026-10-30): `expand` takes `neighborTypes[]` and returns one page and one signed
  cursor per type, so "Load more" continues one type without reloading the others. Each type's
  cursor binds that single neighbor type, not the whole list. The per-type reads run **one after
  another under one read slot** (one lease), so a multi-type expand never competes with itself for
  `user_concurrency`. Each type is a separate bounded read, counted against the request timeout. The page size is the user's choice per
  request (default 25, up to the source's `max_page`), the number field in the supernode panel.
- **Defaults:** page size 25 (configurable 10–50); about 150–300 rendered objects as a soft target.
  Beyond that, the UI groups items into aggregate nodes and points the user to the table.
- **Consistency:** pages come from separate read transactions, so the source may change between
  them. The UI says so; stable ordering keeps duplicates out.

### 8.3 Search

- Only configured, indexed properties are searchable; `test-source` checks the indexes. Disabling is per property: a property with no online index is left out and named with its type and why, and the type's other properties are still searched.
- Type-ahead is debounced, with a minimum length of 2 and a bounded number of suggestions.
- If the indexes are missing, the live checks of `test-source` and of the start fail the source: the start stops with a message that names the entity type, property and check, and a source found wrong on its first contact (it was down at the start) is shown `unavailable` with that reason. **A finding no longer gates the whole source**: the gate takes no verdict, so a read of a type or property that no finding names runs; a missing label or relationship type and a `stable-id-unique` finding refuse nothing (the read answers what the source holds, and the finding stays in the report); the index findings refuse only the read that needs the named index, through the index guard below. A source never checked since the process started, or whose check could not reach the server (`unchecked`), is usable, and its reads are guarded the same way. A property whose index is not online is named as not searched (below), never degraded to a scan. One known exception, kept deliberately: a login that may not list indexes (a least-privilege custom role without SHOW INDEX and SHOW CONSTRAINT) gets "index checks not verified" and the source stays usable, so a search there may scan under the source's timeout and limits.
- **Index guard** (decided 2026-11-06). The server's index hint does not stop a scan for a missing or building index, so the gate guards instead: a template declares the indexes it needs, and before the data read of a user-scope run the gate reads the schema once (the `schema-indexes` system template, fresh at the start of each request, no cache and no timer; one request that makes several runs reads it once) and, when an index is not ONLINE, refuses the read, or for a search leaves out the property. **No read runs without its index**: a request that reaches the gate for a property whose index is not online (one written by hand, or an index that went away after the plan) is refused as `SOURCE_UNAVAILABLE` before any data statement, audit result `refused`, with the reason of the property's index: `index-unavailable` (no online index of the kind needed), `index-building` (the index is POPULATING) or `index-failed` (FAILED); of several unmet needs the refusal names the worst, in the order failed, then unavailable, then building (a gap waiting cannot cure comes first, so a refusal never says to retry what cannot change by itself). A RANGE need is met by a RANGE index or a constraint only; a TEXT index serves a need that accepts any form. The schema read is a system read, not charged as the group's one read, and is the one statement of a search that has no property left (an exception to "the executor is not called"). It is made for every principal the policy allows, whatever the source's check showed (`unchecked` and a source with findings are read guarded, never unguarded because of the verdict). Only a source that refuses to list indexes is "not verified" and runs unguarded (the kept exception above); any other failure of the schema read is an error and no data read follows: a timeout or a busy or unavailable source with its own error, and an answer that cannot be read or is truncated as `SOURCE_UNAVAILABLE` with the reason `index-list-unreadable`, not retryable (a list that is not whole cannot show that an index is missing). The window left is the moment between the schema read and the data read. The entity read has the same guard on the stable-ID index. Exact search is whole-value, case-sensitive equality with no function on the property: a RANGE index or constraint is read with `IN [$text, $textInteger]` (a canonical 64-bit integer text also matches the integer), a TEXT-only property with `= $text` (a TEXT index holds no integers).
- **Result groups** (decided 2026-10-30): *Exact ID match* searches the `search` properties. *Related records*
  is one extra bounded, indexed lookup on the properties the mapping marks `reference`.
  *Evidence records* is one extra lookup on the mapped `evidence` properties. Each group shows a page
  of 25 (or the source's `max_page` when that is lower), costs one read against the limits for each
  page, and is paged: a group whose read found more (26 rows read) holds `nextCursor`
  and its count is a `lowerBound` of the hits held; a group with no more has no cursor and an
  `exact` count. `POST /v1/search/entities/more` with `{ sourceId, text, group, cursor, mask?,
  entityTypes? }` (`group` is `exact`, `related` or `evidence`) reads only that group's next page
  through the gate, with a fresh schema read and the same masking, searched properties and index
  plan as the first page, and answers the page's hits, its count (the group's count over every page read so
  far, carried as `held` in the signed cursor; a `lowerBound` while `nextCursor` is present, `exact` on the last page), `nextCursor`, and the page's
  `dropped` and `warnings`. A cursor of another group, text, selection, source or person is
  `CURSOR_INVALIDATED`. A page whose read fails with a group code (`QUERY_TIMEOUT` with
  `timeoutMs`, `SOURCE_BUSY`, `RATE_LIMITED`, `INTERNAL_ERROR`) answers 200 with that `failure`, no
  hit and an `unknown` count, and the cursor sent stays usable for a retry; any other failure fails
  the request with its own code. The type-ahead `startsWith` group has no next page (§8.2): a
  `/more` request for it is `INVALID_REQUEST`, and the canvas Add tab offers Show more for its exact
  group only.
  **Both need an index.** `test-source` checks the `reference` (node) and `evidence` (relationship)
  indexes. A property whose index is not online is left out and named with its reason, never run as
  a scan; the group is disabled only when none of its properties is left.
- **Related records.** The related group is its own gate run of the template `entity-related`, with the statement of the exact search over the `reference` properties (one branch for each eligible property of a type, the `value` form for a RANGE index or a constraint and the `text` form for a TEXT index only, each branch and the combined result read after the cursor in element ID order and cut at `$limit + 1`, §8.2), audit action `entity.search_related`. The request names no group, type or property; the targets come from the mapping on the server, and a `pii` property is left out while the request asks for masking. The answer carries `related: { hits, count, searchable, disabledTypes, nextCursor?, unreferenced? }`; a hit is `{ node, matchedProperties }` (the node as the exact group shows it, and the `reference` properties of the record whose returned, unmasked value passes the same equality as the read, worked out in the search service after the redact stage), the count has the scope `search:related`, and the related read adds nothing to `exact` or to its count: an entity is in `exact` only through its own exact match, and one that is both is listed in both groups. The group shares the request's one schema read with the exact group. The exact group is read first, and an error that means the same for every group stops the search before another is read; then the related group and the evidence group are read together, or for a type-ahead request the `startsWith` group alone (a type-ahead request reads neither of the other two), and they settle before the answer. A group whose read fails with `QUERY_TIMEOUT`, `SOURCE_BUSY`, `RATE_LIMITED` or `INTERNAL_ERROR` while another group answered is reported in `failures` (its hits empty, its count `unknown`), and the groups that answered are returned with their true counts; a failure that means the same for every group (an unavailable or unreadable source, a bad request, the schema read) fails the whole search with that error, whichever read it came from, and so does the failure of every group that was read, with the error of the first of the exact, related and evidence groups that was read. **Relationship context.** A related hit may hold `context: { relationshipType, direction, with }` (`viaRelationship` and `viaEntityRefs[]` of the frame are replaced by it): one stored relationship between the hit and one exact match of the same answer, read from the hit's side, with `with` the exact match's reference (no value of either record is returned, so a masked title is the one the exact group shows). It is read by the template `entity-related-context` (audit action `entity.search_context`, `rows: 'bounded'`, not paged), once per search after the exact and related groups have settled, for the first page of each (at most `min(25, max_page)` of each), only when both hold a hit and the request is not a type-ahead request. The gate writes the statement from the mapping rows that join a type of the hits to a type of the exact matches: one branch for each row and direction, `out` before `in`, each binding both ends by their `stable_id` index and testing the pair with `EXISTS`, which stops at the first relationship; the chosen row for a hit is the first by branch, then by exact match. Two guards, both named: the **index guard** (the service checks the snapshot it already holds before the read, leaves out the pairs of a type whose `stable_id` index is not online and names the type in `related.context.disabledTypes`; the gate's `indexNeeds` stays as the backstop, where a refusal is a whole-search failure; with an `unverified` snapshot neither can check) and the **plan check** (C9b: the profiled plan has an index seek for each end and an expansion between two bound nodes, with no scan and no expansion from an unbound node, `related-context.neo4j.test.ts`; on another series, `related-context.container.test.ts` with `NBX_PLAN_IMAGE`). The cost of a pair is at most the smaller end's degree for that type and direction, for at most cap × cap pairs and each branch; the source's timeout bounds the read, and it never returns a neighbourhood: at most one row for each hit. A failure with a code of its own (`QUERY_TIMEOUT`, `SOURCE_BUSY`, `RATE_LIMITED`, `INTERNAL_ERROR`) is the failure group `context` of `failures` (not a result group, like `facets`): every hit stays and none holds a context; a failure that means the same for every read, and a cancel, fail the search. `POST /v1/search/entities/more` for `related` takes `exactRefs` (at most the cap, each a reference of the source, none for another group), reads the page's contexts once against them (the server does not check that they are exact matches of the search), and names a failed context read in `contextFailure` beside the kept hits, count and cursor. A hit related only to an exact match beyond the first page shows no line; the group is already a lower bound.
- **Evidence records.** The evidence group is its own gate run of the template `relationship-evidence` (audit action `entity.search_evidence`): one branch for each evidence property of each relationship mapping row, with or without a `stable_id` (a row is its relationship type and the entity types of its two ends; an evidence property with no online relationship index is left out and named in `evidence.disabledRelationshipTypes` as `{ relationshipType, from, to, property, reason }` with `index-unavailable`, `index-building` or `index-failed`, and the row's other evidence properties are searched). **Reversed rule**: this section said that "a row with an evidence property and no `stable_id` is named with `no-stable-id` and not searched, because an aggregate's members cannot be referenced one by one"; such a row is now searched like a row with one, planned and guarded the same way, and `no-stable-id` is no longer a reason of `disabledRelationshipTypes`. Each branch matches the relationship between the labels of the row's two entity types and carries an index hint (`USING RANGE INDEX SEEK` for the `value` form, `USING TEXT INDEX` for the `text` form), because on Neo4j 5.26 the planner scans a whole relationship index when the ends are labelled and not hinted; the hint does not protect a read whose index is gone, which stays the guard's work. A hit on a row with a `stable_id` is one relationship that carries the typed text in an evidence property: `{ supports, records, rules }`, where `supports` is the stored edge reference `{ sourceId, type, from, to, stableId }` (the entity types of the ends), `records` are the values of all the evidence properties of that relationship and `rules` are the configured rules of the mapping that use its relationship type in a relationship place of their `via` (configured, not proof that the relationship supports a derived relationship; the web shows each as "Rule <id> v<n> uses this relationship type"). A hit on a row with no `stable_id` is the **aggregate** `{ aggregate: { type, from, to }, members, memberCount, rules }`: the relationship type and the references of both ends, its members on this page in element ID order, each `{ elementId, records, observedAt? }`, and `memberCount`, the members listed, `exact` only on a first page with no next page and otherwise a `lowerBound` (a `/more` page cannot know earlier members). Members are paged with the group's cursor; the web adds the next page's members to the same aggregate when it is the same one. A member's element ID is shown as text only: it is never a reference, nothing is opened, copied or linked by it, and no reference is made from an element ID, because it can name another relationship once this one is deleted. An end whose labels fit two entity types is resolved as the type the row maps. **An evidence value that cannot be read is kept**: a value that is neither text nor a number is a record `{ property, unreadable: true }` (the web says "Value cannot be shown" with the property name), the hit is never dropped for it, and the count equals the hits shown; a relationship with no evidence value at all holds no record and is not listed. The count is of supporting relationships (scope `search:evidence`; a stored hit is one, an aggregate its members), paged and counted like the other groups. The group returns edges only and no property of an end; the pii masking of the exact and related groups does not apply to it. A mapping may list at most 100 evidence properties in all on relationship rows, with or without a `stable_id` (a template takes at most 100 targets), and the load refuses more with a message that names `relationships`; an evidence property name that cannot be written between backticks is refused at the start. A failure of the evidence read is reported in `failures` with the group `evidence`.
- **Facet counts** (decided 2026-10-30) (per entity type and match mode) are bounded probes (`LIMIT cap + 1`):
  `exact` up to and including the cap, otherwise `lowerBound` (decided 2026-11-05: a probe that returns exactly `cap` rows has seen every match). They are never just the returned page. All the
  facets of one search run in one read (one query with a capped count per facet), which counts
  once against the limits.
- **Facets and the selection.** The facets are their own gate run of the template `search-facets` (audit action `entity.search_facets`): one statement, one read slot, written by the gate from the plans of the groups (the same eligible targets after masking, the index guard on the request's one schema read, the relationship rows without a `stable_id` probed like the others; the selection does not touch them). A probe is a list of targets of one kind: for each entity type that has an eligible `search` or `reference` target (the entities of that type matched by either, each counted once), for each match mode that has a target (`exact` and `related` count distinct entities, `evidence` supporting relationships) and one for the total of the entities matched by any entity target. The statement is a fixed chain, for each probe `CALL { CALL { <branches joined by UNION> } WITH n LIMIT $countCap + 1 RETURN count(*) AS c<i> }` and one `RETURN c0, c1, …`, so the answer is one row of integers that the page limit cannot cut (the template declares `rows: 'one'`). **The probes count to the source's count cap**, not to the page: `$countCap` is filled by the gate from `heavy_op_threshold` (500 by default; `render.ts`, `catalog.ts`, and the catalog refuses a facet template that reads `$limit` instead), each branch and each combined result is cut at the cap plus one, and the service reads a count above the cap as "≥ cap · lower bound" and one at or below it as `exact`, so a facet says how far Show more goes. The gate refuses a count that is not a whole number from zero to the cap plus one. Beside the groups, an `exact` facet is never lower than the hits its group holds (a source that changed between reads raises it to a `lowerBound` of the hits held), a `lowerBound` facet below the hits held is shown as at least the hits held (the server for the first page, the web for the hits Show more added), and none is a sum of the others. The output of a probe is bounded by the cap; the work is not: a relationship branch whose value is carried by many relationships between other end types reads them through the seek and rejects them (known limit, as for the evidence group). A mapping that needs more than 50 probes (entity types with a target, plus the modes, plus the total) is refused at start. On a cold statement the server compiles the plan, about 42 ms for each probe (50 probes: 2.0 s on the dev server, 100: 4.2 s), then answers in 40 to 125 ms. A facet counts the matches of the source (distinct nodes or relationships, before the normalize stage); a group shows what normalization can name, so a facet can be higher than its group by the records it drops, and a node with two mapped labels is counted in each of its types (entity-type counts are never added together; the total is its own probe). The answer holds `facets: { searchable: false }` when nothing has a target, and otherwise `{ searchable: true, total, entityType[], matchMode[] }` with the scopes `search:facet:total`, `search:facet:entityType` and `search:facet:matchMode`, and `filters: { entityTypes, matchModes }`, the selection the answer was made for. The request may carry `entityTypes` and `matchModes` (each a non-empty list of different names, absent for no narrowing, refused with type-ahead, each name checked against the mapping: `INVALID_REQUEST`): `matchModes` decides which groups are read (a group not chosen is not read, makes no audit event, and is `searchable: false` with a known empty count), and `entityTypes` restricts the exact and related groups to those types and does not touch the evidence group; the facets and the total do not narrow with the selection. The first read is the exact group when chosen (it goes through the gate even with no target), otherwise the first chosen group with a target; an error that means the same for every group stops the search there; then the other chosen groups and the facet read are read together and settle before the answer. The facet read is not a result group: its failure with a code of its own is named in `failures` with the group `facets`, the answer then has `facets: { searchable: true, total: unknown, entityType: [], matchMode: [] }` and keeps every group, and it is never counted among the groups that failed; an error that means the same for every read fails the search with that error.
- **A node is resolved by the type asked for**. A node whose labels match several entity types is read as the type the read asks for: each search branch returns its target's entity type (the gate writes `@entityType` as `$branchEntityTypes[<branch position>]`, a list it fills from the validated targets in branch order, which no request or template may set), and the statement groups by node (`WITH n, collect(DISTINCT entityType) AS entityTypes ORDER BY elementId(n) LIMIT $limit + 1`), so the keyset stays on the node's element ID and a node matched as two types is one hit of each type a target of that type matched, never split across pages and not counted as dropped. The entity read and the degree preview resolve the node as the entity type in their request, so an entity type whose label another type shares is read and previewed, never `NOT_FOUND` for that reason, and the mapping check adds no finding for a shared label; a read that returned a row the normalizer left out is `INTERNAL_ERROR` tagged `unreadable-node`, audited, and `NOT_FOUND` stays for a node that is not there or a source the person may not read. A read that names no type still leaves such a node out as `ambiguous-type`, counted. The facets count it once in each type that matched.
- **Unreferenced hits**. A search hit whose stable ID property is missing, empty or not a usable ID (a fractional or non-finite float, an integer beyond the safe range, another type; a whole-number float arrives from the adapter as the integer it equals and is a referenceable hit) is not dropped: its group holds it as `{ entityType, title, properties, reason: 'no-stable-id' }` (`exactUnreferenced`, `related.unreferenced`, `startsWith.unreferenced`, and `unreferenced` on a `/more` page; present only when there is one), masked as a node is, counted in the group's count, paged in element ID order with the other hits, and `dropped['no-stable-id']` is their number. It carries no reference, no cursor of its own and no element ID, and no reference is ever made from an element ID, so it cannot be opened, added to the canvas, previewed or expanded; the web lists it as a row that is not a button, with "No usable stable ID: this item cannot be opened or added". Reading a node by element ID is not built (a follow-up for the maintainers).
- **A cut read never passes silently**. A template that is not paged declares exactly one of `rows: 'one'` (one aggregate row: the schema, capability, probe and facet reads), `cutMeans: 'duplicate'` (the entity read and the degree preview, whose second row means a second node with the stable ID) or `cutMeans: 'lowerBound'` (the type-ahead prefix read); a paged template declares none, and the catalog refuses any other declaration with a `CatalogError`. A read of a template that is not paged and declares no `cutMeans` that returns more rows than its limit is refused in the execute stage: `INTERNAL_ERROR` tagged `read-cut`, a `gate.read_cut` log line, audited as failed, nothing normalized. A declared cut is answered with `hasMore` and no cursor. Every list-returning template of the catalog is paged.
- **Reasons of `SOURCE_UNAVAILABLE`**. `details.reason` is one of a closed set, `message` is its sentence and `retryable` is its flag (`SOURCE_UNAVAILABLE_REASONS`, `SOURCE_UNAVAILABLE_ENTRIES` in `packages/contracts`; one `ErrorResponse` variant per reason): `unreachable` ("The source did not answer. Try again shortly.", retryable; the adapter's `unreachable`, `database`, `pool-full` and `closed` and an answer with no reason, such as an admission refused with no reason); `authentication` ("The source refused the login. Ask an administrator.", not retryable; `authentication` and `credentials`); `refused` ("The source does not allow this read for the login.", not retryable); `index-unavailable` ("A needed index is not there, so the read was not run.", not retryable); `index-building` ("A needed index is still building, so the read is slow. Try again later.", retryable); `index-failed` ("A needed index failed, so the read was not run.", not retryable); `index-list-unreadable` ("The source's indexes could not be listed, so the read was not run.", not retryable). The reason `unusable` no longer exists; the four index reasons are audited `refused`. The web shows the reason's sentence and offers Retry or Try again only when `retryable` is true (search, Show more, the Add tab, the expand-by-type submenu and the expansion status strip, explore, home and the sources page).
- **Policy-aware search counts (E).** Facet, related and evidence counts follow the §8.1 rule:
  they count only types and properties the viewer may see, or report `unknown`. They never reveal
  how many hidden records exist.
- **"Open source record"** (decided 2026-10-30): the mapping may set a `link` template per entity type and an
  `evidence_link` per relationship type. Without a template the ID is shown as plain text; there
  is no built-in record viewer. Rules, checked by `test-source`:
  - The scheme must be `https`, and the host is fixed in the template; no placeholder may appear
    in the scheme or host.
  - The only placeholder is the type's `stable_id` (`link`) or one of its `evidence` properties
    (`evidence_link`), never a `pii` field. The one exception is the `stable_id` of a keyed type, which is
    accepted only when the entity says `link_carries_value: true`; such a link is built only for an
    unmasked request, from the value read from the token on the server, at the audited redirect below,
    and never for a masked request.
  - The value is percent-encoded as a single path segment or query value.
  - The UI never builds the URL, and no response carries it. It opens `GET /v1/source-links/{ref}`
    for an entity, or `GET /v1/source-links/{edgeRef}?record={sourceRecordId}` for evidence; the
    evidence form is valid only for an edge with a stable ref and a record that edge carries.
    Aggregate edges have no stable ref, so their sampled members are never linked. Responses mark
    a record `linkable` instead. The endpoint re-checks the
    viewer's access to the element, audits the click (E) and answers with a redirect. The page
    opens it with `rel="noopener noreferrer"`.
  - The link opens the customer's own system and carries only the ID.
  - A template has no user-info, no whitespace, control character or backslash outside its placeholder, and at most 2,048 characters (`LINK_TEMPLATE_MAX_LENGTH`, decided 2026-11-09); the built address is parsed again and must be `https` with the template's own host, no user-info and at most 4,096 characters (`SOURCE_LINK_MAX_LENGTH`, decided the same way); a value that is only dots or has an unpaired surrogate builds no address. `{ref}` is the base64url JSON of the entity reference or the stored edge reference (as for `GET /v1/edges/{ref}`); an aggregate or derived reference is `INVALID_REQUEST`. The route answers `302` with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and an empty body; every refusal after the reference parses is one `404 NOT_FOUND`, shown as one short HTML page (the same words for every reason, the trace ID, `Cache-Control: no-store`, a Content-Security-Policy with no script; decided 2026-11-09), or as the JSON error for `Accept: application/json` without `text/html`; a request another site started (`Sec-Fetch-Site` not `same-origin` or `none`) or a prefetch is refused the same way. The audit event is action `source.link`, result `success`, `refused`, `denied` or `failed`, with `detail { target: 'entity' | 'evidence', type }` (names from the mapping, never the ID, the record or the address), written before the redirect and fail-closed. A record opens only if the evidence property the placeholder names holds it, and `linkable` says exactly that. The source profile carries `recordLink` (a flag, never the template) so the client shows an entry only for a type that has a link.
  - Known limit (2026-11-09): `https` only. A customer whose record system is plain `http:` on an internal network gets no link; there is no configuration flag for it. This may be decided later.

## 9. Governed Ask (Enterprise)

**Goal:** natural-language questions with chatbot convenience, while keeping template safety,
policy, citations and an audit trail.

### 9.1 Flow

```
question ─► local entity resolution (search; mentions → placeholders)
        ─► planner (LLM) ─► AskPlan (JSON, schema-validated) ─► preview & edit (user) ─► confirm
        ─► gate (§7.1, same as manual) ─► GraphPage
        ─► summary: deterministic per-template text [W2]  |  LLM answerer + citation check [Later]
```

```json
{
  "kind": "plan",
  "templateId": "shared-attribute",
  "templateVersion": 1,
  "params": { "ref": {"entityType": "account", "stableId": "A-1029"},
              "via": "device", "window": {"days": 90}, "limit": 25 },
  "rationale": "Accounts linked to the same device as A-1029 in the last 90 days"
}
```

If no template fits, the planner returns `{"kind": "unsupported", "reason": "..."}`.

### 9.2 Rules

1. **Planner input:** the question **after local entity resolution**, the template catalog (IDs,
   descriptions, parameter schemas) and the mapping vocabulary (entity and relationship types).
   - Names, IDs and other values the investigator types are matched locally through `search`, then
     replaced with placeholders such as `‹account#1›`. The model never sees them.
   - Ambiguous matches are resolved by the user before planning.
   - **Fail closed: the planner text is built from an allowlist.** The server never forwards the
     typed question. It rebuilds it token by token, and every token must be one of:
     - a resolved placeholder;
     - a word from the mapping vocabulary or the template catalog;
     - a number of at most 3 digits, or a date or time-window phrase;
     - a word from a fixed, versioned common-word list, with every given name and surname from
       public name lists removed.

     Any other token (an unknown word, a longer digit run, an email address, a lowercase name not
     in the list) stops the turn with a clarification that marks it, and nothing is sent. The
     analyst resolves it to an entity or rewords the question. There is **no override** that sends
     an unlisted token. The analyst always sees the exact text the model will receive.
   - **Two calls; what is sent is exactly what was previewed.** `POST /v1/ask/plan` and
     `POST /v1/assistant/turns` take `{message, resolutions[]{start, end, ref}, send}`.
     `resolutions` carries the analyst's **Pick an entity** choices.
     - With `send: false` nothing reaches the model. The server returns one of three things:
       - a `clarification` for an ambiguous match;
       - `{blocked: {tokens[]{text, start, end}}}`;
       - `{preview, previewHash}`, where `previewHash` is an HMAC over the rebuilt text, the
         resolutions, the caller's policy version and the word-list version.
     - With `send: true` the request must carry that `previewHash`. The server rebuilds the text
       again; if the new hash differs (a resolution, the analyst's access or the word list
       changed), it sends nothing and returns the new preview with `changed: true`.
     - So the model only ever receives text the analyst saw. The server never takes the text
       itself from the client, only the hash to compare against.
   - **Residual risk, stated:** a name that is also an ordinary word on the list (for example
     "Rose" or "Hunter") and that local resolution did not match passes as that word. The guarantee
     is that no token outside the list ever reaches the model; the "don't type customer names"
     hint covers the rest. PII-classified **properties** are never sent, without
     exception (§9.4).
   - By default no graph data values reach the planner.
2. **Planner output is validated** against the template's parameter schema and the budgets. Invalid
   output means one repair attempt, then `unsupported`. The LLM never produces Cypher, and there is
   no free-text query path at all.
3. **The user sees and can edit the plan before it runs.** Nothing runs without explicit
   confirmation. There is no auto-run mode; adding one would need a recorded decision.
4. **Summary.**
   - **[W2]** A deterministic, per-template summary built from the result, for example "12 accounts
     share device ‹d› [n3][n5]…". No LLM is involved, so it can't hallucinate.
   - **[Later]** An LLM answerer whose input is only the **policy-filtered, redacted** `GraphPage`
     and the placeholder question, with a short citation key on each element (`[n3]`, `[e7]`).
     The same mechanism already ships in W2 for the view-level AI case summary (§9.5).
5. **Citation check [Later].** This check is **structural**: every sentence must cite at least one
   key, and every cited key must exist in the page.
   - Sentences that fail are removed, and the answer is marked "partially supported".
   - If nothing survives, only the results are shown, with no narrative.
   - It does **not** prove that a cited element supports the claim. Groundedness is measured
     separately (§9.3).
6. **No memory across questions** beyond the current investigation's focus. No training on
   customer data. The provider is configured by the customer and can be self-hosted.
7. **Audit every run:** actor, template, parameter hash, outcome, model reference, token counts. The
   question text is stored only if the policy allows.

### 9.3 Evaluation

- Keep `services/api/tests/ask/questions.yaml`: about 30 questions to start, growing to about 50, over the demo
  graph. Each has the expected template and parameters, or `unsupported`.
- CI (nightly) reports plan accuracy and fails if accuracy drops below the last baseline.
- **[Later]** Once the LLM answerer exists, keep a human-labelled set of answers marked supported or
  unsupported per sentence. Report groundedness against it on each model or prompt change. CI can
  only enforce the structural citation check.
- Coverage gaps, meaning questions that come back `unsupported`, feed template priorities.

### 9.4 Data sent to the model

| Data | Sent by default? |
|---|---|
| The question text | Yes, after local entity resolution: typed names and IDs are replaced with placeholders |
| Template catalog + type vocabulary | Yes |
| Focus entity ref | As a placeholder only |
| Result properties | **Default none, for every model, self-hosted or not** (decided 2026-10-30). In the W2 preview the operator may list, in the YAML, which properties of which entity and relationship types may be sent (`ai.properties`); only listed properties go, and only after the gate has redacted them (the list narrows what is left, it never widens it). Later: the console setting `ai.send_property_values` joins the YAML, and the YAML can pin it off so a customer can forbid the console from turning it on |
| PII-classified properties | Never, without exception, even if the operator lists one: a list that names a `pii` property is refused at start-up with the setting named |

The preview runs on any source, not only a source flagged `synthetic: true` (decided 2026-11-12). The data rules in this table and the audit of every model call apply to every source alike.

**Operator configuration of the model (decided 2026-11-12).** In the YAML `ai` section the operator sets: `ai.provider` (in the W2 preview the only value is `anthropic`, a native client of the Messages API through the official TypeScript SDK, not through a compatibility layer; an OpenAI-compatible client, which also covers most self-hosted servers, and other providers come when a customer needs one), `ai.model` (a model ID without a date suffix; the example config shows `claude-sonnet-5-5`, with `claude-opus-5-5` as the step up) and the key by reference (an environment variable or a file with owner-only access, never inline); there is no default model, the operator chooses. The provider sets the depth control (effort) explicitly, never switches thinking off, takes token usage from the reply, treats a refusal as a refusal and not as text, and sends no tools. The operator may also point a built-in prompt, by its id, at their own prompt file (`ai.prompts`). Each built-in prompt has an id and a version; the audit records the id, the version and a SHA-256 of the text actually used. An override cannot add tools, and the model's output is still checked against the template catalog, so no free query text reaches the source whatever a prompt says (ADR-07). Operator-defined pipelines of steps, like an agent workflow, are Later.

### 9.5 AI case summary (Enterprise) [W2]

**Goal:** a reviewable, cited draft summary of the view on screen, built with the same safety
machinery as Ask. It describes a view. Ask answers a question.

```
visible element keys ─► re-read through the gate (policy applies server-side, capped at 300 elements)
        ─► de-identify: names, IDs and property values → placeholders ‹person#1›, ‹device#2›
           (kept: entity types, relationship types, derived-rule names, timestamps, counts + quality)
        ─► summarizer (LLM, through the AskPlanner seam) ─► JSON sentences, each with citation keys [n3][e7]
        ─► structural citation check + numeric check ─► re-hydrate placeholders locally
        ─► draft + server-written omissions line ─► analyst reviews, edits, regenerates or discards
```

#### Rules

1. **The server builds the input.** The client sends element keys, not content. The server re-reads
   those elements through the gate, so authorization, masking and count rules are the same as for
   any read. Over the cap, the request is refused with a message to narrow the view.
2. **De-identification.** Display names, IDs and property values become placeholders. The model sees
   structure: types, relationships, derived-rule names, timestamps and counts with their quality label.
   Property values are sent only for properties the operator lists (same rule and default as §9.4: none).
   PII-classified properties are never sent.
3. **Output contract.** The model returns `{"sentences":[{"text":"…","cites":["n3","e7"]}]}`, schema-validated,
   with one repair attempt. It has no tools, no browsing and no memory. The system prompt is fixed.
   Element values are data, never instructions.
4. **Structural citation check.** Every sentence must cite at least one key, and every key must exist
   in the input. Failing sentences are removed. If none survive, the UI shows "No summary could be
   supported by this view". As in §9.2, this does not prove a claim is true.
5. **Count honesty.** The omissions line ("10 of ~48 neighbors shown; 38 not yet retrieved") is written
   by the server, never by the model. A sentence containing a number that is absent from the input
   is dropped, and a count is never worded as exact when its quality is estimated, lower bound or unknown.
6. **No verdicts.** The prompt forbids conclusions about guilt, fraud likelihood or intent. A draft
   that contains such wording is rejected by a phrase check and regenerated once.
7. **Re-hydration is local.** Placeholders are replaced by display names on the server after the check.
   A sentence with an unknown placeholder is dropped.
8. **A draft, not a record.** The UI labels it "AI-drafted" with the model reference. It is never
   saved automatically and not kept on the server.
   - **The token.** `POST /v1/summary` returns, with the readable sentences, a `summaryToken`. It
     holds:
     - `tokenId`, the investigation, `generatedBy` and the caller's policy version;
     - a `propertyValuesSent` flag;
     - the generated sentences: in placeholder form, or, when property values were sent, the
       model's text.

     It is sealed with AES-256-GCM under a key used only for this purpose (not the cursor key),
     taken from the secrets manager and shared by every API copy. The header carries a `kid`. After
     a rotation the previous key is still accepted for 30 minutes. The token is valid 30 minutes.
     The client never holds a form it could alter.
   - **Copy to notes** posts the token to `POST /v1/investigations/{id}/draft/ai-notes`. The
     server checks the token's seal, expiry and investigation, and that the caller is
     `generatedBy` and still has the same policy version. It also re-checks that the caller still
     has the right to write their own draft:
     - they are the owner or an `edit` sharee;
     - the investigation is open and not deleted;
     - they still hold a grant on the source, and their role is not Viewer;
     - `features.summary` is still on.

     Any mismatch returns `ACCESS_DENIED` ("Generate the summary again"). A token with
     `propertyValuesSent` is refused. The server applies the storage allowlist and appends the
     sentences that pass, recording the `tokenId` with them. A second copy of the same token into
     the same draft returns `{copied: 0, alreadyCopied: true}`.
   - **Including it in an export** passes the same token in the export request. The server checks
     the seal, the expiry, the investigation, that the caller is `generatedBy`, the policy version
     and `features.summary`, plus the export right (the Export
     capability, a grant on the source and access to the investigation). It doesn't require the
     draft-write right, so a closed investigation can still be exported with its summary. A
     `propertyValuesSent` token is allowed here; the file then holds the text re-hydrated and
     masked under the exporter's policy at export time. If the analyst copies it to the view's notes, it is stored in
   **placeholder form**, counts and timestamps included, with its citation refs and label, and
   re-hydrated through the gate for each viewer when shown, with counts recomputed under that
   viewer's access. If the analyst includes it in an
   export, the export file holds the re-hydrated, masked text.
9. **Audit every generation:** actor, view hash, element count, model reference, prompt-template
   version, token counts and outcome (`ok`, `partial`, `unsupported`). The audit event never
   contains the prompt or the text.

#### Evaluation

- Keep `services/api/tests/summary/cases.yaml`: about 15 demo views, each with facts the summary must
  mention and claims it must not make.
- CI enforces the structural suites: citation check, numeric consistency, no placeholder leakage,
  prompt-injection fixtures and the no-verdict check.
- On each model or prompt change, report groundedness against a human-labelled sample (same
  method as the [Later] Ask answerer in §9.3).

#### Data sent to the model

| Data | Sent by default? |
|---|---|
| Entity types, relationship types, derived-rule names | Yes |
| Display names and IDs | No: placeholders, restored locally |
| Timestamps, counts and their quality labels | Yes |
| Property values | Only for properties the operator lists (default none for every model, §9.4); `pii` never |
| PII-classified properties | Never |

### 9.6 Investigation assistant (Enterprise) [W2]

**Goal:** the convenience of a chatbot with Ask's guarantees. The assistant is a conversational
front end on §9.1–9.5. It adds routing and follow-up resolution, and no new data path.

```
message ─► local entity resolution (search + the investigation's own entities; mentions → placeholders)
        ─► router (LLM, built-in prompt, JSON out) ─► one of three routes:
             view    ─► §9.5 summarizer over the visible elements ─► cited reply
             plan    ─► AskPlan (§9.1) ─► plan card ─► user clicks Run ─► gate ─► GraphPage
                        ─► §9.5 summarizer over the returned page ─► cited reply
             refuse  ─► fixed refusal + manual alternatives (Paths, Filters, Patterns)
```

#### Rules

1. **Three routes only.** The router returns `{"route":"view"|"plan"|"refuse", ...}`, schema-validated
   with one repair attempt. Anything else is `refuse`.
2. **One plan per turn, never auto-run.** A plan is a normal AskPlan, shown as a card with its
   template, parameters and limits. It runs only on an explicit Run click, through the same gate and
   budgets as manual expansion. There is no chain of plans and no background agent.
3. **Follow-ups resolve locally.** "The other device" or "that account" is resolved against entities
   already in the investigation, then replaced with placeholders. Ambiguity is shown to the user to
   pick from; the model never guesses an entity.
4. **Replies are cited or dropped.** Replies use the §9.5 checks: structural citation check, numeric
   check, no-verdict check, server-written omissions line, local re-hydration. A reply with no
   surviving sentence becomes "I can't support an answer from this investigation".
5. **Context window.** The router sees the placeholder thread of the current investigation (last N
   turns, capped) plus the template catalog and type vocabulary. It never sees other
   investigations, other sources or other users' threads.
6. **Retention.** The thread is stored with the investigation only if policy allows;
   otherwise it is cleared when the investigation closes. It is never used to train a model.
7. **Suggested follow-ups** are generated from the template catalog only, so each chip maps to a
   template question.
8. **Audit every turn:** actor, route, template and parameter hash (for plans), cited element count,
   model reference, prompt version, tokens and outcome. Text is stored only if policy allows.

#### Evaluation

- Add `services/api/tests/assistant/threads.yaml`: about 20 short multi-turn threads over the demo
  graph, each turn labelled with the expected route, template and parameters, or refusal.
- CI (nightly) reports route accuracy and plan accuracy against the last baseline. The §9.5
  structural suites run on every reply. Injection fixtures include messages that ask for raw
  Cypher, for other sources, or to "just run it".

## 10. Identity, authorization, PII and audit (Enterprise; masking controls in Community)

- **Identity modes (ADR-15).** Each Enterprise deployment runs in one mode, set in `neburyx.yaml`:
  - *SSO:* OIDC (validate issuer, audience, nonce and token lifetime); SAML through the customer's
    gateway. Roles and teams come from the identity provider's groups (for example AD groups).
  - *User-based:* local accounts managed in the admin console. Passwords hashed with Argon2id;
    TOTP multi-factor authentication is mandatory; users join through an admin-sent invite link
    that expires. Roles and teams are assigned in the console.
  - *Break-glass:* an SSO deployment also keeps one local Administrator account (password + TOTP)
    for when the identity provider is down. It is created with `neburyx admin break-glass create`,
    never in the console; its role is fixed at Administrator; every sign-in with it is audited and
    shown on the admin overview. It signs in at a fixed path (`/signin/local`) that the admin runbook
    documents and the normal sign-in page doesn't link to.
  - *Local sign-in rules:* the password step always runs one Argon2id check (against a dummy hash
    for an unknown, disabled or locked user), stores only the outcome in a 5-minute login challenge
    in Valkey (never the password, never a session) and always answers the same way. The TOTP step
    checks the code and the stored outcome together, re-checks that the account is still active and
    its credentials unchanged since the password step, gives one generic error for every failure,
    and uses up the challenge. Only then is a session issued. TOTP failures count toward lockout,
    and a code from an already-used time step is refused (no replay). The identity mode is stored
    at first start; the server won't start if the YAML names the other mode. In SSO mode local
    sign-in accepts only the break-glass user. It is never locked out (an attacker could otherwise
    lock it during an outage); instead attempts are throttled per client address (taken from
    `X-Forwarded-For` only through `server.trusted_proxies`; refused if it can't be determined) on top of the
    global sign-in rate limit, repeated failures raise an alert, and an optional address allowlist
    refuses everyone else before any check. It is created on an interactive terminal only, so its
    TOTP secret never reaches logs.
  - *Recovery:* single-use 72-hour links that an Administrator issues, at most one outstanding per
    user. A password-reset link needs a current TOTP code; a TOTP-reset link needs the current
    password, so one leaked reset link or one stolen factor is never enough. Issuing either revokes
    the user's sessions and clears any lockout. Invites are bearer credentials: 24-hour expiry, sent
    by a separate channel, redemption shown to the issuer. A user who lost both factors is invited
    as a new user, and moving their work is a separate, audited step. If the only Administrator is
    locked out, `neburyx admin recovery-link` on the host issues a link, and if they lost both
    factors `neburyx admin invite --role administrator` issues an invite for a new Administrator.
    A break-glass account that lost its TOTP is replaced with `neburyx admin break-glass create
    --replace`.
- **Roles:** Administrator, Investigator, Viewer, plus per-source grants, which only narrow a role.
  In SSO mode, roles come from the user's groups through a mapping in `neburyx.yaml`, refreshed at
  every sign-in; the console shows the role read-only and manages only source grants and the
  sensitive-properties grant (decided 2026-10-30). In user-based mode, an
  Administrator assigns roles in the console, and every change is audited.
- **Investigation access:** private to the owner unless shared with people or teams, `view` or
  `edit`. A share decides who can open the investigation, never what data they see: every read
  runs under the viewer's own grants and masking, and refs the viewer may not see are dropped
  without trace. **Oversight exception:** an Administrator
  may open, read-only, any investigation on a source they hold a grant for; each such open is
  audited (`investigation.open.oversight`), and the oversight list shows no counts.
  A Viewer never creates an investigation: "Open in graph" gives a Viewer an unsaved browser-only
  workspace.

  | Capability | Administrator | Investigator | Viewer |
  |---|---|---|---|
  | Explore | Yes | Yes | Yes |
  | Save | Yes | Yes | No |
  | Export | Yes | Yes | No |
  | Ask, AI case summary, assistant (E) | Yes | Yes | No (decided 2026-10-30) |
  | View sensitive properties | Yes | Explicit grant | No |
  | Manage users | Yes | No | No |
- **Source identity:** a delegated per-user identity where the customer supports it. Otherwise a
  constrained read-only service principal, with all policy enforced in `gate/` before execution and
  before the response is built.
- **Derived links:** a derived edge is revealed only if the principal can see both endpoints *and*
  every supporting edge. Seeing A and B is not enough. The redact stage also requires the entities in the middle of each chain, and the evidence route (`GET /v1/edges/{ref}` for a derived reference) answers `NOT_FOUND` when any end, middle entity or supporting edge of the chains it read is hidden. The supports read is bounded (the cap, `LIMIT cap + 1`), and the gate trims it to the cap before it normalizes, so a support past the cap is neither read nor checked and the answer says only "≥ cap · lower bound". Community has no policy that hides a row inside a mapped source, so nothing is unchecked there; **Enterprise policy must put its visibility in the statement, or read every support for a policy-bound principal, before the derived evidence route is served to it.**
- **Caches** are keyed by principal and policy version. Privileged results are never reused for a
  less-privileged session.
- **Audit:**
  - Events: login, source selection, search, expand, path, Ask, provenance inspection,
    sensitive-field access, saved view, export, evidence pack, access denied, configuration changes.
  - Fields on each event: actor, source, action, time, result, trace ID.
  - Privileged actions **fail closed** if the audit write fails.
  - Kept 365 days by default (minimum 90). Tamper evidence: chained 5-minute seals with an
    optional KMS signature, checked by `neburyx verify-audit`. Streaming to the customer's SIEM is
    **[Later]**.
- **Admin console.** A set of pages over the admin endpoints below. Settings are split by
  how often they change, so the product stays config-driven:
  - *Config files, shown read-only:* sources and their secret references, the mapping and style
    rules, the model endpoint. Changing them is a config change and a restart or reload.
  - *Database, editable in the console:* source grants and the sensitive-properties grant
    (`source_grants`), query budgets (`source_limits`), feature switches (Ask, summary, assistant)
    and retention (`settings`). All are versioned and audited, and applied through the same policy
    objects the gate reads. In SSO mode roles and teams are not edited here (they come from the
    identity provider's groups); in user-based mode users, roles and teams are managed here too (ADR-15). A setting a config file pins cannot be changed in the console.
  - *Budgets only move within ceilings.* Each limit has a product ceiling in code, optionally
    lowered by the source's config. The console may set any value up to that ceiling and the
    server rejects anything above it, so a console edit can never allow an unbounded page, hop
    count or timeout (invariant 5).

    | Limit | Product ceiling |
    |---|---|
    | Neighbors per expansion page | 50 |
    | Max hops for paths | 4 |
    | Request timeout | 10 s |
    | Path results cap | 25 |
    | Concurrent reads per user, per source | 8 (default 2) |
    | Concurrent reads per source, all users | 256 (default 32; set to what the customer's Neo4j can carry) |
    | Wait for a free read slot | 5 s (default 2 s), then `SOURCE_BUSY` |

    The `budgets` block in `neburyx.yaml` (§5) may only lower these.
  - Secrets are never returned by any endpoint. The Sources page shows state, last test, read
    identity and limits, and offers "test connection" (`test-source`, §5).

### 10.1 Masking controls [W2; policy parts come with identity and authorization]

- **Marking.** `pii:` in the mapping (§5) names the critical fields of an entity type, each as a bare property name or as `{ property, class }` where `class` is `name`, `email`, `phone`, `date` or `text` (decided 2026-11-02; the validation and the mask shapes are built with the Redact stage). Whether a field is masked depends only on its being in `pii`; the class only picks the mask shape. A field with no class, or a class that does not fit the value, gets the full mask, and a class is never guessed from the value. It is read in every
  edition. A `stable_id` may be a `pii` field (see "Keyed references" below). A `pii` field may also be in `search`
  (see "Masked fields are not oracles").
- **Keyed references (decided 2026-11-07).** An entity type whose `stable_id` is also a `pii` property is *keyed*
  (derived from the mapping, never stored: `pii` contains `stable_id`). The API never carries its value in a
  reference. The reference is a token `p1.` + base64url(IV ‖ AES-256-CTR ciphertext) of the value, where the IV is the
  first 16 bytes of an HMAC-SHA-256 over the length-prefixed version tag, source ID, entity type and value (so the
  token is deterministic, bound to its source and type, and authenticated: reading it decrypts, recomputes the IV and
  compares in constant time, and a changed, truncated, extended, re-spelled or foreign token is refused with
  `INVALID_REQUEST` and no detail). The value is carried as UTF-16 code units so any string survives. Three keys are
  derived with HKDF-SHA-256 from one 32-byte reference key, with separate labels for the token MAC, the token
  encryption and the cursor filter hash. The reference key is a column of the `deployment` row, made at first start,
  never rotated, never in a log, a response or an error. A database dump therefore holds the tokens and the key
  together: it is as sensitive as the values. The gate mints tokens when it normalizes and reads them in the validate
  stage (templates declare which parameters are references), before any parameter reaches a query. A path segment
  carries at most 400 UTF-16 code units and no control character or unpaired surrogate; a reference that cannot
  travel in a path goes in a body, where a value may have any characters. Lengths are counted in UTF-16 code units, one unit
  for the contract and the codec: a value is at most 100,000 units (the logical bound), and a reference text, which may be
  the token of such a value, at most 266,691 units. Entity types and source IDs in a mapping must be well-formed Unicode,
  so the token's binding is injective. Lookup (`POST /v1/entities/lookup`) and open (`POST /v1/investigations`) take either a
  `ref` (as the API returned it) or a `value` (a raw value to resolve); a raw value of a keyed type is accepted only
  unmasked and only in a body, so a masked view cannot be used to confirm that a value exists. Stored investigations
  of a type that becomes keyed are converted on the server when listed, read or opened, without a source read and with
  nothing written back; a generated title that held the value is shown as the type's display name until the node is
  loaded. Storage: PostgreSQL cannot hold a NUL or an unpaired surrogate in a text column or a JSON document, so an ID of any
  type that has one, or that starts with the marker `~e1:`, is stored as the marker and the base64url of its UTF-16LE
  code units, and decoded when read; a keyed type stores its token. Every stored location of an ID (the starting
  entity column and the IDs in the layout and query-context documents) goes through that encoding, and any feature that
  writes them must too. Removing `pii` from the `stable_id` of a type that investigations hold as tokens is handled
  without a conversion of what is stored: the key stays, so a stored token is read back to the ID it stands for, shown as
  that ID, and an investigation is found again by the ID. Requirement on the save feature: stored edges must carry
  typed ends (the entity type of each end), because an edge end that holds only an ID cannot be told apart when
  two entity types allowed at that end share it.
- **On demand (C) [W2].** A read or export request may carry `mask: true`. The gate masks the `pii` fields,
  in properties and in titles built from them, before the response is built. The UI switch ("Mask
  sensitive values", per session, off by default; not saved with a view) and the export button ("Mask
  critical fields", off by default) set this flag. In Community, which has no sign-in, this is a
  convenience for screen sharing and file hygiene. It is not access control and must not be described
  as security.
- **Policy floor (E).** Role policy masks first, and masking is **on by default for every role**. The
  request flag can only add fields to the masked set. A role with the sensitive-properties grant may turn
  masking off for fields it may see; that writes one `sensitive-field access` audit event per toggle,
  listing field keys (never values). A role without the grant sees the switch locked ("Locked by
  policy") and the export button already on.
- **Mask shape** (`gate/redact/mask.ts`). Fixed-width masks by data class, never the true length; the full mask is six bullets (`••••••`) and is what a date, a free text, a field with no class, a class that does not fit the value and a value that is not text get; a class is never guessed from the value. For example `Ivo Lowe` is `I••• L•••`, `jane@example.test` is `j•••@•••`, `+1-555-8945` is `+1 ••••••45` (the country code is the one to three digits after the `+` and before the first separator). A mask does not depend on how many characters it hides. The rules in general: names show an initial and
  three bullets per word; email shows an initial, three bullets and `@` with a bulleted domain; phone shows the country
  code and the last two digits; dates, free text and other fields are fully masked. The `N` in "N
  critical fields masked" counts field keys across the entity types in the view.
- **Masked fields are not oracles.** While a field is masked (by policy or by the request), it is not
  searchable, filterable, sortable or usable in style rules, so a search cannot confirm a hidden value.
  Counts and facets over it are not shown.
- **Turning it on mid-session.** The switch re-reads the view with the flag and replaces the client
  state (canvas, table, tooltips, undo history and the copy buffer). Values fetched earlier are purged.
- **Every output honors it.** The inspector and labels, the table, "Copy properties", CSV, JSON and the
  PNG (rendered from the masked view data), saved-view reopen and the AI case summary all use the
  masked values. The summary's placeholders are restored from the masked values.
- **Exports.** The export header (and an evidence pack's `manifest.json` under `policy`) records the
  outcome as `masking: off`, `masking: N critical fields masked` or the redaction profile. The cache key
  includes the mask flag, so a masked result is never served to an unmasked request.

## 11. Saved views, exports and evidence packs

Evidence packs are **[Later]**: the first Enterprise item after the [W2] items.

| | Saved view (C) | Plain export (C) | Evidence pack (E) |
|---|---|---|---|
| Purpose | Resume work | Share the current view | A defensible, reproducible package |
| Contents | Layout + query context | JSON/CSV of visible elements; PNG; optional masking of critical fields **[W2]** (§10.1) | Elements, evidence refs, query history, manifest, checksums |
| Mutability | The draft autosaves; a named view is immutable (rename and delete only) | Point-in-time file; every download re-checks current policy | Immutable; a new capture is a new pack |
| Freshness | Reloads current data, disclosing changes | As captured | As captured, plus capture window |

### 11.1 Evidence pack format

The pack is a zip:

```
manifest.json
elements.jsonl           # nodes and edges as captured, after redaction
evidence.jsonl           # evidence refs and derivation support
queries.jsonl            # template id, version, template sha256, redacted params, completedAt, partial
view.png
SHA256SUMS               # sha256 of every file above, including manifest.json
SHA256SUMS.sig           # detached signature over SHA256SUMS (Enterprise signing key)
```

- **Integrity:** the pack hash is `sha256(SHA256SUMS)`, stored in `evidence_packs.sha256` (outside
  the pack). The manifest doesn't contain that hash, so there's no circular dependency.
- **Tamper evidence:** plain checksums can be regenerated by anyone who can edit the pack. The
  detached signature, made with a key held in the customer's KMS or HSM, and the DB-stored hash
  make tampering detectable.

```jsonc
// manifest.json
{
  "packId": "...", "investigationId": "...", "sourceId": "...",
  "capturedAtUtc": "...", "captureWindow": { "from": "...", "to": "..." },
  "sourceReadContext": { "database": "neo4j", "serverVersion": "5.x", "bookmarks": ["..."] },
  "policy": { "version": 7, "principalRef": "...", "redactionProfile": "investigator" },
  "counts": { "nodes": 42, "edges": 57, "evidenceRefs": 31 },
  "completeness": { "partial": false, "unavailableEvidenceRefs": [] },
  "objects": [ { "path": "elements.jsonl", "mediaType": "application/x-ndjson", "encryptionKeyRef": "kms://..." } ],
  "retention": { "class": "customer-default", "legalHold": false },
  "generator": { "neburyxVersion": "0.2.0" }
}
```

- `neburyx verify-pack <file>` recomputes the checksums, verifies the signature, and validates the
  manifest.
- **Re-runnable, not identical.** `queries.jsonl` stores the template version and hash plus the
  redacted parameters, so each query can be re-run. Current results may legitimately differ from the
  captured ones, and the UI shows the difference.
- Policy is **re-checked before every download or share**, not just at capture time.
- A single read transaction can't span a whole capture, so the manifest records a capture window
  and causal bookmarks, not a claim of a consistent as-of snapshot.
- Immutability does not make a pack legal evidence. Chain of custody and retention follow customer
  policy.

## 12. API

Every request is authenticated (E), bound to a source scope, validated against a schema, and returns
normalized errors. The OpenAPI document is generated from the code and published as
`packages/contracts/openapi.json`.

| Method / path | Purpose | Ed. |
|---|---|---|
| `GET /healthz`, `GET /readyz` | Liveness / readiness, including source reachability as counts `{ reachable, unreachable, unknown }` beside `checks` (decided 2026-11-02): no source IDs, because the probe is public, and a source outage does not change the status, which depends on Postgres and migrations only. The per-source state is in `GET /v1/sources` | C |
| `GET /v1/me` | Principal: edition, identity mode, role, permitted sources as `{sourceId, viewSensitive, synthetic}`, and the user's preferences. One call at app start; refreshed after sign-in or a 403 | C (`local`) / E |
| `GET /v1/sources` · `POST /v1/sources/{id}/test` | Configured sources · run `test-source` | C |
| `GET /v1/sources/{id}/profile` | Display model from the validated mapping, ETag = `config_hash` (§5.2) | C |
| `POST /v1/search/entities` | Source-scoped search: exact, related and evidence groups with bounded facet counts (§8.3). Built so far, the exact group only: body `{ sourceId, text, mask? }`, answer `{ sourceId, exact, cap, searchable, counts: { exact }, disabledTypes, dropped, warnings, elapsedMs }`; with `typeahead: true` (the canvas Search tool only; text 2 to 200 characters) the body takes that flag and the answer gains `startsWith: { nodes, count, dropped, warnings }`, a capped prefix lookup that is never counted exact; the exact group names its matched properties: the answer adds `exactMatches: [{ ref, matchedProperties }]`, one entry for each entity of `exact` in the same order, and a `/more` page of the exact group adds `matches` beside `nodes`, both worked out by the gate's caller from the redacted nodes and the request's targets, as for a related hit; the related group is built: the answer adds `related: { hits: [{ node, matchedProperties }], count, searchable, disabledTypes }` and `failures` (a group whose read failed while the other answered, §8.3), and the audit action `entity.search_related` records its read; the evidence group is built: the answer adds `evidence: { hits: [{ supports, records, rules }], count, searchable, disabledRelationshipTypes }` (§8.3) and the audit action `entity.search_evidence` records its read; the facets and the selection are built: the answer adds `facets` and `filters` (§8.3), the request may carry `entityTypes` and `matchModes`, and the audit action `entity.search_facets` records the facet read; the relationship context is built: a related hit may hold `context`, the related group may hold `context: { disabledTypes }`, `failures` may name the group `context`, the `/more` request takes `exactRefs` for `related` and the page `contextFailure` and `context`, and the audit action `entity.search_context` records its read | C |
| `GET /v1/entities/{sourceId}/{entityType}/{stableId}` · `GET /v1/edges/{ref}` | Detail + evidence + derivation. An edge reference travels as one percent-encoded path segment of at most 2,048 characters, the unpadded base64url text of the JSON of the reference the client holds (a stored one, `{ sourceId, type, from, to, stableId }`); a segment that does not parse, is over the bound or holds a form or an edge type, entity types or `stable_id` the mapping does not hold is `INVALID_REQUEST`, and an unknown or unreadable source and a missing edge are the same `NOT_FOUND`. The stored edge read is one fixed template (`edge-load`, audit action `edge.load`) of two rows through the gate, needing an online index on the relationship's `stable_id`. It answers `200` with `{ ref, type, semantics, from, to, observedAt?, properties, qualityFlags, evidence }`; `evidence` is `{ status: available, records[{ sourceRecordId, linkable } or { property, unreadable }] }` or `{ status: not-available, code: EVIDENCE_NOT_AVAILABLE }`: that code is a state of an ordinary answer, never an error response, and there is no confidence score. **A derived reference** `{ sourceId, derived: { ruleId, from, to } }` is read by the template `derived-edge-support` (audit action `edge.derived_support`, one read slot, bounded by the effective cap `min(DERIVED_NEIGHBOR_CAP, max_page)` as `LIMIT cap + 1`) and answers `200` with `{ ref, type, semantics: "derived", rule: { id, version }, from, to, supports: { count, groups[{ middle[], supports[{ ref, type, from, to, evidence }] }] }, qualityFlags, warnings }`: one group for each distinct tuple of middle entities, the count of groups `exact` or `lowerBound` (cut at the cap, or a chain left out as not mapped), a support with no stable ID shown as its aggregate reference with `evidence: { status: "no-stable-id" }` and nothing else. `INVALID_REQUEST` for a rule not in the source's mapping, ends that are not the rule's types, the same entity at both ends or an end of another source; the same `NOT_FOUND` for an unknown or unreadable source, a missing end, no chain, and a hidden end, middle entity or supporting edge (§10). An entity reference travels as three percent-encoded path segments, as in the deep link `/{source}/entity/{type}/{id}` (decided 2026-11-05); a type or ID made only of dots and tildes is sent with a leading `~` because a browser removes a dot-only segment (2026-11-06); `mask=true` is the only query parameter. The stable ID is matched as text and, when the text is a canonical 64-bit integer, as that integer too (§8.3) | C The aggregate form `{ sourceId, aggregate: { type, from, to } }` (all relationships of one type between two entities that no stable ID tells apart; for a type with a `stable_id`, those whose ID cannot be used) is answered by two fixed reads in sequence, each under its own read slot and audit event: `aggregate-sample` (`edge.aggregate_sample`: both ends and at most the lower of 25 and `max_page` members as their observed time and mapped `filterable` properties, never a relationship, so no element ID) and `aggregate-summary` (`edge.aggregate_summary`: the count and the earliest and latest observed time of every member, in the way the expansion counts the same pair). It answers `200` with `{ ref, type, semantics: 'aggregate', from, to, members, observedFirst?, observedLast?, sample: { order, rows, more? }, qualityFlags, warnings }`: `members` is a Count with the scope `aggregate:members` (every relationship of the type between the two ends, whatever filters a view applied), `exact`, or `unknown` when the summary read timed out or was refused as busy (no number, no range, no `more`, a warning, the sample kept); `sample.order` is `observed-newest` when the mapping maps `observed_at` and `source-order` otherwise (the first members the source returns, with no `ORDER BY`); there is no paging and no element ID, member reference, record ID or URL in any answer. Neither read is capped: the read timeout bounds each, and a slow aggregate read counts toward the source's breaker like any other slow template (§8.3 sets the rule; measured at 100,000 members: the count and range 102 to 148 ms, the sample ordered by observed time 159 to 173 ms, the sample with no order 65 to 67 ms). |
| `GET /v1/source-links/{ref}` · `…/{edgeRef}?record={sourceRecordId}` | "Open source record" for an entity, or for one evidence record of an edge with a stable ref: reads the element through the gate (re-checks access), writes one `source.link` audit event before it answers (`detail { target, type }`, never the ID or address; no event for a cancelled request; fail-closed), answers `302` to the mapping's link template with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and an empty body; every refusal after the reference parses is one `404 NOT_FOUND` (no template, keyed type masked or without the opt-in, record not carried in the property the template names, nothing found, a request another site started or a prefetch); `INVALID_REQUEST` for a segment that does not parse, an aggregate or derived reference, an unknown query key, a `record` on an entity or none on an edge. The URL is never in any response body (§8.3). The source profile carries `recordLink` flags. Limits: a template at most 2,048 characters, a built address at most 4,096 (decided, 2026-11-09) | C |
| `POST /v1/graph/preview-expansion` | Degree / facet preview | C |
| `POST /v1/graph/derived-neighbors` | Rule-derived neighbors of an entity: for each rule whose `from` is its type, the count with its quality and the derived neighbors, derived edges and supports, from the `derived-rule-run` template | C |
| `POST /v1/graph/expand` | Paged one-hop; `neighborTypes[]` with one page and cursor per type (§8.2) | C |
| `POST /v1/graph/paths` | Bounded paths (may be async) | C |
| `GET /v1/templates` · `POST /v1/templates/{id}/run` | Templates available for a source · run one with typed parameters, through the gate | C |
| `POST /v1/graph/read-refs` | Read again the entities, stored, aggregate and derived edges a draft names, by reference, at most 100 of each per call; `missing` lists what no longer resolves, once and without a reason | C |
| `PUT /v1/investigations/{id}/draft` | Autosave: `{layout, queryContext, notes}` with `If-Match` (the draft's version); `CONFLICTED_VIEW_VERSION` on a stale write | C |
| `GET/POST /v1/investigations` · `GET/PUT/DELETE …/{id}` · `POST …/{id}/restore` · `POST …/{id}/status` | List (filters, sort, cursor: `limit` default 25 and at most 100, `status` (open by default), `source`, `q` (2 to 200 characters, a fragment of the title or the case reference), a signed cursor bound to the caller and the filters, `{items, nextCursor, counts, matching}`, `nodeCount` and `edgeCount` null under another policy version), open-or-create, edit, soft delete and restore, close/archive/reopen. `PUT …/{id}` takes `{title, expectedVersion}`; `POST …/{id}/status` takes `{status, expectedVersion}` with the changes open→closed, open→archived, closed→open, closed→archived and archived→open (archived→closed is `CONFLICT`, reason `status-change-not-allowed`); a closed or archived investigation refuses a draft write and a rename with `CONFLICT`, reason `investigation-read-only`; audit actions `investigation.close`, `investigation.archive` and `investigation.reopen` (the success event is recorded after the change is committed, a failed write records a failed event, and a sink that rejects the success event makes the call answer `INTERNAL_ERROR` with the change kept) | C |
| `PUT …/{id}/draft` · `GET/POST …/{id}/views` · `PUT …/views/{viewId}` · `POST …/views/{viewId}/delete` · `POST …/views/{viewId}/restore` | Autosaved draft (ETag); named views: save, rename, delete, restore into the draft. A view delete is a `POST` because it takes an optional `{note}` (a `DELETE` has no defined body); it marks the view (`deleted_at`, `deleted_by`, `deletion_note`), which is then left out of every read and cannot be restored, and goes with its investigation's purge. `DELETE …/{id}` (guard `If-Match`) and `POST …/{id}/restore` (`{expectedVersion}`) are the investigation's soft delete and restore, audited as `investigation.delete`, `investigation.restore` and, by the purge task as the system, `investigation.purge` | C |
| `GET/PUT /v1/investigations/{id}/shares` | Investigation shares **[Later]** | E |
| `GET /v1/views` | Named views across the investigations the user can open (the Saved views tab). `{items, nextCursor, count}`, every status, readable sources, not deleted, keyset on (created, id) | C |
| `GET/PUT /v1/me/preferences` | Per-user display settings and tour state (`user_preferences`) | C |
| `GET /v1/exports/{id}` · `GET …/{id}/download` | Export status and download; only the requester may download, and each download re-checks their current access and policy version. The status answer is the row without its key or hash for any status; the download is an attachment (`Cache-Control: no-store`); the re-check is the owner, `authorizeSource` and the policy version (Community `none`); a failed check is `ACCESS_DENIED` with `details.reason` `access-changed`, the file is deleted and the row `expired`; a soft-deleted investigation's, another person's, an unknown and an expired export are `NOT_FOUND`; a file whose hash no longer matches is `INTERNAL_ERROR`. Audit `export.download` (format only) | C |
| `POST /v1/investigations/{id}/exports` | Plain export; Enterprise may include an AI case summary by passing its `summaryToken` (§9.5 rule 8). `Idempotency-Key` required; body `{kind: "view", format: "json"\|"csv", entities, edges, aggregates, derived}` (references; no `mask` field yet); the server reads each through the gate in calls of 100 under one rate unit and one 10 s deadline; more than the export cap (300 entities and 300 relationships, to be replaced by the measured figure) is `INVALID_REQUEST` with `details.reason` `export-too-large` and `details.maxElements`; 201 `{id, status, format, filename, sizeBytes, createdAt, expiresAt}`; JSON is one file, CSV is one zip of `entities.csv` and `relationships.csv`; every file begins with the header (source, time, `current view (partial)`, coverage with the count quality, masking); `EXPORT_FAILED` for a write failure; audit `export.create` (format, counts, masked fields). Maintenance task `expire-exports` (daily 03:41) deletes expired files; the purge deletes an investigation's files first | C |
| `GET /v1/jobs/{id}` · `GET …/events` (SSE) · `POST …/cancel` | Jobs **[Later]** | C |
| `GET /v1/diagnostics/bundle` | Redacted diagnostics zip **[Later]** | C |
| `POST /v1/ask/plan` · `POST /v1/ask/run` | Ask: plan → confirm/run; `ask/plan` takes `resolutions[]` and `send: false` (preview and `previewHash`, blocked words or a clarification), then `send: true` with the `previewHash`, as the assistant does (§9.2) **[W2]** | E |
| `POST /v1/summary` | AI case summary: re-read the view's elements through the gate, de-identify, draft, check, return the sentences (each with `storable`) and a sealed `summaryToken` **[W2]** | E |
| `POST /v1/investigations/{id}/draft/ai-notes` | Copy to notes: `{summaryToken, version}` (the draft's ETag). Re-checks the caller's write right and policy version, refuses a property-values token, appends the storable sentences once per token, returns `{copied, notCopied, alreadyCopied}` (§9.5 rule 8) **[W2]** | E |
| `POST /v1/assistant/turns` | Assistant: route a message to answer-from-view, a plan card, or a refusal; plans run only through `POST /v1/ask/run`. `send: false` returns the preview and `previewHash`, the blocked words or a clarification, and nothing is sent; `send: true` must carry the `previewHash` (§9.2) **[W2]** | E |
| `POST /v1/investigations/{id}/evidence-packs` · `GET /v1/evidence-packs/{id}` | Evidence packs **[Later]** | E |
| `GET /v1/admin/audit` · `POST /v1/admin/audit/exports` | Audit search, bounded · audit CSV export (event metadata only; itself audited) | E |
| `GET/PUT /v1/admin/policies/limits` | Source limits per source: current values, product ceilings and version history (versioned rows in `source_limits`, audited) | E |
| `GET /v1/admin/overview` | Health summary, source states, recent denials | E |
| `GET /v1/admin/users` · `PUT /v1/admin/users/{id}/grants` | Users with their role (from groups in SSO mode, set in the console in user-based mode); replace the user's grant set `{grants[]{sourceId, viewSensitive}, expectedVersion}` | E |
| `POST /v1/admin/users/{id}/disable` · `…/enable` | Disable (revokes all sessions) or re-enable a user **[Later]** | E |
| `POST /v1/admin/users/{id}/transfer-investigations` | Move a disabled user's investigations to another user, for example the new account of someone who lost both factors (audited) **[Later]** | E |
| `POST /v1/auth/oidc/login` · `GET …/callback` · `POST /v1/auth/logout` | SSO sign-in and sign-out **[Later]** | E |
| `POST /v1/auth/local/login` · `POST …/mfa` · `POST …/links/redeem` · `POST /v1/me/password` | User-based mode and break-glass: password, then TOTP; redeem an invite, password-reset (needs a TOTP code) or TOTP-reset (needs the password) link; the token travels in the URL fragment and the request body, never in a URL the server sees; change your own password with the current password and a TOTP code **[Later]** | E |
| `POST /v1/admin/users` · `PUT …/{id}/role` · `POST …/{id}/reset-password` · `POST …/{id}/reset-mfa` · `GET/POST/PUT/DELETE /v1/admin/teams` | User-based mode only: invite users, set roles, issue password-reset or TOTP-reset links (audited), manage teams **[Later]** | E |
| `GET /v1/admin/sources` | Data-store state, last test, limits. No secrets | E |
| `GET /v1/admin/settings` · `PUT /v1/admin/settings/{key}` | Feature switches and retention (versioned) | E |
| `GET/POST /v1/patterns` · `PUT/DELETE …/{id}` · `POST …/{id}/run` | Saved patterns; a run calls `POST /v1/templates/{id}/run` with the stored parameters **[W2]**, sharing **[Later]** | C / E |
| `POST /v1/admin/templates` · `POST …/{id}/approve` · `POST …/{id}/withdraw` | Template drafts, approval, withdrawal **[Later]** | E |
| `GET/POST /v1/alerts` · `PUT/DELETE …/{id}` | Alert rules and runs **[Later]** | E |

**Errors**

```json
{ "error": { "code": "QUERY_BUDGET_EXCEEDED", "message": "Refine your filters to continue.",
             "retryable": true, "traceId": "tr-8ef…", "details": { "maxPage": 50 } } }
```

Codes: `QUERY_BUDGET_EXCEEDED`, `QUERY_TIMEOUT` (504; `details.timeoutMs` is the limit that stopped the request, so a screen can say "after N s" truthfully: the source's server-side transaction timeout, or the request deadline (10 s, one deadline for all the reads of a request) when it was nearer, that is, when the deadline passed before the read could start or the read was given less time than the source's timeout because of it), `SOURCE_UNAVAILABLE`, `SOURCE_BUSY` (no read
slot freed within the wait, §14; retryable), `RATE_LIMITED` (per-user request rate; retryable, with
`retryAfterMs`), `ACCESS_DENIED`, `CURSOR_INVALIDATED` (409; a cursor that is altered, malformed, expired, signed with another key or bound to another source, person, policy version, sort, template or filter; one answer for every cause, with no detail; the cursor is the text `v1.<payload>.<mac>`, valid 30 minutes, signed under `NEBURYX_CURSOR_KEY`, §8.2), `PARTIAL_RESULT`,
`EVIDENCE_NOT_AVAILABLE` (reserved: the stored edge read reports it as a state in a `200` answer and never as an error response; the table still lists it as 404, 2026-11-09), `CONFLICTED_VIEW_VERSION`, `CONFLICT` (a stale `expectedVersion` on any
other resource), `EXPORT_FAILED`, `ASK_UNSUPPORTED`, `ASK_PLAN_INVALID`. Five codes were added
with the first API skeleton (2026-10-31), for answers that had no code: `INVALID_REQUEST` (400:
malformed URL, JSON, chunk framing or body), `UNSUPPORTED_MEDIA_TYPE` (415), `NOT_FOUND` (404),
`INTERNAL_ERROR` (500) and `SOURCE_MISMATCH` (400: a reference names a different source than the
one bound to the request; a structural rule, not a permission, so it is not `ACCESS_DENIED`). Each
code has one fixed message, an HTTP status and a retryable flag in `packages/contracts`; the status
and flag of a code are defaults until the first endpoint that returns it confirms them. Messages never
contain Cypher or sensitive IDs: the text a throw site passes is never sent, and `details` carries
only named, typed fields.

### 12.1 Conventions for every endpoint

Decided once (2026-11-01) so that new endpoints follow the same rules. A number that comes from
another section is cited; the rest are decisions made here, with the reason. The rules are also in
`docs/api-conventions.md`.

**Pagination** applies to every list backed by the application database: investigations, saved views, saved patterns,
users, audit events and exports.

- **Request.** `limit`: a positive integer, **default 25, maximum 100**. `cursor`: the opaque string from the previous
  response. 25 matches the graph default (§8.2); 100 keeps a page small enough for a table and for the audit viewer.
- **Order.** Keyset paging only. Each endpoint declares a stable total order: its sort key or keys, then the row's id as
  the tie-breaker. Rows with a null sort value go last, in their own phase of the cursor (as in §8.2). There is no offset paging.
- **Response.** `{ items: [...], nextCursor: string | null }`; `nextCursor` is null on the last page. There is no total by
  default. An endpoint that shows one returns a `Count` with its quality label (§6), never a bare number.
- **Cursor.** Opaque, HMAC-signed, expiring, and bound to the principal, the route, the sort, a hash of the filters, the source
  when the list is scoped to one, and the policy version (the set §8.2 binds for graph pages). Any mismatch is
  `CURSOR_INVALIDATED`. The expiry is **30 minutes** (decided with the first cursor); the format, the position and the signing key `NEBURYX_CURSOR_KEY` are in §8.2.
- **Refusals.** A limit above the maximum is `QUERY_BUDGET_EXCEEDED` carrying `maxPage` (the code the gate already uses for
  graph reads), not a silent clamp, so a client never gets less than it asked for. A limit that is not a positive integer
  is `INVALID_REQUEST`. A cursor that is invalid, tampered with, expired, or whose binding (user, route, source, policy version,
  sort or filters) does not match the request is `CURSOR_INVALIDATED`.
- **Not covered.** The graph reads keep their own shapes and numbers: expansion returns one page and one signed cursor per
  neighbor type under the source budgets (§8.2, §14), and search returns capped result groups that report `lowerBound` when
  capped (§8.3). This convention restates none of that.

**Field limits.** Every request is validated against a strict schema (unknown fields are rejected) and a violation is
`INVALID_REQUEST`.

| Field | Limit | Source |
|---|---|---|
| Investigation title | 200 characters | application schema |
| Case reference | 100 characters | application schema |
| View and pattern names | 120 characters | application schema |
| Notes | 10,000 characters | application schema |
| Search text | 1 to 200 characters for exact search; 2 for type-ahead | the minimum of 2 is §8.3 and is for type-ahead only (a stable ID can be one character); the maximum is decided here |
| A template string parameter | 200 characters | decided here; a template's schema may be stricter |
| A template list parameter | 100 items | decided here; a template's schema may be stricter |
| Request body | 1 MiB | the server's default, which the API does not raise, except `PUT /v1/investigations/{id}/draft`, which takes two documents of at most 1 MiB each and so a body of 2 MiB and 4 KiB; a body whose declared length is over the limit is refused before it is read, and one sent in chunks is refused as soon as the received size passes it |

Characters are counted as code points, the way Postgres `char_length` counts them in the `CHECK` constraints, so the API
and the database never disagree about a value's length.

**Idempotency keys** make a retried create safe.

- **Header.** `Idempotency-Key`: 16 to 64 characters from letters, digits, `_` and `-` (a UUID fits). It is **required** on the
  calls that create or run something and that a retry could repeat: `POST /v1/investigations/{id}/exports`,
  `POST /v1/admin/audit/exports`, `POST /v1/templates/{id}/run` and `POST /v1/patterns/{id}/run` (a pattern run is a template
  run), `POST /v1/ask/run`, `POST /v1/summary`, and alert creation `POST /v1/alerts`. It is not asked of
  reads, of writes guarded by a version, or of deletes, which repeat harmlessly. A missing or malformed key is `INVALID_REQUEST`.
- **What is kept.** For 24 hours the server keeps, for the principal, the key, a **fingerprint** of the request and the first
  response. The fingerprint is a SHA-256 of the method, the concrete path (with its ids), the query string and the canonical
  JSON body. A call that ended in a server error (status 500 or above) is not kept, so a retry runs it again. 24 hours is long
  enough for client retries and for a user who comes back the next morning, and short enough to prune cheaply; it is decided here.
- **A repeat** with the same key and the same fingerprint returns the first response (status and body) with
  `Idempotent-Replay: true` and does not run the operation again. A repeat while the first call is still running is `CONFLICT`.
  The same key with a **different** fingerprint is `CONFLICT`: another path, another source or investigation, or another body.
- **A replay is authorized like a new call.** Before a stored response is returned, the server checks the caller's current access
  for the route as it would for a new call, so access revoked since the first call is `ACCESS_DENIED` and nothing is replayed.
  The policy version in force at the first response is stored with it; if the policy version has changed, the stored response is
  not returned and the call is `CONFLICT` (the client sends a new key), and the operation is not run again. The endpoint that
  builds the storage tests both cases (caches are keyed by principal and policy version, and a privileged result is never
  reused for a less-privileged session).
- **Example.** A client sends key `K` with an export of investigation A, then key `K` with an identical body for investigation B.
  The paths differ, so the second call is `CONFLICT`; A's export is never returned for B, so a response cannot cross an
  investigation or a source (invariant 2).
- **Storage** is a Postgres table created by the first endpoint that needs it and pruned by a scheduled task (§13).

**Concurrency** guards every edit of a resource that has a `version`.

- **The version travels as an ETag.** Every response for a versioned resource carries `ETag: "<version>"` (a strong tag: the
  version as a quoted integer) and the `version` in the body. A successful write returns the new version.
- **Drafts and views** use `If-Match: "<version>"` on every call that changes them. A mismatch is `CONFLICTED_VIEW_VERSION` (409).
- **Investigations, grants, settings, limits and saved patterns** use `expectedVersion` (an integer of 1 or more) in the JSON body
  of the call that changes them. A mismatch is `CONFLICT` (409).
- **A delete has no body**, so its guard is always `If-Match`, whatever the resource, and a mismatch answers the resource's
  own code. A delete of a resource that has a version is a modification: investigations and saved patterns are soft-deleted, and restoring one is guarded too.
- **A missing guard** on a guarded call is `INVALID_REQUEST`.
- **Two shapes were already specified and stay as they are.** Saving a view (`POST …/views`) is guarded by the draft's ETag in
  `If-Match` and also carries `expectedInvestigationVersion` in the body when the title changes. Copy-to-notes
  (`POST …/draft/ai-notes`) takes the draft's version as `version` in its body (§12).
- **A content-hash ETag** (`GET /v1/sources/{id}/profile`, ETag = `config_hash`, §5.2) is a cache validator, not a version: the
  client sends `If-None-Match` and gets 304 when it still matches.

| Convention | Applies to |
|---|---|
| `Idempotency-Key` required | exports (`POST …/{id}/exports`, `POST /v1/admin/audit/exports`), template and pattern runs, `POST /v1/ask/run`, `POST /v1/summary`, `POST /v1/alerts` |
| `If-Match` | `PUT …/{id}/draft`, `POST …/{id}/views`, `PUT …/views/{viewId}`, `POST …/views/{viewId}/delete`, `POST …/views/{viewId}/restore`, and every `DELETE` of a versioned resource |
| `expectedVersion` in the body | `PUT /v1/investigations/{id}`, `POST …/{id}/status`, `POST …/{id}/restore`, `PUT /v1/admin/users/{id}/grants`, `PUT /v1/admin/settings/{key}`, `PUT /v1/admin/policies/limits`, `PUT /v1/patterns/{id}` |
| Neither | reads (`GET`), and calls that create or change nothing that has a version |

An endpoint not in the table has no version until one is added, and then follows these rules.

**Permission per endpoint.** Every route says who may call it, in its route options: `config: { permission: 'public' }` or
`config: { permission: 'principal' }`.

- `public`: no sign-in is needed (the probes, `/healthz` and `/readyz`). `principal`: a signed-in principal; in Community that
  is the `local` one (`/v1/me`). The web build's files are public by construction and are served by the static-files plugin,
  outside this declaration.
- There is **no default**. A route with no declaration, or with a value that is not one of the two, fails a unit test that
  reads every route the application registers (the app records each route with its declared permission, whatever its path,
  beside the shorter list the contract test uses). That makes "who may call this" a decision made where the route is added.
- Nothing enforces the value at run time yet: Community has one principal. The declaration is what Enterprise's
  authorization reads, and Enterprise adds roles and capabilities as further values when its policy exists (the questions
  are: who may Ask or summarize, run `test-source`, duplicate, delete, share or run a pattern, export a table).

## 13. Jobs, progress and cancellation

**v0.1:** interactive calls run synchronously, with the server-side transaction timeout, and the
client can abort a request. The previous graph is always kept. The job table and SSE below are
**[Later]**, for long paths, exports and evidence packs.

**Runner.** graphile-worker on Postgres (ADR-01, ADR-04): it claims work with `SKIP LOCKED` and
runs cron-style maintenance tasks from v0.1 (purge deleted investigations, expire exports; `source_checks`
is pruned inline when a check is stored, in the same transaction, so it never holds more than 50 rows per source); Enterprise adds session cleanup, keeping audit partitions 3 months ahead and
dropping expired ones, and sealing audit windows. It runs inside the API process in Community and in `worker` copies in
Enterprise. The `jobs` table holds the user-visible state below; graphile-worker's own tables hold
only queue mechanics. Progress reaches the SSE stream through Postgres `LISTEN/NOTIFY` (payload: the job
ID only) in both editions. graphile-worker's `LISTEN` connection needs a direct or session-mode
connection, not PgBouncer in transaction mode.

```
QUEUED ─► RUNNING ─► COMPLETED
   │         ├─► PARTIAL ─► COMPLETED | TIMED_OUT | FAILED
   │         └─► CANCEL_REQUESTED ─► CANCELLED | COMPLETED | FAILED
   └─► CANCELLED | EXPIRED
RUNNING ─► FAILED | TIMED_OUT
```

- The **SSE** stream sends the phase, elapsed time, measurable progress only (never a fake
  percentage), partial-result availability and the terminal state. Clients reconnect with
  `Last-Event-ID`.
- **Cancellation is idempotent** and never touches already loaded elements or saved state.
  - Queued jobs are removed.
  - Running jobs: the **session** is closed (`session.close()`), not only the transaction.
    The product does not attempt `TERMINATE TRANSACTION`: it closes the session and relies on the server-side
    transaction timeout, which is the guaranteed stop. Closing the session was observed to stop the
    query too (below). Whether a read-only principal may terminate its own read was tested and is recorded below.
  - If cancellation races with completion, the server reports what actually happened.
  - **Observed behaviour** (driver check, 2026-11-01; `tools/driver-check` in this repository).
    Neo4j Community 5.26.32 and 2026.10.1 (values below are 5.26.32 / 2026.10.1), `neo4j-driver` 6.3.0, one
    machine, one query shape: a three-way cross-product read over 3,000 synthetic nodes in a read-access
    explicit transaction. The server's transaction list was looked at about every 500 ms and matched by
    transaction metadata, so the server side is known only to within one look. Client times are measured from
    the start of the query unless a time says it is "after the close".
    - *At the transaction timeout (1,000 ms):* the pending call raised `Neo4jError` with code
      `Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration` at 1.623 s / 1.438 s. The last look to
      find the query running was answered at 1.496 s / 0.991 s and the first look to find the transaction
      gone at 2.003 s / 1.490 s; it was still gone 15 s later. The same session ran a new transaction
      afterwards. A read inside its timeout returned in 42 ms / 42 ms. The code is not `TransactionTimedOut`, so
      error mapping matches the family `Neo.ClientError.Transaction.TransactionTimedOut*`.
    - *Closing the session mid-query (`session.close()`, 20 s timeout):* the pending call raised
      `Neo.ClientError.Transaction.Terminated` at 0.512 s / 0.512 s, 2 ms and 1 ms after the close was called; the
      close returned after 1 ms; the last look to find the query running was answered at 0.493 s / 0.494 s and the
      first look to find the transaction gone at 1.000 s / 1.000 s (about 0.5 s after the close was called). The
      transaction was gone at 5 s and 15 s after the close. The same driver ran another read afterwards. Whether
      the driver reset or closed the connection was not examined.
    - *Closing the transaction mid-query (`tx.close()`, 20 s timeout):* the close **raised** the timeout code
      above, 20.446 s / 20.797 s after it was called (so it did not return before the server's timeout); the
      pending call raised the same code at 20.955 s / 21.308 s after the query started. The transaction was
      listed at 5 s and 15 s after the close and at the 20 s timeout, the last look to find the query running was answered at
      20.549 s / 21.043 s and the first look to find the transaction gone at 21.051 s / 21.549 s. The same driver
      ran another read afterwards. In this case closing the transaction neither ended the query before its
      timeout nor freed the caller before it.
    - *Through the product (2026-11-07, Neo4j Enterprise 5.26.32, `neo4j-driver` 6.3.0, a development server):* the API
      sees a closed connection, the adapter closes the session at once with no rollback first, and the read ends as
      cancelled. On a node of 100,000 relationships each of an expand, a degree preview, an entity read and a search was
      aborted once the server listed its transaction, and the transaction was gone at the first look in every attempt
      (the times, with the look interval, are in `docs/benchmarks/supernode.md`; they are observed times, not promises).
      A login that can only read **was permitted** to terminate its own running read (`TERMINATE TRANSACTION`); the adapter
      ends such a read as a failed read (`READ_FAILED`). A write in a read-access session was **refused** by the server
      (`Neo.ClientError.Statement.AccessMode`), also for a login that may write. Four reads cancelled together at a source
      limit of four left no transaction, no slot and no open session. The public record is `docs/cancellation.md`.
    - *Not tested:* a proxy, load balancer, AuraDB or a cluster; Neo4j 2026.x through the product; other query shapes
      than the four above, and load beyond the source's read limit. The server-side lateness of the timeout is only
      bounded by the figures above, not measured exactly.
- **Leases and deadlines** stop abandoned work. The in-process runner (C) and `worker` (E) share
  the same job table semantics.

## 14. Non-functional requirements and operations

**Pilot design targets** (not measured SLOs; calibrate on representative data):

| Area | Target |
|---|---|
| Initial display | ~8–15 entities |
| Expansion page | 25 default, 10–50 configurable, always enforced on the server |
| Rendered objects | 150–300 soft target, then aggregate |
| Interactive latency | p95 < 3 s for indexed, bounded operations (demo benchmark) |
| Query timeout | 5–10 s for interactive reads, configurable (product ceiling 10 s) |
| Heavy-operation warning | A pre-run estimate above 500 (configurable) asks the user to refine the filters or continue with a bounded limit of 25 |
| Supernode benchmark | 1k / 10k / 100k-neighbor nodes: preview, filtered expand, cancel |
| Fresh install | ≤ 15 min from `docker compose up` to a working investigation on the demo graph |
| Upgrade | Tag change only; tested upgrade from N-1 on every release |
| Image | Single multi-arch image (amd64/arm64). Signing and SBOM are **[Later]**. |
| Accessibility | Keyboard paths for core actions now; WCAG 2.2 AA later |

**Low-maintenance features**

- `/healthz` and `/readyz`.
- Startup config validation with clear errors.
- `neburyx test-source`.
- **[Later]** Schema-drift detection: when the schema hash changes, the UI shows a banner and the
  affected templates are disabled with a reason.
- **[Later]** Diagnostics bundle: version, config with secrets removed, capability reports, recent
  errors and metrics. **No PII, no parameters, no secrets.**

**Observability**

- OpenTelemetry traces across the gate stages.
- Metrics:
  - latency for search, expand, preview, path and Ask;
  - rows returned;
  - cursor invalidations, timeouts and cancellations;
  - pool health and job queue depth;
  - Ask unsupported rate and citation-failure rate.
- Logs are structured, with PII and parameters scrubbed by default.

**Source protection**

- Per-source connection pools.
- **Two concurrency limits on every read** (decided 2026-10-30): a per-user slot for the source
  (default 2), then a source-wide slot (default 32, set by the customer). The read waits up to
  `queue_wait_ms` (default 2 s) for both, then fails with `SOURCE_BUSY` and keeps the loaded graph.
  Leases expire after the request timeout plus a margin, so a crashed process cannot hold a slot.
  Enterprise shares the leases across API copies in Valkey (ADR-12) and fails closed
  (`SOURCE_UNAVAILABLE`, reason "coordination store unreachable") if Valkey is unreachable, so
  Valkey must be highly available; Community keeps the leases in memory.
- A circuit breaker on repeated timeouts, shared across API copies the same way.
- Admission control that considers current load, so one investigation can't monopolize a cluster.

## 15. Repository layout and developer workflow

```
neburyx/
  apps/web/                 React + TS + Vite client
  services/api/src/         TypeScript API (modules as in §3)
  services/api/tests/       unit, contract, integration (testcontainers: Neo4j, Postgres, Valkey)
  ee/                       Enterprise modules (Apache-2.0); may hold api/ and web/ subtrees
  packages/contracts/       Zod schemas, generated openapi.json, typed client for the web app
  domain-packs/             banking-fraud/, insurance-claims/: YAML only, no code (§5.1)
  deploy/docker/            Dockerfile (multi-stage: web build → Node runtime)
  deploy/compose/           Community compose file: neburyx + postgres, loopback only
  deploy/demo/              docker-compose: two neo4j + demo loader + postgres + neburyx
  tools/demo-graph/         synthetic graph generator, driven by the packs' demo data
  tools/ask-eval/           Ask evaluation harness (may be Python; calls the API only)
  docs/                     PUBLIC technical docs only: technical-architecture.md and
                            coding-guidelines.md
  LICENSE (Apache-2.0)                      ee/LICENSE (Apache-2.0)
```

**Stack (ADR-01).** One `pnpm` workspace: `apps/web`, `services/api`, `packages/contracts`, `tools/*`.
Node 24 LTS, TypeScript in strict mode everywhere.

| Task | Command (proposed) |
|---|---|
| Dev environment | `make dev`: Neo4j demo + Postgres containers, API (watch mode, YAML reload) + web (Vite) |
| Tests | `make test`: unit + contract (Vitest); `make test-int`: integration against testcontainers Neo4j, Postgres and Valkey |
| Ask eval | `make ask-eval` (needs a configured model; nightly in CI) |
| Lint / types | `eslint` and `tsc --noEmit` (strict) across the workspace; the no-domain-words check (§5.1) |
| Image | `make image`: build, SBOM, sign |
| Demo | `cd deploy/demo && docker compose up` |

All dependencies are pinned with `pnpm` (the Ask eval harness, if it stays in Python, uses `uv`).
The API and the web app import the same Zod schemas from `packages/contracts`, and contract tests
check the generated `openapi.json` against the running API, so drift fails the build.

### 15.1 Synthetic demo graph

`tools/demo-graph` uses a deterministic, seeded generator, driven by each domain pack's demo
data (§5.1). It writes one Neo4j instance per pack (`banking-fraud`, `insurance-claims`; Neo4j
Community allows one standard database per instance, so the demo runs two containers), and each
is configured as its own source. Together they produce:

- accounts, customers, devices, IP addresses and payments (banking); claims, policies, claimants,
  vehicles, repairers, addresses and phones (insurance);
- 3 supernodes (about 1k, 10k and 100k neighbors);
- shared-attribute rings;
- noisy data: duplicate addresses, NAT devices on the stop list, and missing timestamps;
- derived-edge rules;
- 5 scripted demo cases with known answers, at least one per pack, which are also used by the
  integration tests and the Ask evaluation.

**Synthetic only.** Nothing is derived from any real organization's schema.

## 16. Threat model

| Threat | Mitigation and test |
|---|---|
| Cypher injection | Templates only; parameters only; labels/types only from the validated allowlist; fuzz tests on all inputs |
| Prompt injection through the question or graph data (Ask) | The LLM can only choose a template and parameters, which are schema-validated; graph text in the answerer is treated as data; citation check; no tool or code execution |
| Restricted data leaked to the LLM | Redaction before model context; PII never sent by default; provider chosen by the customer; tests with PII-tagged fixtures |
| Unauthorized traversal through derived links | Both-endpoints-plus-support rule; negative authorization tests |
| PII leaked via caches or exports | Policy-aware cache keys; redaction before export; short-lived URLs; audit |
| Source DoS via supernodes | Degree probe, budgets, timeouts, concurrency quotas, circuit breaker; load tests |
| Cursor tampering or replay | HMAC-signed, expiring, scope-bound cursors |
| Evidence-pack tampering | `SHA256SUMS` plus a manifest hash; `verify-pack`; append-only storage |
| Audit-log tampering (E) | App role has `SELECT` only and writes through `audit_append`, which sets the time (`INSERT`/`SELECT` in W2); chained seals (`audit_seals`); `verify-audit`; tests that alter, delete and insert events and expect a mismatch |
| Community exposed on a network | Compose file and docs publish on `127.0.0.1`; the README warning is prominent; the app warns when it can detect a non-loopback bind (outside containers) |
| Facet/degree counts reveal restricted neighbors (E) | Policy-aware counts or `unknown` (§8.1); negative tests |
| Stale permissions on a saved or shared view (E) | Authorization re-checked on reopen, share, export and source change |
| `test-source` mutates the customer graph | Privilege inspection only; the write probe is opt-in, test environments only, and always rolled back (§5) |
| Credential leak | Secrets by reference only; masked in the UI, logs and diagnostics |
| Source-record links: URL injection, open redirect, IDs leaking to third parties | `https` only, host fixed in the template, the only placeholder is the stable ID or an evidence property (never `pii`, except the stable ID of a keyed type with the explicit `link_carries_value` opt-in, built only for an unmasked request), percent-encoded; served through the audited `/v1/source-links/{ref}` redirect with `noopener noreferrer`; validated by `test-source` and mapping tests |
| Password guessing in user-based mode (E) | Argon2id hashes; mandatory TOTP; both factors checked together so the password step reveals nothing; lockout after repeated failures; rate limits on sign-in; recovery links need the other factor. The break-glass account is throttled per client address, taken only through trusted proxies (never locked), alerts on repeated failures, can be limited to an address allowlist, and every sign-in is audited. The password step takes the same time and answers the same way whether or not the user exists |
| Compromised worker | Narrow identity; restricted egress; same gate as the API |

## 17. Testing and acceptance checks

| Suite | Representative cases |
|---|---|
| Mapping | Invalid YAML, missing labels, non-unique stable IDs, missing indexes (including `reference` and `evidence` indexes); invalid `link` templates (wrong scheme, a placeholder in the host, a `pii` placeholder other than the opted-in stable ID of a keyed type); defaults for a minimal mapping; `neburyx init` output validates after the `TODO`s are filled |
| Domain neutrality | Both domain packs pass the full Community suite on the same image with no code change; the no-domain-words check passes; a view saved under one mapping reopens after a type and a property are removed (placeholders, dropped filters, banner) |
| Concurrency | Per-user and per-source limits hold across several API copies; `SOURCE_BUSY` after the wait; leases released on crash (expiry); `SOURCE_UNAVAILABLE` when Valkey is down (E) |
| Normalization | Identity, source scope, masked and missing properties, stored vs derived edges |
| Supernodes | 1k/10k/100k: no huge payloads; count quality incl. `lowerBound`; stable load-more incl. null sort values; per-page server cost measured |
| Gate | Every endpoint goes through the gate (an architecture test fails if a router calls the adapter directly) |
| Cancellation | Queued, running and raced-complete jobs; source outage mid-job; the graph stays intact |
| Ask (E) | Plan accuracy; invalid-plan repair; `unsupported`; local entity resolution (no typed names or IDs in the prompt); injection fixtures; citation check once the LLM answerer exists |
| AI summary (E) | Placeholder round trip (no names or IDs in the prompt); citation check; numeric consistency; omissions line written by the server; injection fixtures; no-verdict check |
| Assistant (E) | Route accuracy; follow-up resolution against the investigation's entities; one plan per turn, no auto-run; refusals for raw-query, cross-source and verdict requests; replies pass the AI-summary suites |
| Evidence (E) | `verify-pack`; partial capture; unavailable evidence; tamper detection |
| Audit (E) | `verify-audit` detects an altered, deleted or inserted event and a broken seal chain; late insert into a sealed window fails closed; app role cannot update, delete or truncate |
| Authorization (E) | Cross-source deep link, hidden labels, derived-link leakage, facet-count leakage, stale permissions on reopen, viewer export denial, share filtering leaves no trace, oversight opens audited |
| Identity (E) | SSO group-to-role mapping; local sign-in needs password and TOTP; TOTP replay refused; lockout counts TOTP failures; invite and reset links single-use and expiring; break-glass is the only local login in SSO mode, never locked, audited; disabling a user revokes sessions |
| Operations | Fresh install, N-1 upgrade, rollback, restart mid-job, source credential rotation |
| UX | Laptop viewport, keyboard paths, table-graph sync |

**Acceptance checks by release:**

1. **Community v0.1.** Demo-graph install ≤ 15 min; supernode suite
   passes; domain-neutrality suite passes (both packs); the author completes the demo case and the mapping task.
2. **Ask preview [W2].** Plan accuracy meets the eval baseline; every summary statement
   cites returned elements; the AI case summary and the assistant's replies pass the citation, numeric and leakage suites on the demo views; assistant route accuracy meets its baseline; the preview itself runs on any source (decided 2026-11-12), under the data rules of §9.4 and the audit.
3. **Enterprise build [Later].** Evidence-pack suite (`verify-pack`, tamper,
   partial); OIDC/RBAC/audit/PII suites; image signing and SBOM; security checklist; install
   runbook; documented limitations.

## 18. Extension points and open decisions

| Future | Extension strategy | Not built now |
|---|---|---|
| TigerGraph or another engine | A new `GraphSourceAdapter` + template set + capability flags | Query-language translation |
| Degree/frontier sidecar | An adapter-side accelerator for degree and bounded frontier expansion when Neo4j can't serve them cheaply | Any dependency on it in the core product |
| Customer templates | Declarative definitions written by a builder form or by YAML, validated, approved by an admin, signed and versioned; usable by Ask (§7.2) | Free-form queries, or any query-text field |
| Alerts | Scheduled runs of saved patterns, in-process, under the owner's policy; counts and signed links only (§7.2) | A second image, notification content with entity data |
| AI summary of a saved evidence pack | The AI case summarizer over a pack's contents, with the same checks | Autonomous agents |
| Analytics overlays | Governed background jobs (GDS where the customer has it) | Cross-engine algorithm emulation |
| Collaboration | Versioned shared views | Live multi-user canvas |
| Mapping editor in the UI | A validate-only editor that proposes a YAML change for review in git (ADR-14) | Editing the live mapping from the browser |
| Hosted offering | A dedicated single-tenant deployment run for a customer (ADR-13) | Multi-tenant SaaS |
| Export destinations | Send exports to the customer's central storage (an S3-compatible bucket, SharePoint) through a configured `ExportSink`, with an option to disable local downloads, because regulated organizations don't want reports on laptops | Anything beyond file delivery; v0.1 and W2 export by download only |

Technical decisions to settle early:

- **Renderer (decided 2026-11-03: Cytoscape.js):** the first spike rendered the demo supernode case (300 elements,
  a 3,000-neighbor aggregate node) in Cytoscape.js and Sigma.js and compared incremental layout,
  grouping and compound nodes, keyboard access, frame rate and styling effort (the renderer criteria); see ADR-02. The `GraphCanvas` wrapper keeps the choice reversible.
- **Neo4j support (decided 2026-10-30):** v0.1 supports Neo4j 5.26 LTS (the last 5.x) and the
  current calendar release (2026.x), Community and Enterprise, self-managed. CI runs the integration and supernode
  suites on both. AuraDB is best effort until a customer needs it.
- **Source identity:** confirmed with the first customer deployment; the default is in §10 (a delegated per-user identity where supported, otherwise a read-only service principal).
- **Neo4j driver timeouts and cancellation** in `neo4j-driver` for JavaScript: **checked** on
  2026-11-01 (`tools/driver-check`; Neo4j Community 5.26.32 and 2026.10.1, `neo4j-driver` 6.3.0;
  figures are 5.26.32 / 2026.10.1 and are given in §13 with the origin of each time). At a 1,000 ms
  transaction timeout the call raised `TransactionTimedOutClientConfiguration` 1.623 s / 1.438 s after the
  query started, and the first look to find the transaction gone was answered at 2.003 s / 1.490 s.
  `session.close()` mid-query made the pending call raise `Transaction.Terminated` 2 ms / 1 ms after the close
  was called, and the first look to find the transaction gone was answered at 1.000 s / 1.000 s after the query
  started (about 0.5 s after the close was called). `tx.close()` mid-query raised the timeout error
  20.446 s / 20.797 s after it was called, for a 20 s timeout. What was not tested is listed in §13; the product-level cancel results are added there.
  Re-run the check when the driver or a supported server version changes.
- **Application database decisions** (audit retention and tamper evidence, teams, retention
  defaults, notes, deep links with a case reference, duplicate) are settled with defaults; revisit with the first customer deployment.
