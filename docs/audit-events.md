# Audit events

Every audit event of the product, which path writes it and why. There are two paths:

- **queued**: the event is handed to a bounded in-process queue and written after the request has gone on, with retry. A failed or dropped write is counted in `GET /readyz` and logged by its id fields, never its text, and never fails or delays the request that raised the event.
- **privileged**: the event is written directly, awaited, and for an action that changes stored data it is inserted through the transaction of the change, so the action does not happen when its event cannot be written. These are the privileged and administrative actions of the audit rule: investigation status change, delete and restore, exports, and the retention deletions.

The table is checked against the code (`pnpm test` runs the check in `tools/workspace-checks/src/architecture/audit-routing.ts`): an event written anywhere without a row here fails it, and so does a row for an event no longer written in the file it names. A privileged row must name files that write through a transaction.

| Event | Result | Path | Written in | Why |
|---|---|---|---|---|
| `ai.case-summary` | any | queued | `ee/ask/src/case-summary/summarizer.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `ai.case-summary.closed` | any | queued | `ee/ask/src/case-summary/summarizer.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `ai.case-summary.copied` | any | queued | `ee/ask/src/case-summary/copy-route.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `ai.case-summary.read` | any | queued | `services/api/src/graph/elements-reader.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `ai.route_refused` | any | queued | `ee/ask/src/route-guard.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `assistant.ask` | any | queued | `ee/ask/src/assistant/turn-route.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `assistant.continue` | any | queued | `ee/ask/src/assistant/turn-route.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `assistant.route` | any | queued | `ee/ask/src/assistant/router.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `assistant.turn.closed` | any | queued | `ee/ask/src/assistant/turn-audit.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `ask.classify` | any | queued | `ee/ask/src/classify/classifier.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `ask.continue` | any | queued | `ee/ask/src/questions/question-routes.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `ask.file_query` | any | queued | `services/api/src/gate/templates/file-query.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `ask.question` | any | queued | `ee/ask/src/questions/question-routes.ts`, `services/api/src/app.ts` | An Ask, summary or assistant event: queued, so the answer is never withheld for it. |
| `edge.aggregate_sample` | any | queued | `services/api/src/gate/templates/aggregate-evidence.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `edge.aggregate_summary` | any | queued | `services/api/src/gate/templates/aggregate-evidence.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `edge.derived_support` | any | queued | `services/api/src/gate/templates/derived-edge-support.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `edge.load` | any | queued | `services/api/src/gate/templates/edge-load-many.ts`, `services/api/src/gate/templates/edge-load.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.degree_preview` | any | queued | `services/api/src/gate/templates/degree-preview.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.derived_rule_run` | any | queued | `services/api/src/gate/templates/derived-rule-run.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.linked_entities_count` | any | queued | `services/api/src/gate/templates/linked-entities-count.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.linked_entities_run` | any | queued | `services/api/src/gate/templates/linked-entities.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.load` | any | queued | `services/api/src/gate/templates/entity-load-many.ts`, `services/api/src/gate/templates/entity-load.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.search` | any | queued | `services/api/src/gate/templates/search-exact.ts`, `services/api/src/gate/templates/search-prefix.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.search_context` | any | queued | `services/api/src/gate/templates/related-context.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.search_evidence` | any | queued | `services/api/src/gate/templates/search-evidence.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.search_facets` | any | queued | `services/api/src/gate/templates/search-facets.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.search_related` | any | queued | `services/api/src/gate/templates/search-related.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.shared_attribute_count` | any | queued | `services/api/src/gate/templates/shared-attribute-count.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `entity.shared_attribute_run` | any | queued | `services/api/src/gate/templates/shared-attribute.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `export.create` | success | privileged | `services/api/src/exports/export-service.ts` | An export is a privileged action (exports and evidence packs): its event is inserted with the export's completion and fails with it. |
| `export.create` | refused | queued | `services/api/src/exports/export-service.ts` | A refusal is not the action: its event is queued through `refusalAudit`, so a refusal is never withheld for it. |
| `export.download` | success | privileged | `services/api/src/exports/export-service.ts` | A download of an export is a privileged action: the event is written before the file is handed out and a failure refuses the download. |
| `export.download` | refused | queued | `services/api/src/exports/export-service.ts` | A refusal is not the action: its event is queued through `refusalAudit`, so a refusal is never withheld for it. |
| `gate.read` | any | queued | `services/api/src/gate/audit.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `graph.expand` | any | queued | `services/api/src/gate/templates/expand-count.ts`, `services/api/src/gate/templates/expand-neighbors.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `graph.read_refs` | any | queued | `services/api/src/graph/read-refs-service.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `graph.shortest_paths_count` | any | queued | `services/api/src/gate/templates/shortest-paths-count.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `graph.shortest_paths_run` | any | queued | `services/api/src/gate/templates/shortest-paths.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `investigation.archive` | any | privileged | `services/api/src/investigations/status-change.ts` | Investigation status, delete and restore are privileged (TAS section 10): the event commits with the change and fails with it. |
| `investigation.close` | any | privileged | `services/api/src/investigations/status-change.ts` | Investigation status, delete and restore are privileged (TAS section 10): the event commits with the change and fails with it. |
| `investigation.delete` | any | privileged | `services/api/src/investigations/investigation-service.ts` | Investigation status, delete and restore are privileged (TAS section 10): the event commits with the change and fails with it. |
| `investigation.purge` | any | privileged | `services/api/src/jobs/maintenance.ts` | The retention job deletes investigations: a privileged deletion, written with it, and the export files are removed after the commit. |
| `investigation.reopen` | any | privileged | `services/api/src/investigations/status-change.ts` | Investigation status, delete and restore are privileged (TAS section 10): the event commits with the change and fails with it. |
| `investigation.restore` | any | privileged | `services/api/src/investigations/investigation-service.ts` | Investigation status, delete and restore are privileged (TAS section 10): the event commits with the change and fails with it. |
| `pattern.change` | any | queued | `services/api/src/patterns/pattern-events.ts`, `services/api/src/patterns/saved-pattern-service.ts` | A change of a saved pattern: committed first, its event queued with the history row. |
| `pattern.copy` | any | queued | `services/api/src/patterns/pattern-events.ts`, `services/api/src/patterns/saved-pattern-service.ts` | A change of a saved pattern: committed first, its event queued with the history row. |
| `pattern.count` | any | queued | `services/api/src/gate/templates/pattern-count.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `pattern.delete` | any | queued | `services/api/src/patterns/pattern-events.ts`, `services/api/src/patterns/saved-pattern-service.ts` | A change of a saved pattern: committed first, its event queued with the history row. |
| `pattern.list` | any | queued | `services/api/src/patterns/saved-pattern-service.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `pattern.preview` | any | queued | `services/api/src/patterns/preview-service.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `pattern.purge` | any | privileged | `services/api/src/jobs/maintenance.ts` | The retention job deletes saved patterns: a privileged deletion, written with it. |
| `pattern.run` | any | queued | `services/api/src/gate/templates/pattern.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `pattern.save` | any | queued | `services/api/src/patterns/pattern-events.ts`, `services/api/src/patterns/saved-pattern-service.ts` | A change of a saved pattern: committed first, its event queued with the history row. |
| `pattern.share` | any | queued | `services/api/src/patterns/pattern-events.ts` | A change of a saved pattern: committed first, its event queued with the history row. |
| `pattern.unshare` | any | queued | `services/api/src/patterns/pattern-events.ts` | A change of a saved pattern: committed first, its event queued with the history row. |
| `pattern.validate` | any | queued | `services/api/src/patterns/validate-service.ts` | A change of a saved pattern: committed first, its event queued with the history row. |
| `source.capabilities` | any | queued | `services/api/src/gate/templates/capabilities.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.connectivity` | any | queued | `services/api/src/gate/templates/connectivity.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.degree_probe` | any | queued | `services/api/src/gate/templates/degree-probe.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.link` | any | queued | `services/api/src/source-links/source-link-service.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.privileges` | any | queued | `services/api/src/gate/templates/privileges.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.schema_draft_constraints` | any | queued | `services/api/src/gate/templates/schema-draft.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.schema_draft_indexes` | any | queued | `services/api/src/gate/templates/schema-draft.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.schema_draft_tokens` | any | queued | `services/api/src/gate/templates/schema-draft.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.schema_indexes` | any | queued | `services/api/src/gate/templates/schema-indexes.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.schema_tokens` | any | queued | `services/api/src/gate/templates/schema-tokens.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.stable_id_duplicates` | any | queued | `services/api/src/gate/templates/stable-id-duplicates.ts` | A read or a system read: the response does not depend on its event, which is queued. |
| `source.test` | any | queued | `services/api/src/app.ts` | A read or a system read: the response does not depend on its event, which is queued. |

