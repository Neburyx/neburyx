import { randomBytes } from 'node:crypto';
import type { AppStore } from '../app-store.js';
import { layoutDocumentSchema, queryContextDocumentSchema, sourceTestReportSchema, type LayoutDocument, type QueryContextDocument } from '@neburyx/contracts';
import type { PingStateChange, SourceCheck } from '../db/source-checks-repository.js';
import type { SourceRow } from '../db/sources-repository.js';
import type { Identity } from '../identity/identity.js';
import { readOnlyStatusOf } from '../investigations/read-only.js';
import { planStatusChange } from '../investigations/status-change.js';
import { validatedDraft, type DeleteResult, type RestoreResult, type CreatedInvestigation, type DraftRow, type DraftWriteResult, type StatusChangeResult, type TitleChangeResult, type InvestigationRow, type ListedInvestigation, type MatchQuery, type NewDraft, type NewInvestigation, type ReusableQuery, type StoredInvestigation } from '../db/investigations-repository.js';
import type { ViewDeleteResult, ViewListResult, ViewRenameResult, ViewRestoreResult, ViewSaveResult } from '../db/views-repository.js';
import type { SourceModel } from '../mapping/model.js';
import { decideSourceState, type StoredCheck } from '../source-state/decide.js';

export const LOCAL_IDENTITY: Identity = {
  principal: { id: '0192f000-0000-7000-8000-000000000001', displayName: 'Local workspace', role: 'administrator' },
  edition: 'community',
  identityMode: 'none',
};

export interface MemoryAppStoreOptions {
  readonly sources?: readonly SourceRow[];
  readonly failSources?: boolean;
  readonly inactiveSources?: readonly string[];
  readonly failRecording?: boolean;
  readonly failPingState?: boolean;
  readonly failChecks?: boolean;
  readonly failInvestigations?: boolean;
  readonly failStatusChange?: boolean;
  readonly failList?: boolean;
  readonly failCounts?: boolean;
  /** The identity hash each source row holds, by source ID; a source with no entry holds whatever hash is asked about. */
  readonly storedIdentityHashes?: Readonly<Record<string, string>>;
  readonly failRebind?: boolean;
}

export interface MemoryNamedView {
  readonly id: string;
  readonly investigationId: string;
  readonly name: string;
  readonly notes: string | null;
  readonly layout: LayoutDocument;
  readonly queryContext: QueryContextDocument;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly version: number;
  readonly deletedAt?: string;
  readonly deletionNote?: string | null;
}

export interface MemoryAppStore extends AppStore {
  readonly namedViews: MemoryNamedView[];
  readonly checks: SourceCheck[];
  readonly investigations: InvestigationRow[];
  readonly drafts: (DraftRow & { readonly investigationId: string; contentHash?: string })[];
}

function checkedDraft(draft: NewDraft): { readonly ok: true; readonly draft: NewDraft } | { readonly ok: false; readonly error: unknown } {
  try {
    return { ok: true, draft: validatedDraft(draft) };
  } catch (error) {
    return { ok: false, error };
  }
}

function reusableOf(investigations: readonly InvestigationRow[], query: ReusableQuery): InvestigationRow | undefined {
  return [...investigations]
    .reverse()
    .find((row) => row.ownerId === query.ownerId && row.sourceId === query.sourceId && row.caseRef === query.caseRef && row.startingEntityType === query.entityType && row.startingStableId === query.stableId && row.status === 'open');
}

export function memoryAppStore(): MemoryAppStore {
  return memoryStoreWith({});
}

