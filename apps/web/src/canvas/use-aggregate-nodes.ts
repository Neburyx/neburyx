import { useMemo } from 'react';
import type { NodeExpansion } from '../api/expand-store.js';
import type { SourceProfile } from '@neburyx/contracts';
import { useSessionMask } from '../state/context.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { useStoreSelector, type ReadableStore } from '../state/store.js';
import { aggregateNodesOf, type AggregateNode } from '../workspace/aggregate-nodes.js';
import { neighborTypesOf, useExpandStoreWhenProvided } from '../workspace/expand-context.js';
import { usePreviewStoreWhenProvided } from '../workspace/preview-context.js';

const NO_EXPANSIONS: ReadonlyMap<string, NodeExpansion> = new Map();
const EMPTY_VIEW = { getState: () => NO_EXPANSIONS, subscribe: () => () => undefined } as const;
const NO_NODES: readonly AggregateNode[] = [];
const NONE_TOUCHED: ReadonlySet<string> = new Set();
const NOTHING = { getState: () => NONE_TOUCHED, subscribe: () => () => undefined } satisfies ReadableStore<ReadonlySet<string>>;
const NO_COUNT = { getState: () => 0, subscribe: () => () => undefined } satisfies ReadableStore<number>;

/** The aggregate nodes to draw for the loaded graph: from the previews already held and the expansions already asked, never from a request of their own. */
export function useAggregateNodes(graph: LoadedGraph, profile: SourceProfile | undefined): readonly AggregateNode[] {
  const expansions = useExpandStoreWhenProvided();
  const previews = usePreviewStoreWhenProvided();
  const mask = useSessionMask();
  const touched = useStoreSelector(expansions?.touched ?? NOTHING, (current) => current);
  const asked = useStoreSelector(expansions?.view ?? EMPTY_VIEW, (current) => current);
  const held = useStoreSelector(previews?.view ?? NO_COUNT, (current) => current);
  return useMemo(() => {
    if (expansions === undefined || previews === undefined || touched.size === 0) return NO_NODES;
    return aggregateNodesOf({ graph, profile, touched, previewOf: (ref) => previews.held(ref, mask), expansionOf: (ref) => expansions.of(ref), relTypesOf: (ref, type) => expansions.relTypesOf(ref, type), mapped: (entityType) => neighborTypesOf(profile, entityType) });
    // the maps and counters are what changes when a preview answers or an expansion moves
  }, [graph, profile, touched, mask, asked, held, expansions, previews]);
}

