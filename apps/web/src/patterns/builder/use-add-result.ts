import { useState } from 'react';
import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { useShellData, answeredData } from '../../shell/shell-data.js';
import { useClientState } from '../../state/context.js';
import { edgeKey, elementKey } from '../../state/keys.js';
import { isSourceChanged } from '../../state/investigation-state.js';
import { useStoreSelector } from '../../state/store.js';
import { useExpandStoreWhenProvided } from '../../workspace/expand-context.js';
import { addResultToGraph, type AddedOutcome } from '../add-to-graph.js';
import type { AddControl } from '../pattern-result.js';

export interface AddableAnswer {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface AddResult {
  readonly add: AddControl | undefined;
  /** What the last press added, while the answer it was pressed for is the one shown. */
  readonly added: AddedOutcome | undefined;
}

/** Add to graph for a result shown beside the canvas: on the canvas already, busy while a run is on its way, and merged through the merge of a preset result, under `keyPart`. It reads and writes nothing else. */
export function useAddResult(sourceId: string, shown: AddableAnswer | undefined, running: boolean, keyPart: string): AddResult {
  const state = useClientState();
  const shell = useShellData();
  const expansions = useExpandStoreWhenProvided();
  const principalId = answeredData(shell.me)?.principal.id;
  const sourceChanged = useStoreSelector(state.investigation, (investigation) => isSourceChanged(investigation.record?.sourceState));
  const [pressed, setPressed] = useState<{ readonly answer: object; readonly outcome: AddedOutcome } | undefined>(undefined);
  const allLoaded = useStoreSelector(state.investigation, (investigation) => {
    if (shown === undefined) return false;
    const nodes = new Set(investigation.nodeRefs.map(elementKey));
    const edges = new Set(investigation.edgeRefs.map(edgeKey));
    return shown.nodes.every((node) => nodes.has(elementKey(node.ref))) && shown.edges.every((edge) => edges.has(edgeKey(edge.ref)));
  });
  const add: AddControl | undefined =
    shown === undefined || sourceChanged || principalId === undefined
      ? undefined
      : {
          state: running ? 'running' : allLoaded ? 'onCanvas' : 'ready',
          disabled: running || allLoaded,
          onAdd: () => setPressed({ answer: shown, outcome: addResultToGraph(state, { nodes: shown.nodes, edges: shown.edges, keyPart }, { sourceId, principalId, expansions }) }),
        };
  return { add, added: pressed === undefined || pressed.answer !== shown ? undefined : pressed.outcome };
}