## The end of an assistant turn

Each assistant turn that passes its first checks (the person may read the source and the investigation, the message is not empty) ends in one `assistant.turn.closed` event, whatever the end. Its detail holds the route (`ask`, `view` or `refuse`; absent when no route was reached), the outcome (`answered`, `refused`, `failed` or `cancelled`), a cause or failure kind as a code, the intent and template, the keyed hash of the parameters, the number of reads and of model calls, the number of elements its accepted summary cited, the model reference, prompt id and version, the instructions hash and the tokens of the router call; never a message, a reply, a value or an instruction. A count the turn does not have is absent, never 0. The result is `success` for an answered turn (`partial` for a partial result or a heavy stop), `refused` for a refused one, `failed` for a failed or cancelled one. The model call keeps its own `assistant.route` event. The model call's event, the Ask event (`assistant.ask`, `assistant.continue`) and the closing event carry the run id of the turn, the key to its stored record. If the closing event cannot be built it is not queued: the application counts it as a failed event in `GET /readyz` and logs its ids, and the answer is the same either way.

## Not events

The stored model-run records (`ask_runs`, `summary_runs`, `summary_run_calls`, `assistant_runs`, `assistant_run_calls`) and the history of a saved pattern (`pattern_events`) are records of what was done, not audit events. They are written through queues of their own, which `GET /readyz` counts with the audit events.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `NEBURYX_AUDIT_SINKS` | `postgres` | Where ordinary events go: `postgres` (the built-in store), `stdout` (one line of JSON for each event: its fields and the time it was written, for a log shipper or a SIEM) or both, separated by a comma. The events of privileged actions always go to the built-in store. The stored run records never go to stdout. |
| `NEBURYX_AUDIT_QUEUE_SIZE` | 1000 (1 to 100000) | How many events one sink's queue holds before it drops new ones. |
| `NEBURYX_AUDIT_RETRY_LIMIT` | 3 (0 to 10) | How many times a failed write is tried again. |
| `NEBURYX_AUDIT_RETRY_WAIT_MS` | 500 (10 to 60000) | The wait before the first retry, doubled for each later one. |
| `NEBURYX_AUDIT_WRITE_TIMEOUT_MS` | 5000 (100 to 60000) | How long one write may take before it counts as failed. |

The defaults of the four queue settings are provisional: they are to be measured from a burst of the product's own events and confirmed or replaced before a release. A setting outside its range, or not a whole number, stops the API at start and names the setting, not its value.

## What `GET /readyz` shows

The `audit` block counts, since the process started, the events written, failed (after their retries), dropped (the queue was full, or the process stopped first) and queued now, with the stored run records and the history of the patterns added in. It is information: it never changes the status of the probe, and the probe never waits for a sink.

## What a loss means

An event that is queued when the process stops, or dropped because its queue is full, is lost; a write that is tried again can repeat an event, so delivery is best effort. A stored run record can be lost the same way, so a model call can have no stored record. On a graceful stop the queues are given a few seconds to empty first.
