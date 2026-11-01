import type { AppStore } from '../app-store.js';
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
}

export function memoryAppStore(): AppStore {
  return memoryStoreWith({});
}

export function memoryStoreWith(options: MemoryAppStoreOptions): AppStore {
  let rows = options.sources ?? [];
  return {
    initialize: () => Promise.resolve(),
    current: () => Promise.resolve(LOCAL_IDENTITY),
    syncSources: (sources: readonly SourceModel[]) => {
      if (options.failSources === true) return Promise.reject(new Error('the sources could not be written'));
      rows = sources.map((source) => rows.find((row) => row.id === source.id) ?? { id: source.id, alias: source.id, state: 'unknown', stateReason: null, synthetic: source.synthetic });
      return Promise.resolve([]);
    },
    listSources: () => (options.failSources === true ? Promise.reject(new Error('the sources could not be read')) : Promise.resolve(rows)),
    readiness: () => Promise.resolve({ database: 'ok', migrations: 'ok' }),
    close: () => Promise.resolve(),
  };
}
