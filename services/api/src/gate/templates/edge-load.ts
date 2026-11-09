import { referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TemplateDefinition } from '../catalog.js';
import { isPlainRelationship } from '../normalize/edge.js';
import { expectedTypesOf, normalizeWithEvidence, type AskedTypesOf, type NormalizeContext } from '../normalize/index.js';
import type { Item, Plan, Row } from '../types.js';
import { integerCandidateOf } from './stable-id.js';

export const EDGE_LOAD_ID = 'edge-load';

/** Set on the edge when the source holds more than one relationship with the type, ends and stable ID; the edge shown is the first by element ID. */
export const CONFLICTING_DUPLICATE_FLAG = 'conflicting-duplicate';

/** The read names the entity types of the two ends, so an end whose labels another type shares is resolved as the type the mapping row joins. */
function endTypesOf(from: string, to: string): AskedTypesOf {
  return (row, column) => {
    if ((column !== 'a' && column !== 'b') || !isPlainRelationship(row['r'])) return undefined;
    return [column === 'a' ? from : to];
  };
}

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the edge read needs the normalize context');
  const { from, to } = context.params ?? {};
  if (typeof from !== 'string' || typeof to !== 'string') throw new Error('the edge read needs the entity types of its ends');
  const result = normalizeWithEvidence(context, rows, expectedTypesOf(rows, endTypesOf(from, to)));
  // a row was read and no stored edge came of it (an end or its stable ID cannot be used): the relationship is there, so the answer is not that it is missing
  if (rows.length > 0 && !result.edges.some((edge) => 'stableId' in edge.ref)) throw new AppError('INTERNAL_ERROR', undefined, 'unreadable-edge');
  const edges = context.hasMore ? result.edges.map((edge) => ({ ...edge, qualityFlags: edge.qualityFlags.includes(CONFLICTING_DUPLICATE_FLAG) ? edge.qualityFlags : [...edge.qualityFlags, CONFLICTING_DUPLICATE_FLAG] })) : result.edges;
  return [{ ...result, edges }];
}

/**
 * Reads one stored edge by its type, the entity types of its two ends and its stable ID. The ID is matched as the text and, when the text is a canonical 64-bit integer, as that integer too, both as parameters,
 * so a source whose IDs are integers is found and the index on the relationship's `stable_id` property is used. Every name is written in by the gate from the mapping row. Two rows are read: the second only says
 * that another relationship has the same type, ends and ID.
 */
export const edgeLoadTemplate: TemplateDefinition = {
  id: EDGE_LOAD_ID,
  version: '1',
  auditAction: 'edge.load',
  cypher: '@edgeLoad(type)',
  edgeLoad: { typeParam: 'type', fromParam: 'from', toParam: 'to' },
  paramsSchema: z
    .strictObject({ type: z.string().min(1), from: z.string().min(1), to: z.string().min(1), stableId: referenceValueSchema })
    .transform((params) => ({ ...params, stableInteger: integerCandidateOf(params.stableId) })),
  scope: 'user',
  paged: false,
  cutMeans: 'duplicate',
  entityParams: [],
  relationshipParams: [],
  usedProperties: (params, allowlist) => {
    const row = allowlist?.relationshipRows.find((candidate) => candidate.type === params['type'] && candidate.from === params['from'] && candidate.to === params['to']);
    return row?.stableId === undefined ? [] : [{ relationshipType: row.type, from: row.from, to: row.to, property: row.stableId }];
  },
  indexNeeds: (params, allowlist) => {
    const row = allowlist.relationshipRows.find((candidate) => candidate.type === params['type'] && candidate.from === params['from'] && candidate.to === params['to']);
    return row?.stableId === undefined ? [] : [{ relationshipType: row.type, from: row.from, to: row.to, property: row.stableId, accepts: 'value' as const }];
  },
  refsOf: () => [],
  normalize,
};
