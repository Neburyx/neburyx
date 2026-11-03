import type { EdgeRef, ElementRef } from '@neburyx/contracts';
import { z } from 'zod';
import { StateError } from './errors.js';
import { sourcesOfEdgeRef, type QueryKey } from './keys.js';
import { createStore, readable, type ReadableStore } from './store.js';

/** Where the investigation stands on saving; `at` is the time of the last save, an ISO-8601 UTC string. */
export type SaveState = { readonly kind: 'saved'; readonly at: string } | { readonly kind: 'unsaved' };

export interface InvestigationRecord {
  readonly title: string;
  readonly caseRef: string | null;
  readonly save: SaveState;
}

export interface InvestigationState {
  readonly sourceId: string | null;
  readonly record: InvestigationRecord | null;
  readonly resultKeys: readonly QueryKey[];
  readonly nodeRefs: readonly ElementRef[];
  readonly edgeRefs: readonly EdgeRef[];
}

export interface InvestigationStore {
  readonly view: ReadableStore<InvestigationState>;
  bind(sourceId: string): void;
  describe(record: InvestigationRecord | null): void;
  setLoaded(resultKeys: readonly QueryKey[], nodeRefs: readonly ElementRef[], edgeRefs: readonly EdgeRef[]): void;
}

const SAVED_AT = z.string().datetime({ offset: true });

const UNBOUND: InvestigationState = { sourceId: null, record: null, resultKeys: [], nodeRefs: [], edgeRefs: [] };

export function createInvestigationStore(): InvestigationStore {
  const store = createStore<InvestigationState>(UNBOUND);
  return {
    view: readable(store),
    bind(sourceId) {
      if (store.getState().sourceId === sourceId) return;
      store.setState({ ...UNBOUND, sourceId });
    },
    describe(record) {
      const current = store.getState();
      if (current.sourceId === null) throw new StateError('NO_SOURCE_BOUND');
      if (record?.save.kind !== 'saved') {
        store.setState({ ...current, record });
        return;
      }
      const { at } = record.save;
      if (!SAVED_AT.safeParse(at).success) throw new StateError('INVALID_TIME');
      store.setState({ ...current, record: { ...record, save: { kind: 'saved', at: new Date(at).toISOString() } } });
    },
    setLoaded(resultKeys, nodeRefs, edgeRefs) {
      const { sourceId, record } = store.getState();
      if (sourceId === null) throw new StateError('NO_SOURCE_BOUND');
      const named = [...resultKeys.map((key) => key.sourceId), ...nodeRefs.map((ref) => ref.sourceId), ...edgeRefs.flatMap(sourcesOfEdgeRef)];
      if (named.some((name) => name !== sourceId)) throw new StateError('SOURCE_MISMATCH');
      store.setState({ sourceId, record, resultKeys, nodeRefs, edgeRefs });
    },
  };
}
