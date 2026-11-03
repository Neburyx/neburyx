import type { EdgeRef, ElementRef } from '@neburyx/contracts';
import { StateError } from './errors.js';
import { sourcesOfEdgeRef, type QueryKey } from './keys.js';
import { createStore, readable, type ReadableStore } from './store.js';

export interface InvestigationState {
  readonly sourceId: string | null;
  readonly resultKeys: readonly QueryKey[];
  readonly nodeRefs: readonly ElementRef[];
  readonly edgeRefs: readonly EdgeRef[];
}

export interface InvestigationStore {
  readonly view: ReadableStore<InvestigationState>;
  bind(sourceId: string): void;
  setLoaded(resultKeys: readonly QueryKey[], nodeRefs: readonly ElementRef[], edgeRefs: readonly EdgeRef[]): void;
}

const UNBOUND: InvestigationState = { sourceId: null, resultKeys: [], nodeRefs: [], edgeRefs: [] };

export function createInvestigationStore(): InvestigationStore {
  const store = createStore<InvestigationState>(UNBOUND);
  return {
    view: readable(store),
    bind(sourceId) {
      if (store.getState().sourceId === sourceId) return;
      store.setState({ ...UNBOUND, sourceId });
    },
    setLoaded(resultKeys, nodeRefs, edgeRefs) {
      const { sourceId } = store.getState();
      if (sourceId === null) throw new StateError('NO_SOURCE_BOUND');
      const named = [...resultKeys.map((key) => key.sourceId), ...nodeRefs.map((ref) => ref.sourceId), ...edgeRefs.flatMap(sourcesOfEdgeRef)];
      if (named.some((name) => name !== sourceId)) throw new StateError('SOURCE_MISMATCH');
      store.setState({ sourceId, resultKeys, nodeRefs, edgeRefs });
    },
  };
}
