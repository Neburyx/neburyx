import type { SourceProfile } from '@neburyx/contracts';
import { edgeKey, elementKey } from '../state/keys.js';
import { drawnKeys, type LoadedGraph } from '../state/loaded-graph.js';

export interface OnCanvasRow {
  readonly kind: 'entity' | 'relationship';
  readonly key: string;
  readonly title: string;
  readonly typeName: string;
  readonly id: string | undefined;
}

const lower = (text: string): string => text.toLocaleLowerCase();

function rowsOf(graph: LoadedGraph, profile: SourceProfile | undefined): OnCanvasRow[] {
  const drawn = drawnKeys(graph);
  const entities = graph.nodes.flatMap((node): OnCanvasRow[] => {
    const key = elementKey(node.ref);
    if (!drawn.has(key)) return [];
    return [{ kind: 'entity', key, title: node.display.title, typeName: profile?.entityTypes.find((type) => type.type === node.ref.entityType)?.displayName ?? node.display.type, id: node.ref.stableId }];
  });
  const relationships = graph.edges.flatMap((edge): OnCanvasRow[] => {
    const key = edgeKey(edge.ref);
    if (!drawn.has(key)) return [];
    return [{ kind: 'relationship', key, title: edge.type, typeName: edge.type, id: 'stableId' in edge.ref ? edge.ref.stableId : undefined }];
  });
  return [...entities, ...relationships];
}

/**
 * The drawn items that contain the text, by case-insensitive substring over what the canvas shows of them: an entity's title, its type's display name and its stable ID; a relationship's
 * type and, when it has one, its stable ID. Nothing is read from the source, and a masked value is matched as it is masked.
 */
export function findOnCanvas(graph: LoadedGraph, profile: SourceProfile | undefined, text: string): readonly OnCanvasRow[] {
  if (text === '') return [];
  const wanted = lower(text);
  return rowsOf(graph, profile).filter((row) => [row.title, row.typeName, row.id ?? ''].some((shown) => lower(shown).includes(wanted)));
}

export function entitiesOnCanvas(graph: LoadedGraph): number {
  const drawn = drawnKeys(graph);
  return graph.nodes.filter((node) => drawn.has(elementKey(node.ref))).length;
}