export function memoryStoreWith(options: MemoryAppStoreOptions): MemoryAppStore {
  let rows = options.sources ?? [];
  let key: Buffer | undefined;
  const checks: SourceCheck[] = [];
  const storedChecksOf = (sourceId: string): StoredCheck[] =>
    checks
      .filter((check) => check.report.sourceId === sourceId)
      .map((check) => ({ id: check.id, checkedAt: check.report.checkedAt, identityHash: check.identityHash, configHash: check.configHash, reachedSource: check.report.server !== null, state: check.report.state, stateReason: check.report.stateReason }));
  let statusChanges = 0;
  const investigations: InvestigationRow[] = [];
  const drafts: (DraftRow & { readonly investigationId: string; contentHash?: string })[] = [];
  const namedViews: MemoryNamedView[] = [];
  const deletedAt = new Map<string, { readonly deletedAt: string; readonly purgeAfter: string }>();
  const liveOf = (id: string, ownerId: string): InvestigationRow | undefined => (deletedAt.has(id) ? undefined : investigations.find((row) => row.id === id && row.ownerId === ownerId));
  const isDeletedView = (view: MemoryNamedView): boolean => view.deletedAt !== undefined;
  let deletions = 0;
  return {
    checks,
    namedViews,
    investigations,
    drafts,
    initialize: () => Promise.resolve(),
    current: () => Promise.resolve(LOCAL_IDENTITY),
    syncSources: (sources: readonly SourceModel[]) => {
      if (options.failSources === true) return Promise.reject(new Error('the sources could not be written'));
      rows = sources.map((source) => rows.find((row) => row.id === source.id) ?? { id: source.id, alias: source.id, state: 'unknown', stateReason: null, synthetic: source.synthetic, lastTestAt: null });
      return Promise.resolve([]);
    },
    listSources: () => (options.failSources === true ? Promise.reject(new Error('the sources could not be read')) : Promise.resolve(rows)),
    hasActiveSource: (sourceId) => Promise.resolve(!(options.inactiveSources ?? []).includes(sourceId)),
    recordSourceCheck: (check) => {
      if (options.failRecording === true) return Promise.reject(new Error('the check could not be written'));
      checks.push({ ...check, report: sourceTestReportSchema.parse(check.report) });
      rows = rows.map((row) =>
        row.id === check.report.sourceId ? { ...row, state: check.report.state, stateReason: check.report.stateReason, lastTestAt: check.report.checkedAt } : row,
      );
      return Promise.resolve();
    },
    latestQualifyingChecks: (sources, since) =>
      Promise.resolve(
        sources.flatMap((source) => {
          const found = [...checks]
            .reverse()
            .find((check) => check.report.sourceId === source.id && check.identityHash === source.identityHash && check.configHash === source.configHash && check.report.checkedAt >= since && check.report.server !== null);
          return found === undefined ? [] : [{ sourceId: source.id, checkedAt: found.report.checkedAt, report: found.report }];
        }),
      ),
    latestChecksFor: (sources) =>
      options.failChecks === true
        ? Promise.reject(new Error('the checks could not be read'))
        : Promise.resolve(
        sources.flatMap((source) => {
          const found = [...checks].reverse().find((check) => check.report.sourceId === source.id && check.identityHash === source.identityHash && check.configHash === source.configHash);
          return found === undefined ? [] : [{ sourceId: source.id, checkedAt: found.report.checkedAt, report: found.report }];
        }),
      ),
    rebindSource: (sourceId, identityHash) => {
      if (options.failRebind === true) return Promise.reject(new Error('the investigations could not be written'));
      if ((options.inactiveSources ?? []).includes(sourceId) || !rows.some((row) => row.id === sourceId)) return Promise.resolve({ outcome: 'unknown-source' });
      if ((options.storedIdentityHashes?.[sourceId] ?? identityHash) !== identityHash) return Promise.resolve({ outcome: 'not-synced' });
      if (!checks.some((check) => check.report.sourceId === sourceId && check.identityHash === identityHash && check.report.server !== null)) return Promise.resolve({ outcome: 'not-tested' });
      let count = 0;
      for (const [index, row] of investigations.entries()) {
        if (row.sourceId === sourceId && row.sourceIdentityHash !== identityHash) {
          investigations[index] = { ...row, sourceIdentityHash: identityHash };
          count += 1;
        }
      }
      return Promise.resolve({ outcome: 'rebound', count });
    },
    markSourceUnchecked: (sourceId, reason, source) => {
      // the rule of the Postgres store: only when no check of any copy qualifies
      if (decideSourceState(storedChecksOf(sourceId), source).decidedBy === null) {
        rows = rows.map((row) => (row.id === sourceId ? { ...row, state: 'unknown', stateReason: reason } : row));
      }
      return Promise.resolve();
    },
    // Only the Postgres suite proves the rule that a fresher test wins over a ping; this double decides a reachable ping by the same rule as the Postgres store (the newest qualifying check) and an unreachable one by its sentence.
    applyPingState: (change: PingStateChange) => {
      if (options.failPingState === true) return Promise.reject(new Error('the state could not be written'));
      const row = rows.find((candidate) => candidate.id === change.sourceId);
      if (row === undefined) return Promise.resolve(false);
      const shown = decideSourceState(storedChecksOf(change.sourceId), { identityHash: change.identityHash, configHash: change.configHash });
      const next = change.reachable ? { state: shown.state as SourceRow['state'], stateReason: shown.stateReason } : { state: 'unavailable' as const, stateReason: change.reason };
      const changed = row.state !== next.state || row.stateReason !== next.stateReason;
      rows = rows.map((candidate) => (candidate.id === change.sourceId ? { ...candidate, ...next } : candidate));
      return Promise.resolve(changed);
    },
    createInvestigation: (input: NewInvestigation): Promise<CreatedInvestigation> => {
      if (options.failInvestigations === true) return Promise.reject(new Error('the investigation could not be written'));
      const checked = checkedDraft(input.draft);
      if (!checked.ok) return Promise.reject(checked.error);
      const draft = checked.draft;
      const reusable = input.caseRef === null ? undefined : reusableOf(investigations, { ownerId: input.ownerId, sourceId: input.sourceId, caseRef: input.caseRef, entityType: input.startingEntityType, stableId: input.startingStableId });
      if (reusable !== undefined) return Promise.resolve({ row: reusable, created: false });
      const now = new Date(Date.UTC(2026, 10, 5, 12, 0, investigations.length)).toISOString();
      const row: InvestigationRow = { id: input.id, sourceId: input.sourceId, sourceIdentityHash: input.sourceIdentityHash, ownerId: input.ownerId, title: input.title, caseRef: input.caseRef, startingEntityType: input.startingEntityType, startingStableId: input.startingStableId, status: 'open', createdAt: now, lastEditedAt: now, closedAt: null, archivedAt: null, version: 1 };
      investigations.push(row);
      drafts.push({ id: draft.id, version: 1, layout: draft.layout, queryContext: draft.queryContext, notes: null, mappingHash: draft.mappingHash, basedOnViewId: null, investigationId: input.id, contentHash: draft.contentHash });
      return Promise.resolve({ row, created: true });
    },
    findReusableInvestigation: (query) => Promise.resolve(reusableOf(investigations, query)),
    readInvestigation: (id, ownerId): Promise<StoredInvestigation | undefined> => {
      const investigation = liveOf(id, ownerId);
      const draft = drafts.find((candidate) => candidate.investigationId === id);
      const based = draft === undefined ? undefined : namedViews.find((view) => view.id === draft.basedOnViewId && view.investigationId === id && !isDeletedView(view));
      const savedAt = based !== undefined && draft?.contentHash === based.contentHash ? based.createdAt : null;
      return Promise.resolve(investigation === undefined || draft === undefined ? undefined : { investigation, draft: { ...draft, basedOnViewId: namedViews.some((view) => view.id === draft.basedOnViewId && isDeletedView(view)) ? null : draft.basedOnViewId }, savedAt });
    },
    saveDraft: (write): Promise<DraftWriteResult> => {
      const investigation = liveOf(write.investigationId, write.ownerId);
      const draft = drafts.find((candidate) => candidate.investigationId === write.investigationId);
      if (investigation === undefined || draft === undefined) return Promise.resolve({ outcome: 'not-found' });
      const readOnly = readOnlyStatusOf(investigation.status);
      if (readOnly !== undefined) return Promise.resolve({ outcome: 'read-only', status: readOnly });
      if (draft.version !== write.expectedVersion) return Promise.resolve({ outcome: 'conflict' });
      const contentHash = write.contentHashOf({ aiNotes: null });
      if (contentHash === draft.contentHash && draft.mappingHash === write.mappingHash) return Promise.resolve({ outcome: 'unchanged', version: draft.version, save: { state: 'unsaved', savedAt: null } });
      if (contentHash === draft.contentHash) {
        drafts[drafts.indexOf(draft)] = { ...draft, version: draft.version + 1, mappingHash: write.mappingHash };
        return Promise.resolve({ outcome: 'saved', version: draft.version + 1, save: { state: 'unsaved', savedAt: null } });
      }
      const saved = { ...draft, version: draft.version + 1, layout: write.layout, queryContext: write.queryContext, notes: write.notes, mappingHash: write.mappingHash, contentHash };
      drafts[drafts.indexOf(draft)] = saved;
      investigations[investigations.indexOf(investigation)] = { ...investigation, lastEditedAt: new Date(Date.parse(investigation.lastEditedAt) + 1000).toISOString() };
      return Promise.resolve({ outcome: 'saved', version: saved.version, save: { state: 'unsaved', savedAt: null } });
    },
    renameInvestigation: (change): Promise<TitleChangeResult> => {
      const held = liveOf(change.investigationId, change.ownerId);
      if (held === undefined) return Promise.resolve({ outcome: 'not-found' });
      const readOnly = readOnlyStatusOf(held.status);
      if (readOnly !== undefined) return Promise.resolve({ outcome: 'read-only', status: readOnly });
      if (held.version !== change.expectedVersion) return Promise.resolve({ outcome: 'conflict' });
      if (held.title === change.title) return Promise.resolve({ outcome: 'unchanged', row: held });
      const row = { ...held, title: change.title, version: held.version + 1 };
      investigations[investigations.indexOf(held)] = row;
      return Promise.resolve({ outcome: 'renamed', row });
    },
    changeInvestigationStatus: async (change): Promise<StatusChangeResult> => {
      const held = liveOf(change.investigationId, change.ownerId);
      if (held === undefined) return { outcome: 'not-found' };
      const plan = planStatusChange(held.status, change.status);
      if (plan === 'unchanged') return { outcome: 'unchanged', row: held };
      if (held.version !== change.expectedVersion) return { outcome: 'conflict' };
      if (plan === 'not-allowed') return { outcome: 'not-allowed' };
      const now = new Date(Date.UTC(2026, 10, 6, 12, 0, statusChanges++)).toISOString();
      const timeOf = (rule: 'keep' | 'now' | 'clear', kept: string | null) => (rule === 'keep' ? kept : rule === 'now' ? now : null);
      if (options.failStatusChange === true) throw new Error('the status could not be written');
      const row: InvestigationRow = { ...held, status: change.status, closedAt: timeOf(plan.closedAt, held.closedAt), archivedAt: timeOf(plan.archivedAt, held.archivedAt), version: held.version + 1 };
      investigations[investigations.indexOf(held)] = row;
      return { outcome: 'changed', row };
    },
    saveNamedView: (save): Promise<ViewSaveResult> => {
      const investigation = liveOf(save.investigationId, save.ownerId);
      const draft = drafts.find((candidate) => candidate.investigationId === save.investigationId);
      if (investigation === undefined || draft === undefined) return Promise.resolve({ outcome: 'not-found' });
      const frozen = readOnlyStatusOf(investigation.status);
      if (frozen !== undefined) return Promise.resolve({ outcome: 'read-only', status: frozen });
      if (draft.version !== save.expectedDraftVersion) return Promise.resolve({ outcome: 'draft-conflict' });
      if (save.title !== undefined && investigation.version !== save.title.expectedInvestigationVersion) return Promise.resolve({ outcome: 'investigation-conflict' });
      const layout = layoutDocumentSchema.parse(draft.layout);
      const queryContext = queryContextDocumentSchema.parse(draft.queryContext);
      const contentHash = save.contentHashOf({ layout, queryContext, aiNotes: null });
      const createdAt = new Date(Date.UTC(2026, 10, 5, 13, 0, namedViews.length)).toISOString();
      namedViews.push({ id: save.viewId, investigationId: save.investigationId, name: save.name, notes: save.notes, layout, queryContext, contentHash, createdAt, version: 1 });
      drafts[drafts.indexOf(draft)] = { ...draft, version: draft.version + 1, notes: save.notes, basedOnViewId: save.viewId, contentHash };
      const changed = { ...investigation, lastEditedAt: new Date(Date.parse(investigation.lastEditedAt) + 1000).toISOString(), ...(save.title === undefined ? {} : { title: save.title.value, version: investigation.version + 1 }) };
      investigations[investigations.indexOf(investigation)] = changed;
      return Promise.resolve({
        outcome: 'saved',
        view: { id: save.viewId, name: save.name, notes: save.notes, savedBy: { name: LOCAL_IDENTITY.principal.displayName }, createdAt, version: 1 },
        draft: { version: draft.version + 1, notes: save.notes, basedOnViewId: save.viewId },
        save: { state: 'saved', savedAt: createdAt },
        investigation: save.title === undefined ? undefined : { title: changed.title, version: changed.version },
      });
    },
    listNamedViews: (query): Promise<ViewListResult> => {
      const investigation = liveOf(query.investigationId, query.ownerId);
      const draft = drafts.find((candidate) => candidate.investigationId === query.investigationId);
      if (investigation === undefined || draft === undefined) return Promise.resolve({ outcome: 'not-found' });
      const keyOf = (view: MemoryNamedView): string => `${view.createdAt.slice(0, -1)}000Z`;
      const all = namedViews.filter((view) => view.investigationId === query.investigationId && !isDeletedView(view)).sort((left, right) => (keyOf(left) === keyOf(right) ? (left.id < right.id ? 1 : -1) : keyOf(left) < keyOf(right) ? 1 : -1));
      const after = query.after;
      const rest = after === undefined ? all : all.filter((view) => keyOf(view) < after.createdKey || (keyOf(view) === after.createdKey && view.id < after.id));
      const page = rest.slice(0, query.limit);
      const last = page.at(-1);
      return Promise.resolve({
        outcome: 'listed',
        items: page.map((view) => ({ id: view.id, name: view.name, notes: view.notes, savedBy: { name: LOCAL_IDENTITY.principal.displayName }, createdAt: view.createdAt, version: view.version })),
        next: rest.length > query.limit && last !== undefined ? { createdKey: keyOf(last), id: last.id } : undefined,
        count: all.length,
        draft: { basedOnViewId: all.some((view) => view.id === draft.basedOnViewId) ? draft.basedOnViewId : null, updatedAt: investigation.lastEditedAt },
      });
    },
    listOwnedViews: (query) => {
      const keyOf = (view: MemoryNamedView): string => `${view.createdAt.slice(0, -1)}000Z`;
      const owned = namedViews
        .filter((view) => !isDeletedView(view))
        .flatMap((view) => {
          const investigation = investigations.find((row) => !deletedAt.has(row.id) && row.id === view.investigationId && row.ownerId === query.ownerId && query.sourceIds.includes(row.sourceId));
          return investigation === undefined ? [] : [{ view, investigation }];
        })
        .sort((left, right) => (keyOf(left.view) === keyOf(right.view) ? (left.view.id < right.view.id ? 1 : -1) : keyOf(left.view) < keyOf(right.view) ? 1 : -1));
      const after = query.after;
      const rest = after === undefined ? owned : owned.filter(({ view }) => keyOf(view) < after.createdKey || (keyOf(view) === after.createdKey && view.id < after.id));
      const page = rest.slice(0, query.limit);
      const last = page.at(-1);
      return Promise.resolve({
        items: page.map(({ view, investigation }) => ({
          id: view.id,
          name: view.name,
          createdAt: view.createdAt,
          createdKey: keyOf(view),
          version: view.version,
          savedByName: LOCAL_IDENTITY.principal.displayName,
          investigation: { id: investigation.id, title: investigation.title, sourceId: investigation.sourceId, sourceAlias: rows.find((source) => source.id === investigation.sourceId)?.alias ?? investigation.sourceId, status: investigation.status, startingEntityType: investigation.startingEntityType, startingStableId: investigation.startingStableId },
        })),
        next: rest.length > query.limit && last !== undefined ? { createdKey: keyOf(last.view), id: last.view.id } : undefined,
        count: owned.length,
      });
    },
    renameNamedView: (rename): Promise<ViewRenameResult> => {
      const investigation = liveOf(rename.investigationId, rename.ownerId);
      const view = namedViews.find((candidate) => candidate.id === rename.viewId && candidate.investigationId === rename.investigationId && !isDeletedView(candidate));
      if (investigation === undefined || view === undefined) return Promise.resolve({ outcome: 'not-found' });
      const frozen = readOnlyStatusOf(investigation.status);
      if (frozen !== undefined) return Promise.resolve({ outcome: 'read-only', status: frozen });
      if (view.version !== rename.expectedVersion) return Promise.resolve({ outcome: 'conflict' });
      const renamed = { ...view, name: rename.name, version: view.version + 1 };
      namedViews[namedViews.indexOf(view)] = renamed;
      return Promise.resolve({ outcome: 'renamed', view: { id: renamed.id, name: renamed.name, notes: renamed.notes, savedBy: { name: LOCAL_IDENTITY.principal.displayName }, createdAt: renamed.createdAt, version: renamed.version } });
    },
    restoreNamedView: (restore): Promise<ViewRestoreResult> => {
      const investigation = liveOf(restore.investigationId, restore.ownerId);
      const draft = drafts.find((candidate) => candidate.investigationId === restore.investigationId);
      const view = namedViews.find((candidate) => candidate.id === restore.viewId && candidate.investigationId === restore.investigationId && !isDeletedView(candidate));
      if (investigation === undefined || draft === undefined || view === undefined) return Promise.resolve({ outcome: 'not-found' });
      const frozen = readOnlyStatusOf(investigation.status);
      if (frozen !== undefined) return Promise.resolve({ outcome: 'read-only', status: frozen });
      if (draft.version !== restore.expectedDraftVersion) return Promise.resolve({ outcome: 'draft-conflict' });
      drafts[drafts.indexOf(draft)] = { ...draft, version: draft.version + 1, layout: view.layout, queryContext: view.queryContext, notes: view.notes, basedOnViewId: view.id, contentHash: view.contentHash };
      if (draft.contentHash !== view.contentHash) investigations[investigations.indexOf(investigation)] = { ...investigation, lastEditedAt: new Date(Date.parse(investigation.lastEditedAt) + 1000).toISOString() };
      return Promise.resolve({ outcome: 'restored', savedAt: view.createdAt, draft: { version: draft.version + 1, layout: view.layout, queryContext: view.queryContext, notes: view.notes, basedOnViewId: view.id } });
    },
    purgeExpiredInvestigations: async (beforeDelete) => {
      const expired = investigations.filter((row) => (deletedAt.get(row.id)?.purgeAfter ?? '9999') <= new Date(Date.UTC(2026, 10, 7, 12, 0, deletions)).toISOString());
      for (const row of expired) {
        await beforeDelete({ id: row.id, sourceId: row.sourceId });
        investigations.splice(investigations.indexOf(row), 1);
        deletedAt.delete(row.id);
        drafts.splice(0, drafts.length, ...drafts.filter((draft) => draft.investigationId !== row.id));
        namedViews.splice(0, namedViews.length, ...namedViews.filter((view) => view.investigationId !== row.id));
      }
      return expired.length;
    },
    deleteNamedView: (deletion): Promise<ViewDeleteResult> => {
      const investigation = liveOf(deletion.investigationId, deletion.ownerId);
      const view = namedViews.find((candidate) => candidate.id === deletion.viewId && candidate.investigationId === deletion.investigationId && !isDeletedView(candidate));
      const draft = drafts.find((candidate) => candidate.investigationId === deletion.investigationId);
      if (investigation === undefined || view === undefined || draft === undefined) return Promise.resolve({ outcome: 'not-found' });
      const frozen = readOnlyStatusOf(investigation.status);
      if (frozen !== undefined) return Promise.resolve({ outcome: 'read-only', status: frozen });
      if (view.version !== deletion.expectedVersion) return Promise.resolve({ outcome: 'conflict' });
      const when = new Date(Date.UTC(2026, 10, 7, 12, 0, deletions++)).toISOString();
      const marked = { ...view, version: view.version + 1, deletedAt: when, deletionNote: deletion.note };
      namedViews[namedViews.indexOf(view)] = marked;
      const based = namedViews.find((candidate) => candidate.id === draft.basedOnViewId && !isDeletedView(candidate));
      const saved = based !== undefined && based.contentHash === draft.contentHash;
      return Promise.resolve({
        outcome: 'deleted',
        id: view.id,
        version: marked.version,
        deletedAt: when,
        draft: { version: draft.version, basedOnViewId: based?.id ?? null },
        save: saved && based !== undefined ? { state: 'saved', savedAt: based.createdAt } : { state: 'unsaved', savedAt: null },
        count: namedViews.filter((candidate) => candidate.investigationId === deletion.investigationId && !isDeletedView(candidate)).length,
      });
    },
    deleteInvestigation: async (change): Promise<DeleteResult> => {
      const held = liveOf(change.investigationId, change.ownerId);
      if (held === undefined) return { outcome: 'not-found' };
      if (held.version !== change.expectedVersion) return { outcome: 'conflict' };
      const at = new Date(Date.UTC(2026, 10, 7, 12, 0, deletions++));
      const row = { ...held, version: held.version + 1 };
      await change.beforeCommit(row);
      const purgeAfter = new Date(at.getTime() + change.retentionDays * 86_400_000);
      investigations[investigations.indexOf(held)] = row;
      deletedAt.set(held.id, { deletedAt: at.toISOString(), purgeAfter: purgeAfter.toISOString() });
      return { outcome: 'deleted', row, deletedAt: at.toISOString(), purgeAfter: purgeAfter.toISOString() };
    },
    restoreInvestigation: async (change): Promise<RestoreResult> => {
      const held = investigations.find((row) => row.id === change.investigationId && row.ownerId === change.ownerId);
      const marks = deletedAt.get(change.investigationId);
      if (held === undefined || marks === undefined || marks.purgeAfter <= new Date(Date.UTC(2026, 10, 7, 12, 0, deletions)).toISOString()) return { outcome: 'not-found' };
      if (held.version !== change.expectedVersion) return { outcome: 'conflict' };
      const row = { ...held, version: held.version + 1 };
      await change.beforeCommit(row);
      investigations[investigations.indexOf(held)] = row;
      deletedAt.delete(held.id);
      return { outcome: 'restored', row };
    },
    // The double has no named views: every draft is unsaved. The Postgres suite proves the saved rule.
    readLibrary: (read) => {
      const snapshot = investigations.filter((row) => !deletedAt.has(row.id));
      const matching = (query: MatchQuery): InvestigationRow[] => {
        const fragment = query.text?.toLowerCase();
        return snapshot.filter(
          (row) =>
            row.ownerId === query.ownerId &&
            row.status === query.status &&
            query.sourceIds.includes(row.sourceId) &&
            (query.sourceId === undefined || row.sourceId === query.sourceId) &&
            (fragment === undefined || row.title.toLowerCase().includes(fragment) || (row.caseRef?.toLowerCase().includes(fragment) ?? false)),
        );
      };
      return read({
        listInvestigationSourceIds: (ownerId) => {
          if (options.failList === true) return Promise.reject(new Error('the investigations could not be read'));
          return Promise.resolve([...new Set(snapshot.filter((row) => row.ownerId === ownerId).map((row) => row.sourceId))]);
        },
        listInvestigations: (query) => {
          if (options.failList === true) return Promise.reject(new Error('the investigations could not be read'));
          const keyOf = (row: InvestigationRow): string => `${row.lastEditedAt.slice(0, -1)}000Z`;
          const after = query.after;
          const listed: ListedInvestigation[] = matching(query)
            .map((row) => ({ ...row, sourceAlias: rows.find((source) => source.id === row.sourceId)?.alias ?? row.sourceId, save: { state: 'unsaved' as const, savedAt: null }, nodeCount: 0, edgeCount: 0, countsPolicyVersion: 'none', lastEditedKey: keyOf(row) }))
            .sort((left, right) => (left.lastEditedKey < right.lastEditedKey ? 1 : left.lastEditedKey > right.lastEditedKey ? -1 : left.id < right.id ? 1 : -1))
            .filter((row) => after === undefined || row.lastEditedKey < after.editedKey || (row.lastEditedKey === after.editedKey && row.id < after.id));
          return Promise.resolve(listed.slice(0, query.limit));
        },
        countMatching: (query) => Promise.resolve(matching(query).length),
        countInvestigations: (query) => {
          if (options.failCounts === true) return Promise.reject(new Error('the counts could not be read'));
          const counted = snapshot.filter((row) => row.ownerId === query.ownerId && row.status === 'open' && query.sourceIds.includes(row.sourceId));
          return Promise.resolve({ investigations: counted.length, sources: new Set(counted.map((row) => row.sourceId)).size });
        },
        countNamedViews: () => {
          if (options.failCounts === true) return Promise.reject(new Error('the counts could not be read'));
          return Promise.resolve({ views: 0, lastEditedAt: null });
        },
        listDeletedInvestigationSourceIds: (ownerId) => Promise.resolve([...new Set(investigations.filter((row) => row.ownerId === ownerId && deletedAt.has(row.id)).map((row) => row.sourceId))]),
        listDeletedInvestigations: (query) => {
          const fragment = query.text?.toLowerCase();
          const listed: ListedInvestigation[] = investigations
            .flatMap((row) => {
              const marks = deletedAt.get(row.id);
              return marks === undefined || row.ownerId !== query.ownerId || !query.sourceIds.includes(row.sourceId) || (query.sourceId !== undefined && row.sourceId !== query.sourceId) || (fragment !== undefined && !row.title.toLowerCase().includes(fragment) && !(row.caseRef?.toLowerCase().includes(fragment) ?? false)) ? [] : [{ row, marks }];
            })
            .map(({ row, marks }) => ({ ...row, deletedAt: marks.deletedAt, purgeAfter: marks.purgeAfter, sourceAlias: rows.find((source) => source.id === row.sourceId)?.alias ?? row.sourceId, save: { state: 'unsaved' as const, savedAt: null }, nodeCount: 0, edgeCount: 0, countsPolicyVersion: 'none', lastEditedKey: `${marks.deletedAt.slice(0, -1)}000Z` }))
            .sort((left, right) => (left.lastEditedKey < right.lastEditedKey ? 1 : left.lastEditedKey > right.lastEditedKey ? -1 : left.id < right.id ? 1 : -1))
            .filter((row) => query.after === undefined || row.lastEditedKey < query.after.editedKey || (row.lastEditedKey === query.after.editedKey && row.id < query.after.id));
          return Promise.resolve(listed.slice(0, query.limit));
        },
        countDeletedMatching: (query) => {
          const fragment = query.text?.toLowerCase();
          return Promise.resolve(investigations.filter((row) => deletedAt.has(row.id) && row.ownerId === query.ownerId && query.sourceIds.includes(row.sourceId) && (query.sourceId === undefined || row.sourceId === query.sourceId) && (fragment === undefined || row.title.toLowerCase().includes(fragment) || (row.caseRef?.toLowerCase().includes(fragment) ?? false))).length);
        },
      });
    },
    readiness: () => Promise.resolve({ database: 'ok', migrations: 'ok' }),
    referenceKey: () => Promise.resolve((key ??= randomBytes(32))),
    close: () => Promise.resolve(),
  };
}
