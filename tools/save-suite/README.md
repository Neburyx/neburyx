# tools/save-suite

Tests that a saved investigation comes back as it was left, end to end: the real API (the routes, the gate, an app store) on a loopback port, and the web's own client, draft sync and client state in front of it, in one process with the real `fetch`. Each case opens one or more tabs (a client state, a draft sync and a request log of its own) on one investigation.

| Command | Runs |
|---|---|
| `pnpm test` (from the root, or in this folder) | The cases over the in-memory app store and a scripted source. No server is needed. They run in CI. |
| `pnpm test:integration` (from the root) | Also the `*.integration.test.ts` files of this folder, over a real Postgres in a container: the cases that depend on what the database does (a write that races a write, the stored content hash and mapping hash, the purge date, the stored form of an odd identifier, the real `source rebind` command). Needs Docker. |
| `pnpm test:neo4j` (from the root) | Also the one case that reads by reference against the real adapter, on a database of its own (`restore.neo4j.test.ts`). Needs a Neo4j Enterprise server you own, as the other Neo4j tests do (see [`packages/test-neo4j`](../../packages/test-neo4j/README.md)); not in CI. |
| `pnpm test:ux` (from the root) | Also two browser cases in [`tools/ux`](../ux/README.md): `draft-reload.spec.ts` and `draft-conflict.spec.ts`. |

## How the web side runs in Node

The open flow reaches the draft sync through `draftSyncOf(state, client)`, which uses the real timers and the page events of `window`. The rig therefore fakes `setTimeout` and `clearTimeout` only, so the autosave delay passes when a case calls `advance`, and puts a small `window` with `addEventListener` in place so a case can fire `pagehide`. A request to the real API still completes under the fake timers: `rig.test.ts` shows it. What "the web shows" means here is client state: the loaded graph and its quality flags, the presentation (positions, pins, hidden items, layout, viewport, type filter), the mapping notice, the investigation record and the draft sync's status. What a person sees is proved in the two browser cases.

The source behind the gate is scripted (`World`): the entities and stored relationships a case names. Zero reads are counted at the source (`executor.calls`) and in the tab's requests (`sourceReads`).

## What the in-memory store is not

The in-memory store's clock advances one second a delete, so no purge date is ever reached; it never derives `mapping_hash`; it has no concurrent writer; it stores no `ON DELETE` rules. Each case where that matters runs again on real Postgres.

## Named tests

`named-tests.test.ts` fails if a test named here is not found in its file.

