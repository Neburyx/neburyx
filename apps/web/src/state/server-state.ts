import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { StateError } from './errors.js';
import { queryKeyText, sourcesOfEdge, sourcesOfNode, type QueryKey } from './keys.js';
import { createStore, readable, type ReadableStore } from './store.js';

export interface GraphResult {
  readonly sourceId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface ServerState {
  readonly results: ReadonlyMap<string, GraphResult>;
}

export interface ServerStore {
  readonly view: ReadableStore<ServerState>;
  put(key: QueryKey, result: GraphResult): void;
  get(key: QueryKey): GraphResult | undefined;
  dropSource(sourceId: string): void;
  /** Drops every result read with the other masking setting. */
  dropOtherMask(mask: boolean): void;
}

export function createServerStore(): ServerStore {
  const store = createStore<ServerState>({ results: new Map() });
  const masks = new Map<string, boolean>();
  return {
    view: readable(store),
    put(key, result) {
      const named = [...result.nodes.flatMap(sourcesOfNode), ...result.edges.flatMap(sourcesOfEdge)];
      if (key.sourceId !== result.sourceId || named.some((sourceId) => sourceId !== result.sourceId)) throw new StateError('SOURCE_MISMATCH');
      masks.set(queryKeyText(key), key.mask);
      store.setState({ results: new Map(store.getState().results).set(queryKeyText(key), result) });
    },
    get: (key) => store.getState().results.get(queryKeyText(key)),
    dropSource(sourceId) {
      const kept = [...store.getState().results].filter(([, result]) => result.sourceId !== sourceId);
      for (const text of [...masks.keys()]) if (!kept.some(([held]) => held === text)) masks.delete(text);
      if (kept.length !== store.getState().results.size) store.setState({ results: new Map(kept) });
    },
    dropOtherMask(mask) {
      const kept = [...store.getState().results].filter(([text]) => masks.get(text) === mask);
      for (const text of [...masks.keys()]) if (masks.get(text) !== mask) masks.delete(text);
      if (kept.length !== store.getState().results.size) store.setState({ results: new Map(kept) });
    },
  };
}
