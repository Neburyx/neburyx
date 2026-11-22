import { MAX_READ_REFS, maskedFieldCountOf, type ExportHeader, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { edgeKey, elementKey } from '../state/keys.js';
import type { exportRequestOf } from './export-attempt.js';

type Refs = Pick<ReturnType<typeof exportRequestOf>, 'entities' | 'edges' | 'aggregates' | 'derived'>;

export type MaskedRead = { readonly ok: true; readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] } | { readonly ok: false };

function chunked<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += MAX_READ_REFS) out.push(list.slice(index, index + MAX_READ_REFS));
  return out;
}

/**
 * The items of the view read again with the mask, to draw a picture from. The read is refused as a whole when anything of it cannot stand for what the server's header describes: a read that failed, an item that
 * did not come back, one the person may not export, or a different number of masked fields than the header states.
 */
export async function readMaskedView(client: ApiClient, sourceId: string, refs: Refs, header: ExportHeader, signal?: AbortSignal): Promise<MaskedRead> {
  const calls = [
    ...chunked(refs.entities).map((entities) => ({ entities })),
    ...chunked(refs.edges).map((edges) => ({ edges })),
    ...chunked(refs.aggregates).map((aggregates) => ({ aggregates })),
    ...chunked(refs.derived).map((derived) => ({ derived })),
  ];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let missing = 0;
  for (const call of calls) {
    const answer = await client.readRefs({ sourceId, mask: true, entities: [], edges: [], aggregates: [], derived: [], ...call }, signal);
    if (!answer.ok) return { ok: false };
    nodes.push(...answer.value.nodes);
    edges.push(...answer.value.edges);
    missing += answer.value.missing.entities.length + answer.value.missing.edges.length;
  }
  const asked = new Set([...refs.entities.map(elementKey), ...[...refs.edges, ...refs.aggregates, ...refs.derived].map(edgeKey)]);
  const read = new Set([...nodes.map((node) => elementKey(node.ref)), ...edges.map((edge) => edgeKey(edge.ref))]);
  if (missing > 0 || read.size < asked.size || [...asked].some((key) => !read.has(key))) return { ok: false };
  if (nodes.some((node) => !node.authorization.canExport)) return { ok: false };
  const stated = header.masking === 'off' ? 0 : header.masking.maskedFields;
  if (maskedFieldCountOf(nodes, edges) !== stated) return { ok: false };
  return { ok: true, nodes, edges };
}
