import type { AppStore } from '../app-store.js';
import { sourceTestReportSchema } from '@neburyx/contracts';
import type { PingStateChange, SourceCheck } from '../db/source-checks-repository.js';
import type { SourceRow } from '../db/sources-repository.js';
import type { Identity } from '../identity/identity.js';
import { validatedDraft, type CreatedInvestigation, type DraftRow, type InvestigationRow, type NewDraft, type NewInvestigation, type ReusableQuery, type StoredInvestigation } from '../db/investigations-repository.js';
import type { SourceModel } from '../mapping/model.js';

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
}

export interface MemoryAppStore extends AppStore {
  readonly checks: SourceCheck[];
  readonly investigations: InvestigationRow[];
  readonly drafts: (DraftRow & { readonly investigationId: string })[];
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
  const checks: SourceCheck[] = [];
  const investigations: InvestigationRow[] = [];
  const drafts: (DraftRow & { readonly investigationId: string })[] = [];
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
    markSourceUnchecked: (sourceId, reason) => {
      rows = rows.map((row) => (row.id === sourceId ? { ...row, state: 'unknown', stateReason: reason } : row));
      return Promise.resolve();
    },
    // Only the Postgres suite proves the identity rule and the rule that a fresher test wins; this double follows neither, so unit tests do not assert on them.
    applyPingState: (change: PingStateChange) => {
      if (options.failPingState === true) return Promise.reject(new Error('the state could not be written'));
      const row = rows.find((candidate) => candidate.id === change.sourceId);
      if (row === undefined) return Promise.resolve(false);
      const latest = [...checks].reverse().find((check) => check.report.sourceId === change.sourceId);
      const next = change.reachable
        ? { state: latest?.report.state ?? ('unknown' as const), stateReason: latest?.report.stateReason ?? null }
        : { state: 'unavailable' as const, stateReason: change.reason };
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
      drafts.push({ id: draft.id, version: 1, layout: draft.layout, queryContext: draft.queryContext, investigationId: input.id });
      return Promise.resolve({ row, created: true });
    },
    findReusableInvestigation: (query) => Promise.resolve(reusableOf(investigations, query)),
    readInvestigation: (id, ownerId): Promise<StoredInvestigation | undefined> => {
      const investigation = investigations.find((row) => row.id === id && row.ownerId === ownerId);
      const draft = drafts.find((candidate) => candidate.investigationId === id);
      return Promise.resolve(investigation === undefined || draft === undefined ? undefined : { investigation, draft });
    },
    readiness: () => Promise.resolve({ database: 'ok', migrations: 'ok' }),
    close: () => Promise.resolve(),
  };
}
