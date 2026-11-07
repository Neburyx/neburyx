import { referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import { normalizeRows, type Normalized, type NormalizeContext } from '../normalize/index.js';
import type { Item, Plan, Row } from '../types.js';
import { integerCandidateOf } from './stable-id.js';

export const ENTITY_LOAD_ID = 'entity-load';

/** Set on the node when the source holds more than one node with the stable ID; the node shown is the first by element ID. */
export const DUPLICATE_STABLE_ID_FLAG = 'duplicate-stable-id';

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the entity read needs the normalize context');
  const result = normalizeRows(context, rows);
  const nodes = context.hasMore ? result.nodes.map((node) => ({ ...node, qualityFlags: node.qualityFlags.includes(DUPLICATE_STABLE_ID_FLAG) ? node.qualityFlags : [...node.qualityFlags, DUPLICATE_STABLE_ID_FLAG] })) : result.nodes;
  const normalized: Normalized = { ...result, nodes };
  return [{ ...normalized }];
}

/**
 * Reads the node of one entity type with one stable ID. The ID is matched as the text and, when the text is a canonical 64-bit integer, as that integer too,
 * both as parameters, so a source whose IDs are integers is found and the index on the `stable_id` property is used. The label and the property name are
 * written in by the gate from the mapping. One row is asked for; the gate reads one more to learn whether another node has the ID.
 */
export const entityLoadTemplate: TemplateDefinition = {
  id: ENTITY_LOAD_ID,
  version: '1',
  auditAction: 'entity.load',
  cypher: 'MATCH (n:@entity(entityType)) WHERE n.@stableId(entityType) IN [$stableId, $stableInteger] RETURN n ORDER BY elementId(n) LIMIT $limit + 1',
  paramsSchema: z.strictObject({ entityType: z.string().min(1), stableId: referenceValueSchema }).transform((params) => ({ ...params, stableInteger: integerCandidateOf(params.stableId) })),
  scope: 'user',
  paged: false,
  entityParams: ['entityType'],
  referenceParams: { entityType: 'entityType', stableId: 'stableId' },
  relationshipParams: [],
  indexNeeds: (params, allowlist) => {
    const property = allowlist.stableIds.get(String(params['entityType']));
    return property === undefined ? [] : [{ entityType: String(params['entityType']), property, accepts: 'value' }];
  },
  refsOf: () => [],
  normalize,
};
