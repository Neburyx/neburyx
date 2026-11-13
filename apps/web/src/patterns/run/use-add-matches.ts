import { useMemo, useState } from 'react';
import type { GraphEdge, GraphNode, PatternRunOk } from '@neburyx/contracts';
import { useShellData, answeredData } from '../../shell/shell-data.js';
import { useClientState } from '../../state/context.js';
import { edgeKey, elementKey } from '../../state/keys.js';
import { isSourceChanged } from '../../state/investigation-state.js';
import { useStoreSelector } from '../../state/store.js';
import { useExpandStoreWhenProvided } from '../../workspace/expand-context.js';
import { addResultToGraph, type AddedOutcome } from '../add-to-graph.js';

/** The entities and relationships of one match, or of a whole page: what an add merges. */
export interface Addable {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface AddResult {
  /** False while the source has changed under the investigation, or before the person is known: nothing can be added. */
  readonly canAdd: boolean;
  readonly running: boolean;
  readonly onGraph: (part: Addable) => boolean;
  readonly add: (part: Addable) => void;
  /** What the last press added, while the answer it was pressed for is the one shown. */
  readonly added: AddedOutcome | undefined;
}

/** Add to graph for the page shown beside the canvas, for one match or all of it: merged through the merge of a preset result, under the fixed word of a pattern built in the app. It reads and writes nothing else. */
export function useAddMatches(sourceId: string, shown: PatternRunOk | undefined, running: boolean): AddResult {
  const state = useClientState();
  const shell = useShellData();
  const expansions = useExpandStoreWhenProvided();
  const principalId = answeredData(shell.me)?.principal.id;
  const sourceChanged = useStoreSelector(state.investigation, (investigation) => isSourceChanged(investigation.record?.sourceState));
  const nodeRefs = useStoreSelector(state.investigation, (investigation) => investigation.nodeRefs);
  const edgeRefs = useStoreSelector(state.investigation, (investigation) => investigation.edgeRefs);
  const held = useMemo(() => ({ nodes: new Set(nodeRefs.map(elementKey)), edges: new Set(edgeRefs.map(edgeKey)) }), [nodeRefs, edgeRefs]);
  const [pressed, setPressed] = useState<{ readonly answer: object; readonly outcome: AddedOutcome } | undefined>(undefined);
  return {
    canAdd: shown !== undefined && !sourceChanged && principalId !== undefined,
    running,
    onGraph: (part) => part.nodes.every((node) => held.nodes.has(elementKey(node.ref))) && part.edges.every((edge) => held.edges.has(edgeKey(edge.ref))),
    add: (part) => {
      if (shown === undefined || sourceChanged || principalId === undefined || running) return;
      setPressed({ answer: shown, outcome: addResultToGraph(state, { nodes: part.nodes, edges: part.edges, keyPart: 'definition' }, { sourceId, principalId, expansions }) });
    },
    added: pressed === undefined || pressed.answer !== shown ? undefined : pressed.outcome,
  };
}