| What it proves | File | Test |
|---|---|---|
| A saved investigation reopens with its items, positions, pins, filters, layout and viewport exactly | `src/restore-exactness.test.ts` | restores the visible and hidden items, positions, pins, filters, layout and viewport exactly |
| The same on real Postgres, with the stored content hash | `src/pg-store.integration.test.ts` | comes back exactly in a fresh client |
| A named view restored into the draft gives back its state and its note | `src/restore-exactness.test.ts` | shows the state at the save and takes its note |
| Every kind of relationship a draft names comes back | `src/restore-exactness.test.ts` | restores an aggregate relationship with its member count |
| Items are read again by reference, in batches | `src/restore-exactness.test.ts` | is read again by reference |
| A page closed mid-investigation keeps the last change | `src/reload.test.ts` | writes the change made less than the autosave delay ago when the page is hidden |
| A reload never shows a partial draft | `src/reload.test.ts` | shows the last stored draft, never a partial one |
| The reload seen in a browser | `../ux/tests/draft-reload.spec.ts` | shows the same positions, pin and hidden entity after the page is loaded again |
| Two tabs never overwrite each other silently | `src/two-tabs.test.ts` | stores one, refuses the other with CONFLICTED_VIEW_VERSION |
| The same race on real Postgres | `src/pg-store.integration.test.ts` | stores exactly one and refuses the other |
| The conflict seen in a browser | `../ux/tests/draft-conflict.spec.ts` | shows the banner in the second tab |
| A close in another tab stops the other tab's writes | `src/read-only-join.test.ts` | refuses every write of the first tab with investigation-read-only |
| A named view's life, and its soft delete | `src/named-views.test.ts` | is left out of every read |
| A deleted view's note is in no response | `src/named-views.test.ts` | shows its deletion note and its id in no response |
| Close, archive and reopen | `src/lifecycle.test.ts` | refuses draft and view writes while |
| A deleted investigation restores until its purge date | `src/pg-purge.integration.test.ts` | restores with its draft and views as they were while its purge date is in the future |
| It is gone after its purge date | `src/pg-purge.integration.test.ts` | removes the investigation, its draft and its views when the purge task has run |
| A type removed from the mapping shows placeholders and the dropped-filter notice with no error | `src/mapping-change.test.ts` | shows a placeholder at the saved place for each unmapped item |
| The same on real Postgres, with the stored mapping hash | `src/pg-mapping.integration.test.ts` | shows the placeholders and the dropped-filter notice with no error |
| A re-pointed or removed source is read not at all | `src/source-change-layout.test.ts` | refuses a view save, rename, restore and delete |
| The rebind command opens it normally, with nothing read before | `../cancellation-suite/src/source-change.test.ts` | opens read-only on its saved layout with no read of any kind, and opens normally after the rebind |
| The real rebind command on real Postgres | `src/pg-odd.integration.test.ts` | makes no read of the source before the rebind and opens the investigation normally after it |
| Odd identifiers survive a save and a reopen | `src/round-trips.test.ts` | come back with their own ids |
| The same on real Postgres | `src/pg-odd.integration.test.ts` | are stored, read back and reopened as the person had them |
| Two entity types that share an id stay apart | `src/round-trips.test.ts` | keep their stored relationship apart |
| An export's header states the source, the time, that it is partial, the shown count and masking, in JSON | `src/export.test.ts` | holds what the canvas of the reopened investigation shows |
| The same header leads both files of a CSV export | `src/export.test.ts` | puts the same header lines at the top of both files of a CSV export |
| The not-retrieved line is a lower bound when only some entities were previewed | `src/export.test.ts` | states a lower bound |
| The not-retrieved line has no number when nothing was previewed | `src/export.test.ts` | states no number when nothing |
| The not-retrieved line states a counted figure, labelled estimated | `src/export.test.ts` | states a counted figure, as the previews counted it and labelled estimated |
| Masking states a count above zero in the file | `../../services/api/src/exports/file-format.test.ts` | says how many fields are masked |
| An export above the cap is refused with nothing written and nothing read | `src/export.test.ts` | through the web client, with the limits, no row, no file of any name and no read of the source |
| The cap boundary is accepted, and reads the source | `src/export.test.ts` | and reads the source to do it |
| A refusal needs a new key to retry | `src/export.test.ts` | keeps the refusal for its key, so the retry after it takes a new key |
| An export of a re-pointed or removed source is refused with no read | `src/export.test.ts` | is refused when the source was |
| An export made before a source change is refused on download, and stays refused after the real rebind command made the investigation available again, while a new export downloads | `src/pg-export.integration.test.ts` | even after the real rebind command |
| An export with no recorded source identity is refused on download | `src/pg-export.integration.test.ts` | refuses an export that has no recorded identity |
| Export is available on a closed and on an archived investigation | `src/export.test.ts` | is made and downloaded in a tab that shows the investigation |
| An expired export loses its file and is answered as unknown | `src/export.test.ts` | is cleared by the expiry task, which removes its file and marks its row expired |
| The same on real Postgres | `src/pg-export.integration.test.ts` | writes a row and a file for each export, and past its expiry the task removes the file |
| A deleted investigation's export is not found, and comes back when restored | `src/export.test.ts` | is not found while the investigation is deleted, keeps its file |
| The purge removes the rows and the files of its exports | `src/pg-export.integration.test.ts` | the purge removes their rows and their files with the investigation |
| Only the requester downloads | `../../services/api/src/exports/export-download.test.ts` | with one body for an unknown export |
| A changed access refuses the download | `../../services/api/src/exports/export-download.test.ts` | refuses with ACCESS_DENIED when the source is no longer authorized |
| Every route of the save families has a case | `src/routes.test.ts` | names each route a case drives or lists it with a reason |

Synthetic data only. Nothing here prints an address or a login.
