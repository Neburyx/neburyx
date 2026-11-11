import { MAX_READ_REFS, referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TemplateDefinition } from '../catalog.js';
import { isPlainRelationship } from '../normalize/edge.js';
import { expectedTypesOf, normalizeWithEvidence, type AskedTypesOf, type NormalizeContext } from '../normalize/index.js';
import type { Item, Plan, Row } from '../types.js';
import { CONFLICTING_DUPLICATE_FLAG, edgeLoadTemplate } from './edge-load.js';
import { positionedRows } from './list-rows.js';
import { integerCandidateOf } from './stable-id.js';

export const EDGE_LOAD_MANY_ID = 'edge-load-many';

/** The read names the entity types of the two ends, so an end whose labels another type shares is resolved as the type the mapping row joins. */
const endTypesOf =
  (from: string, to: string): AskedTypesOf =>
  (row, column) => {
    if ((column !== 'a' && column !== 'b') || !isPlainRelationship(row['r'])) return undefined;
    return [column === 'a' ? from : to];
  };

const paramsSchema = z
  .strictObject({ type: z.string().min(1), from: z.string().min(1), to: z.string().min(1), refs: z.array(z.strictObject({ stableId: referenceValueSchema })).min(1).max(MAX_READ_REFS) })
  .transform((params) => ({ ...params, refs: params.refs.map((ref) => ({ ...ref, stableInteger: integerCandidateOf(ref.stableId) })) }));

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the edge read needs the normalize context');
  const { from, to } = context.params ?? {};
  if (typeof from !== 'string' || typeof to !== 'string') throw new Error('the edge read needs the entity types of its ends');
  return positionedRows(rows, context.params?.['refs']).map(({ row, index, duplicate }) => {
    // each ID is normalized as the single read does: its row alone
    const result = normalizeWithEvidence(context, [row], expectedTypesOf([row], endTypesOf(from, to)));
    // the relationship is there, so the answer is not that it is missing
    if (!result.edges.some((edge) => 'stableId' in edge.ref)) throw new AppError('INTERNAL_ERROR', undefined, 'unreadable-edge');
    const edges = duplicate ? result.edges.map((edge) => ({ ...edge, qualityFlags: edge.qualityFlags.includes(CONFLICTING_DUPLICATE_FLAG) ? edge.qualityFlags : [...edge.qualityFlags, CONFLICTING_DUPLICATE_FLAG] })) : result.edges;
    return { ...result, edges, index };
  });
}

/**
 * Reads the stored edges of one type and the entity types of its two ends for a list of up to `MAX_READ_REFS` stable IDs in one statement, as the single read of `edge-load` reads each (the same mapping row, the ID matched as the text
 * and as the integer it may be, the index on the relationship's `stable_id`). For each ID it reads at most two relationships and answers one row, the first by element ID, in the order of the list; an ID with no relationship has no row.
 */
export const edgeLoadManyTemplate: TemplateDefinition = {
  id: EDGE_LOAD_MANY_ID,
  version: '1',
  auditAction: 'edge.load',
  cypher: '@edgeLoad(type)',
  edgeLoad: { typeParam: 'type', fromParam: 'from', toParam: 'to', listParam: 'refs' },
  paramsSchema,
  scope: 'user',
  paged: false,
  rows: 'bounded',
  boundedBy: 'refs',
  entityParams: [],
  relationshipParams: [],
  usedProperties: edgeLoadTemplate.usedProperties,
  indexNeeds: edgeLoadTemplate.indexNeeds,
  refsOf: () => [],
  normalize,
};
