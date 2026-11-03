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
}

export function createServerStore(): ServerStore {
  const store = createStore<ServerState>({ results: new Map() });
  return {
    view: readable(store),
    put(key, result) {
      const named = [...result.nodes.flatMap(sourcesOfNode), ...result.edges.flatMap(sourcesOfEdge)];
      if (key.sourceId !== result.sourceId || named.some((sourceId) => sourceId !== result.sourceId)) throw new StateError('SOURCE_MISMATCH');
      store.setState({ results: new Map(store.getState().results).set(queryKeyText(key), result) });
    },
    get: (key) => store.getState().results.get(queryKeyText(key)),
    dropSource(sourceId) {
      const kept = [...store.getState().results].filter(([, result]) => result.sourceId !== sourceId);
      if (kept.length !== store.getState().results.size) store.setState({ results: new Map(kept) });
    },
  };
}
