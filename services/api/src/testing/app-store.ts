import { randomBytes } from 'node:crypto';
import type { AppStore } from '../app-store.js';
import { sourceTestReportSchema } from '@neburyx/contracts';
import type { PingStateChange, SourceCheck } from '../db/source-checks-repository.js';
import type { SourceRow } from '../db/sources-repository.js';
import type { Identity } from '../identity/identity.js';
import { validatedDraft, type CreatedInvestigation, type DraftRow, type DraftWriteResult, type InvestigationRow, type ListedInvestigation, type NewDraft, type NewInvestigation, type ReusableQuery, type StoredInvestigation } from '../db/investigations-repository.js';
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
  readonly failList?: boolean;
  readonly failCounts?: boolean;
}

export interface MemoryAppStore extends AppStore {
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
  const investigations: InvestigationRow[] = [];
  const drafts: (DraftRow & { readonly investigationId: string; contentHash?: string })[] = [];
  return {
    checks,
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
      const row: InvestigationRow = { id: input.id, sourceId: input.sourceId, sourceIdentityHash: input.sourceIdentityHash, ownerId: input.ownerId, title: input.title, caseRef: input.caseRef, startingEntityType: input.startingEntityType, startingStableId: input.startingStableId, status: 'open', createdAt: now, lastEditedAt: now, version: 1 };
      investigations.push(row);
      drafts.push({ id: draft.id, version: 1, layout: draft.layout, queryContext: draft.queryContext, notes: null, investigationId: input.id, contentHash: draft.contentHash });
      return Promise.resolve({ row, created: true });
    },
    findReusableInvestigation: (query) => Promise.resolve(reusableOf(investigations, query)),
    readInvestigation: (id, ownerId): Promise<StoredInvestigation | undefined> => {
      const investigation = investigations.find((row) => row.id === id && row.ownerId === ownerId);
      const draft = drafts.find((candidate) => candidate.investigationId === id);
      return Promise.resolve(investigation === undefined || draft === undefined ? undefined : { investigation, draft });
    },
    saveDraft: (write): Promise<DraftWriteResult> => {
      const investigation = investigations.find((row) => row.id === write.investigationId && row.ownerId === write.ownerId);
      const draft = drafts.find((candidate) => candidate.investigationId === write.investigationId);
      if (investigation === undefined || draft === undefined) return Promise.resolve({ outcome: 'not-found' });
      if (draft.version !== write.expectedVersion) return Promise.resolve({ outcome: 'conflict' });
      const contentHash = write.contentHashOf({ aiNotes: null });
      if (contentHash === draft.contentHash) return Promise.resolve({ outcome: 'unchanged', version: draft.version, save: { state: 'unsaved', savedAt: null } });
      const saved = { ...draft, version: draft.version + 1, layout: write.layout, queryContext: write.queryContext, notes: write.notes, contentHash };
      drafts[drafts.indexOf(draft)] = saved;
      investigations[investigations.indexOf(investigation)] = { ...investigation, lastEditedAt: new Date(Date.parse(investigation.lastEditedAt) + 1000).toISOString() };
      return Promise.resolve({ outcome: 'saved', version: saved.version, save: { state: 'unsaved', savedAt: null } });
    },
    // The double has no named views: every draft is unsaved. The Postgres suite proves the saved rule.
    readLibrary: (read) => {
      const snapshot = [...investigations];
      return read({
        listInvestigationSourceIds: (ownerId) => {
          if (options.failList === true) return Promise.reject(new Error('the investigations could not be read'));
          return Promise.resolve([...new Set(snapshot.filter((row) => row.ownerId === ownerId && row.status === 'open').map((row) => row.sourceId))]);
        },
        listInvestigations: (query) => {
          if (options.failList === true) return Promise.reject(new Error('the investigations could not be read'));
          const listed: ListedInvestigation[] = snapshot
            .filter((row) => row.ownerId === query.ownerId && row.status === 'open' && query.sourceIds.includes(row.sourceId))
            .map((row) => ({ ...row, sourceAlias: rows.find((source) => source.id === row.sourceId)?.alias ?? row.sourceId, save: { state: 'unsaved' as const, savedAt: null } }))
            .sort((left, right) => (left.lastEditedAt < right.lastEditedAt ? 1 : left.lastEditedAt > right.lastEditedAt ? -1 : left.id < right.id ? 1 : -1));
          return Promise.resolve(listed.slice(0, query.limit));
        },
        countInvestigations: (query) => {
          if (options.failCounts === true) return Promise.reject(new Error('the counts could not be read'));
          const counted = snapshot.filter((row) => row.ownerId === query.ownerId && row.status === 'open' && query.sourceIds.includes(row.sourceId));
          return Promise.resolve({ investigations: counted.length, sources: new Set(counted.map((row) => row.sourceId)).size });
        },
        countNamedViews: () => {
          if (options.failCounts === true) return Promise.reject(new Error('the counts could not be read'));
          return Promise.resolve({ views: 0, lastEditedAt: null });
        },
      });
    },
    readiness: () => Promise.resolve({ database: 'ok', migrations: 'ok' }),
    referenceKey: () => Promise.resolve((key ??= randomBytes(32))),
    close: () => Promise.resolve(),
  };
}
