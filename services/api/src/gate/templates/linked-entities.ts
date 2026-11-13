import { referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import { hopsSchema } from '../hops.js';
import { normalizeLinkedEntities } from '../normalize/linked-entities.js';
import type { NormalizeContext } from '../normalize/index.js';
import type { ElementRef, Item, Params, Plan, Row, SourceAllowlist, UsedProperty } from '../types.js';
import { LINKED_MAX_HOPS, linkedEntitiesRequestOf } from './linked-entities-statement.js';
import { integerCandidateOf } from './stable-id.js';

export const LINKED_ENTITIES_ID = 'linked-entities';

const instant = z.iso.datetime({ offset: true });

const paramsSchema = z
  .strictObject({
    entityType: z.string().min(1),
    stableId: referenceValueSchema,
    targetType: z.string().min(1),
    via: z.array(z.string().min(1)).min(1),
    direction: z.enum(['out', 'in', 'both']).optional(),
    maxHops: hopsSchema.default(1),
    windowFrom: instant.optional(),
    windowTo: instant.optional(),
  })
  .refine((params) => (params.windowFrom === undefined) === (params.windowTo === undefined), { message: 'a window has both instants or neither' })
  .transform((params) => ({ ...params, stableInteger: integerCandidateOf(params.stableId) }));

function indexNeeds(params: Params, allowlist: SourceAllowlist) {
  const entityType = String(params['entityType']);
  const property = allowlist.stableIds.get(entityType);
  return property === undefined ? [] : [{ entityType, property, accepts: 'value' as const }];
}

function usedProperties(params: Params, allowlist?: SourceAllowlist): readonly UsedProperty[] {
  if (allowlist === undefined) return [];
  const request = linkedEntitiesRequestOf(allowlist, params);
  const stops = [...request.stopListed].flatMap(([entityType, properties]) => properties.map((property) => ({ entityType, property })));
  const time = request.windowed
    ? [...request.first, ...request.second].flatMap((step) => (step.observedAt === undefined ? [] : [{ relationshipType: step.type, from: step.direction === 'in' ? step.far : step.near, to: step.direction === 'in' ? step.near : step.far, property: step.observedAt }]))
    : [];
  return [...stops, ...time];
}

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the linked entities run needs the normalize context');
  return [{ ...normalizeLinkedEntities(context, rows) }];
}

/**
 * Finds the entities of one type that are reached from the anchor over the listed relationship types in one or two hops, at most the limit of them and one more to learn that the read was cut, each with the relationships that
 * join it and, at two hops, the entity in between. The statement is written by the gate from the mapping (see `Template.linkedEntities`); the request holds the entity types, the relationship types, the direction, the hop
 * count, the stable ID and a window only. A cut means only that there are more matches than were returned.
 */
export const linkedEntitiesTemplate: TemplateDefinition = {
  id: LINKED_ENTITIES_ID,
  version: '1',
  auditAction: 'entity.linked_entities_run',
  name: 'Linked entities',
  description: 'Finds the entities of one mapped type that are reached from the anchor over the listed relationship types, in one or two hops, in the direction asked or the stored one. Plan this template for a question of who or what an entity is connected to; a question about a shared attribute plans shared-attribute.',
  cypher: '@linkedEntities(targetType)',
  linkedEntities: { entityTypeParam: 'entityType', targetTypeParam: 'targetType', viaParam: 'via' },
  hops: { param: 'maxHops', max: LINKED_MAX_HOPS },
  paramsSchema,
  scope: 'user',
  paged: false,
  cutMeans: 'lowerBound',
  entityParams: ['entityType', 'targetType'],
  referenceParams: { entityType: 'entityType', stableId: 'stableId' },
  relationshipParams: ['via'],
  indexNeeds,
  usedProperties,
  refsOf: (): readonly ElementRef[] => [],
  normalize,
};
