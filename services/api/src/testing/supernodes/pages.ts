import type { Gate } from '../../gate/types.js';
import type { ExpansionPage } from '../../gate/normalize/expansion.js';
import type { ExpandFilter, ExpandRank } from '@neburyx/contracts';
import { EXPAND_COUNT_ID } from '../../gate/templates/expand-count.js';
import { EXPAND_NEIGHBORS_ID } from '../../gate/templates/expand-neighbors.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../gate.js';
import { hubOf } from '../benchmark/fixture.js';
import { RELATIONSHIP_OF, WALK_PAGE, type ReadSet } from '../benchmark/plan.js';

export interface ReadPage {
  readonly item: ExpansionPage;
  readonly hasMore: boolean;
  readonly nextCursor: string | undefined;
}

/** One page of the expand of an anchor of the benchmark graph, through the gate. */
export async function readPage(gate: Gate, size: number, set: ReadSet, limit: number, cursor?: string): Promise<ReadPage> {
  const relTypes = set === 'all' ? {} : { relTypes: [RELATIONSHIP_OF[set]] };
  const result = await gate.run(
    gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: EXPAND_NEIGHBORS_ID, params: { entityType: 'hub', stableId: hubOf(size), neighborType: 'leaf', direction: 'both', sort: 'observed', ...relTypes }, limit, ...(cursor === undefined ? {} : { cursor }) }),
  );
  // the expand template returns expansion pages, which the expand service checks the same way
  const item = result.items[0] as unknown as ExpansionPage | undefined;
  if (item === undefined || !item.anchorFound) throw new Error(`the anchor of ${size} relationships was not found`);
  return { item, hasMore: result.hasMore, nextCursor: result.nextCursor };
}

/** The reference of an edge, as text. */
export const keyOfEdge = (edge: ExpansionPage['edges'][number]): string => JSON.stringify([edge.type, edge.ref]);

/** The real chain of cursors to the page that starts at `row` (a multiple of `limit`): the cursor the gate minted there, or none for row 0. A chain that ends early fails. */
export async function cursorAtRow(gate: Gate, size: number, set: ReadSet, row: number, limit: number = WALK_PAGE): Promise<string | undefined> {
  let cursor: string | undefined;
  for (let read = 0; read < row; read += limit) {
    const page = await readPage(gate, size, set, limit, cursor);
    if (!page.hasMore || page.nextCursor === undefined) throw new Error(`${set} at ${size}: the order ended at row ${read + page.item.edges.length}, before row ${row}`);
    cursor = page.nextCursor;
  }
  return cursor;
}

/** One page of the dated relationships of an anchor (`LINKED`) under filters and a rank, through the gate. */
export async function readRefinedPage(gate: Gate, size: number, refinement: { readonly filters?: readonly ExpandFilter[]; readonly rank?: ExpandRank }, limit: number, cursor?: string): Promise<ReadPage> {
  const result = await gate.run(
    gateRequest({
      sourceId: 'graph',
      principal: LOCAL_PRINCIPAL,
      templateId: EXPAND_NEIGHBORS_ID,
      params: { entityType: 'hub', stableId: hubOf(size), neighborType: 'leaf', direction: 'both', sort: 'observed', relTypes: ['LINKED'], ...(refinement.filters === undefined ? {} : { filters: refinement.filters }), ...(refinement.rank === undefined ? {} : { rank: refinement.rank }) },
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const item = result.items[0] as unknown as ExpansionPage | undefined;
  if (item === undefined || !item.anchorFound) throw new Error(`the anchor of ${size} relationships was not found`);
  return { item, hasMore: result.hasMore, nextCursor: result.nextCursor };
}

/** The exact number of the dated relationships of an anchor that the filters match, by the count read of the gate. */
export async function countRefined(gate: Gate, size: number, filters: readonly ExpandFilter[]): Promise<number> {
  const result = await gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: EXPAND_COUNT_ID, params: { entityType: 'hub', stableId: hubOf(size), neighborType: 'leaf', direction: 'both', relTypes: ['LINKED'], filters }, limit: 1 }));
  const total = (result.items[0] as { total?: unknown } | undefined)?.total;
  if (typeof total !== 'number') throw new Error('the count read gave no number');
  return total;
}
