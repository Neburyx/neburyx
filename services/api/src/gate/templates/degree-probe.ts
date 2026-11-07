import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { Item, Plan, Row } from '../types.js';

export const DEGREE_PROBE_ID = 'degree-probe';

const operatorSchema = z.strictObject({ name: z.string(), details: z.string().nullable(), dbHits: z.number() });

/** The operators of the plan the server showed for the probe, or null when it showed none; never a count of the anchor node. */
export const degreeProbeItemSchema = z.strictObject({ operators: z.array(operatorSchema).nullable() });

export type DegreeProbeItem = z.infer<typeof degreeProbeItemSchema>;

function normalize(rows: readonly Row[], plan: Plan = null): readonly Item[] {
  // one row holds the two counts of the anchor node, none if the label has no node; neither says anything about the source and both are dropped
  if (rows.length > 1) return [{ unreadable: { rows: String(rows.length) } }];
  return [{ operators: plan }];
}

/**
 * Counts the neighbors of one node of the entity type in each direction, with no property predicate, under `PROFILE`: the plan, not the node, shows whether
 * the server answers a count from the degree of the node (`getDegree`) or by expanding its relationships. The label and the relationship type are written
 * in by the gate from the mapping.
 */
export const degreeProbeTemplate: TemplateDefinition = {
  id: DEGREE_PROBE_ID,
  version: '1',
  auditAction: 'source.degree_probe',
  cypher:
    'PROFILE MATCH (n:@entity(entityType)) WITH n LIMIT 1 ' +
    'RETURN COUNT { (n)-[:@relationship(relationshipType)]->() } AS outgoing, COUNT { (n)<-[:@relationship(relationshipType)]-() } AS incoming',
  paramsSchema: z.strictObject({ entityType: z.string().min(1), relationshipType: z.string().min(1) }),
  scope: 'system',
  paged: false,
  rows: 'one',
  profile: true,
  entityParams: ['entityType'],
  relationshipParams: ['relationshipType'],
  refsOf: () => [],
  normalize,
};
