import { countSchema } from '@neburyx/contracts';
import { z } from 'zod';

export const ICON_KEYS = ['circle', 'square', 'triangle', 'diamond'] as const;
export const ENTITY_STATES = ['open', 'review', 'closed'] as const;

export const entityTypeSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  iconKey: z.enum(ICON_KEYS),
});

const entityNodeSchema = z.strictObject({
  kind: z.literal('entity'),
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  state: z.enum(ENTITY_STATES),
});

const neighborAggregateNodeSchema = z.strictObject({
  kind: z.literal('neighborAggregate'),
  id: z.string().min(1),
  type: z.string().min(1),
  supernodeId: z.string().min(1),
  loaded: z.number().int().nonnegative(),
  total: countSchema,
});

export const nodeSchema = z.discriminatedUnion('kind', [entityNodeSchema, neighborAggregateNodeSchema]);

const plainRelationshipSchema = z.strictObject({
  kind: z.enum(['sourced', 'derived']),
  id: z.string().min(1),
  type: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

const aggregateRelationshipSchema = z.strictObject({
  kind: z.literal('aggregate'),
  id: z.string().min(1),
  type: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  members: countSchema,
});

export const relationshipSchema = z.union([plainRelationshipSchema, aggregateRelationshipSchema]);

export const fixtureSchema = z
  .strictObject({
    seed: z.number().int().nonnegative(),
    types: z.array(entityTypeSchema).min(1),
    nodes: z.array(nodeSchema).min(1),
    relationships: z.array(relationshipSchema),
  })
  .superRefine((fixture, context) => {
    const typeIds = new Set(fixture.types.map((type) => type.id));
    const nodeIds = new Set<string>();
    for (const node of fixture.nodes) {
      if (nodeIds.has(node.id)) context.addIssue({ code: 'custom', message: 'duplicate node id', path: ['nodes'] });
      nodeIds.add(node.id);
      if (!typeIds.has(node.type)) context.addIssue({ code: 'custom', message: 'unknown entity type', path: ['nodes'] });
    }
    const relationshipIds = new Set<string>();
    for (const relationship of fixture.relationships) {
      if (relationshipIds.has(relationship.id) || nodeIds.has(relationship.id)) context.addIssue({ code: 'custom', message: 'duplicate relationship id', path: ['relationships'] });
      relationshipIds.add(relationship.id);
      if (!nodeIds.has(relationship.from) || !nodeIds.has(relationship.to)) context.addIssue({ code: 'custom', message: 'relationship names an unknown node', path: ['relationships'] });
    }
  });

export const additionsSchema = z.strictObject({
  nodes: z.array(entityNodeSchema).min(1),
  relationships: z.array(plainRelationshipSchema).min(1),
});

export type Additions = z.infer<typeof additionsSchema>;
export type EntityType = z.infer<typeof entityTypeSchema>;
export type FixtureNode = z.infer<typeof nodeSchema>;
export type FixtureRelationship = z.infer<typeof relationshipSchema>;
export type Fixture = z.infer<typeof fixtureSchema>;

export function elementCount(fixture: Fixture): number {
  return fixture.nodes.length + fixture.relationships.length;
}
