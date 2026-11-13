import { useMemo, useState } from 'react';
import type { GraphNode } from '@neburyx/contracts';
import { useLoadedGraph } from '../../state/context.js';
import { elementKey } from '../../state/keys.js';
import { useStoreSelector } from '../../state/store.js';
import { useClientState } from '../../state/context.js';

export interface StartEntity {
  readonly candidates: readonly GraphNode[];
  /** The person's choice, else the one selected entity of the type, else the entity the investigation was opened on when it is of the type and loaded. */
  readonly anchor: GraphNode | undefined;
  readonly choose: (node: GraphNode) => void;
}

/** The starting entity of a pattern, taken as the preset form takes it: chosen, selected, or the one the investigation was opened on. */
export function useStartEntity(anchorType: string | undefined): StartEntity {
  const state = useClientState();
  const graph = useLoadedGraph();
  const selection = useStoreSelector(state.presentation.view, (view) => view.selection);
  const startingEntity = useStoreSelector(state.investigation, (investigation) => investigation.record?.startingEntity);
  const [chosen, setChosen] = useState<GraphNode | undefined>(undefined);
  const candidates = useMemo(() => {
    const ofType = graph.nodes.filter((node) => node.ref.entityType === anchorType);
    return [...ofType.filter((node) => selection.has(elementKey(node.ref))), ...ofType.filter((node) => !selection.has(elementKey(node.ref)))];
  }, [graph, anchorType, selection]);
  const selected = candidates.filter((node) => selection.has(elementKey(node.ref)));
  const opened = startingEntity === null || startingEntity === undefined ? undefined : candidates.find((node) => node.ref.entityType === startingEntity.entityType && node.ref.stableId === startingEntity.stableId);
  const anchor = chosen !== undefined && chosen.ref.entityType === anchorType ? chosen : selected.length === 1 ? selected[0] : opened;
  return { candidates, anchor, choose: setChosen };
}
