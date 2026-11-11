import { MAX_READ_REFS, referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TemplateDefinition } from '../catalog.js';
import { expectedTypesOf, normalizeRows, type NormalizeContext } from '../normalize/index.js';
import type { ElementRef, Item, Params, Plan, Row } from '../types.js';
import { DUPLICATE_STABLE_ID_FLAG } from './entity-load.js';
import { positionedRows } from './list-rows.js';
import { integerCandidateOf } from './stable-id.js';

export const ENTITY_LOAD_MANY_ID = 'entity-load-many';

/** One entity of the source, by the reference the client holds; every reference of a read names the read's entity type. */
const referenceSchema = z.strictObject({ sourceId: z.string().min(1), entityType: z.string().min(1), stableId: referenceValueSchema });

const paramsSchema = z
  .strictObject({ entityType: z.string().min(1), refs: z.array(referenceSchema).min(1).max(MAX_READ_REFS) })
  .refine((params) => params.refs.every((ref) => ref.entityType === params.entityType))
  .transform((params) => ({ entityType: params.entityType, refs: params.refs.map((ref) => ({ ...ref, stableInteger: integerCandidateOf(ref.stableId) })) }));

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the entity read needs the normalize context');
  const entityType = String(context.params?.['entityType']);
  return positionedRows(rows, context.params?.['refs']).map(({ row, index, duplicate }) => {
    // each reference is normalized as the single read does: its row alone, resolved as the type the read names
    const result = normalizeRows(context, [row], expectedTypesOf([row], () => [entityType]));
    // the node is there, so the answer is not that it is missing
    if (!result.nodes.some((node) => node.ref.entityType === entityType)) throw new AppError('INTERNAL_ERROR', undefined, 'unreadable-node');
    const nodes = duplicate ? result.nodes.map((node) => ({ ...node, qualityFlags: node.qualityFlags.includes(DUPLICATE_STABLE_ID_FLAG) ? node.qualityFlags : [...node.qualityFlags, DUPLICATE_STABLE_ID_FLAG] })) : result.nodes;
    return { ...result, nodes, index };
  });
}

function refsOf(params: Params): readonly ElementRef[] {
  const parsed = z.array(z.looseObject({ sourceId: z.string(), entityType: z.string(), stableId: z.string() })).safeParse(params['refs']);
  return parsed.success ? parsed.data.map(({ sourceId, entityType, stableId }) => ({ sourceId, entityType, stableId })) : [];
}

/**
 * Reads the nodes of one entity type for a list of up to `MAX_READ_REFS` stable IDs in one statement, as the single read of `entity-load` reads each: the ID is matched as the text and as the integer it may be, as parameters,
 * so the index on the `stable_id` property is used for each; the label and the property name are written in by the gate from the mapping. For each ID the statement reads at most two nodes (the second only says that another
 * node has the ID) and answers one row, the first by element ID, in the order of the list; an ID with no node has no row. No neighborhood is read. The seek hint keeps the planner from scanning the index whatever the statistics say.
 */
export const entityLoadManyTemplate: TemplateDefinition = {
  id: ENTITY_LOAD_MANY_ID,
  version: '1',
  auditAction: 'entity.load',
  cypher:
    'UNWIND range(0, size($refs) - 1) AS i CALL { WITH i MATCH (n:@entity(entityType)) USING INDEX SEEK n:@entity(entityType)(@stableId(entityType)) WHERE n.@stableId(entityType) IN [$refs[i].stableId, $refs[i].stableInteger] RETURN n ORDER BY elementId(n) LIMIT 2 } WITH i, collect(n) AS found RETURN i, found[0] AS n, size(found) > 1 AS dup ORDER BY i LIMIT $limit + 1',
  paramsSchema,
  scope: 'user',
  paged: false,
  rows: 'bounded',
  boundedBy: 'refs',
  entityParams: ['entityType'],
  referenceLists: ['refs'],
  relationshipParams: [],
  indexNeeds: (params, allowlist) => {
    const property = allowlist.stableIds.get(String(params['entityType']));
    return property === undefined ? [] : [{ entityType: String(params['entityType']), property, accepts: 'value' }];
  },
  refsOf,
  normalize,
};
