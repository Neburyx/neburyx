import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { Item, Row } from '../types.js';
import { unreadableOf } from './unreadable.js';

export const STABLE_ID_DUPLICATES_ID = 'stable-id-duplicates';

/** The number of `stable_id` values that occur on more than one node of the entity type; never a value. */
export const duplicatesItemSchema = z.strictObject({ duplicated: z.number().int().nonnegative() });

export type DuplicatesItem = z.infer<typeof duplicatesItemSchema>;

function normalize(rows: readonly Row[]): readonly Item[] {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) return [{ unreadable: { rows: String(rows.length) } }];
  const parsed = duplicatesItemSchema.safeParse(row);
  return [parsed.success ? parsed.data : unreadableOf(row)];
}

/**
 * The label and the property are written in by the gate from the mapping, as quoted names; the index hint and the literal property let the planner stream
 * an ordered aggregation from the index, so the scan holds one value at a time. It is meant for an entity type whose `stable_id` has an index and no constraint.
 */
export const stableIdDuplicatesTemplate: TemplateDefinition = {
  id: STABLE_ID_DUPLICATES_ID,
  version: '1',
  auditAction: 'source.stable_id_duplicates',
  cypher:
    'MATCH (n:@entity(entityType)) USING INDEX n:@entity(entityType)(@stableId(entityType)) WHERE n.@stableId(entityType) IS NOT NULL ' +
    'WITH n.@stableId(entityType) AS value, count(*) AS c WHERE c > 1 RETURN toFloat(count(value)) AS duplicated',
  paramsSchema: z.strictObject({ entityType: z.string().min(1) }),
  scope: 'system',
  paged: false,
  rows: 'one',
  entityParams: ['entityType'],
  relationshipParams: [],
  refsOf: () => [],
  normalize,
};
