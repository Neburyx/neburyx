import { MAX_READ_REFS, type EdgeRef, type ElementRef, type GraphEdge, type GraphNode, type InvestigationResponse } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { DEFAULT_LAYOUT } from '../state/layout-choice.js';
import { keptFrom, refsOf, type KeptItems } from './draft-document.js';

export interface RestoredItems {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly kept: KeptItems;
  /** Whether any item of the draft did not come back; the person is told so without a count. */
  readonly someMissing: boolean;
}

export type RestoreOutcome = { readonly ok: true; readonly restored: RestoredItems } | { readonly ok: false; readonly failure: ApiFailure };

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += MAX_READ_REFS) out.push(list.slice(at, at + MAX_READ_REFS));
  return out;
}

/** Whether a draft is only what opening an investigation writes: its starting entity, with nothing moved, pinned, hidden or filtered. */
export function isOpeningDraft(draft: InvestigationResponse['draft'], start: { readonly entityType: string; readonly stableId: string } | null): boolean {
  const [node] = draft.layout.nodes;
  return (
    start !== null &&
    draft.layout.nodes.length === 1 &&
    node !== undefined &&
    node.t === start.entityType &&
    node.id === start.stableId &&
    node.x === undefined &&
    node.y === undefined &&
    !node.pinned &&
    !node.hidden &&
    draft.layout.edges.length === 0 &&
    draft.layout.viewport === undefined &&
    draft.layout.layout === DEFAULT_LAYOUT &&
    draft.queryContext.loaded.edges.length === 0 &&
    draft.queryContext.filters.entityTypes.length === 0 &&
    draft.queryContext.filters.relTypes.length === 0
  );
}

/**
 * Reads again the items a draft names, in calls of at most the number of references one call takes; the first failure ends the restore, and nothing it read is shown. The entities are asked for
 * first and the relationships after, each kind a chunk at a time.
 */
export async function readDraftItems(client: ApiClient, sourceId: string, mask: boolean, draft: InvestigationResponse['draft'], signal?: AbortSignal): Promise<RestoreOutcome> {
  const asked = refsOf(sourceId, draft.queryContext);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const missingEntities: ElementRef[] = [];
  const missingEdges: EdgeRef[] = [];
  const calls = [
    ...chunks(asked.entities).map((entities) => ({ entities })),
    ...chunks(asked.edges).map((list) => ({ edges: list })),
    ...chunks(asked.aggregates).map((list) => ({ aggregates: list })),
    ...chunks(asked.derived).map((list) => ({ derived: list })),
  ];
  for (const call of calls) {
    const result = await client.readRefs({ sourceId, ...(mask ? { mask: true } : {}), entities: [], edges: [], aggregates: [], derived: [], ...call }, signal);
    if (!result.ok) return { ok: false, failure: result.failure };
    nodes.push(...result.value.nodes);
    edges.push(...result.value.edges);
    missingEntities.push(...result.value.missing.entities);
    missingEdges.push(...result.value.missing.edges);
  }
  const kept = keptFrom(sourceId, draft.layout, draft.queryContext, { entities: missingEntities, edges: missingEdges });
  return { ok: true, restored: { nodes, edges, kept, someMissing: missingEntities.length + missingEdges.length > 0 } };
}
