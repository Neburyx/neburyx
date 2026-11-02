import type { AppStore } from '../app-store.js';
import { sourceTestReportSchema } from '@neburyx/contracts';
import type { PingStateChange, SourceCheck } from '../db/source-checks-repository.js';
import type { SourceRow } from '../db/sources-repository.js';
import type { Identity } from '../identity/identity.js';
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
}

export interface MemoryAppStore extends AppStore {
  readonly checks: SourceCheck[];
}

export function memoryAppStore(): MemoryAppStore {
  return memoryStoreWith({});
}

export function memoryStoreWith(options: MemoryAppStoreOptions): MemoryAppStore {
  let rows = options.sources ?? [];
  const checks: SourceCheck[] = [];
  return {
    checks,
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
    readiness: () => Promise.resolve({ database: 'ok', migrations: 'ok' }),
    close: () => Promise.resolve(),
  };
}
