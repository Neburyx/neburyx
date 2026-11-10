import { exportFileSchema, type ExportHeader, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import { canonicalJson } from '../gate/cursor/binding.js';

export const compareNodes = (left: GraphNode, right: GraphNode): number => canonicalJson(left.ref).localeCompare(canonicalJson(right.ref));
export const compareEdges = (left: GraphEdge, right: GraphEdge): number => canonicalJson(left.ref).localeCompare(canonicalJson(right.ref));

/** The JSON file: the header first, then the entities and the relationships in a fixed order, so the same read gives the same bytes. */
export function exportJsonOf(header: ExportHeader, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Buffer {
  const file = exportFileSchema.parse({ header, entities: [...nodes].sort(compareNodes), relationships: [...edges].sort(compareEdges) });
  return Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
}
