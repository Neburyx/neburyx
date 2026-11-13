import { MIN_SHARED_MAX, referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import { normalizeSharedAttribute } from '../normalize/shared-attribute.js';
import type { NormalizeContext } from '../normalize/index.js';
import type { ElementRef, Item, Params, Plan, Row, SourceAllowlist, UsedProperty } from '../types.js';
import { sharedAttributeRequestOf } from './shared-attribute-statement.js';
import { integerCandidateOf } from './stable-id.js';

export const SHARED_ATTRIBUTE_ID = 'shared-attribute';

const instant = z.iso.datetime({ offset: true });

const paramsSchema = z
  .strictObject({
    entityType: z.string().min(1),
    stableId: referenceValueSchema,
    attributeType: z.string().min(1),
    via: z.string().min(1),
    minShared: z.number().int().min(1).max(MIN_SHARED_MAX).default(1),
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
  const request = sharedAttributeRequestOf(allowlist, params);
  const stops = request.stopListProperties.map((property) => ({ entityType: request.attribute, property }));
  const time = request.windowed && request.observedAt !== undefined ? [{ relationshipType: request.via, from: request.anchor, to: request.attribute, property: request.observedAt }] : [];
  return [...stops, ...time];
}

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the shared attribute run needs the normalize context');
  return [{ ...normalizeSharedAttribute(context, rows) }];
}

/**
 * Finds the other entities of the anchor's type that share an attribute node of one type with the anchor, through one relationship type, at most the limit of them and one more to learn that the read was cut, each with the
 * first relationship of each side for a few of the shared nodes. The statement is written by the gate from the mapping (see `Template.sharedAttribute`); the request holds the entity types, the relationship type, the stable ID,
 * the minimum of shared nodes and a window only. A cut means only that there are more matches than were returned.
 */
export const sharedAttributeTemplate: TemplateDefinition = {
  id: SHARED_ATTRIBUTE_ID,
  version: '1',
  auditAction: 'entity.shared_attribute_run',
  name: 'Shared attribute',
  description: "Finds the other entities of the anchor's type that share an attribute node of one mapped type, joined by one mapped relationship type, with the anchor. Plan this template for a plain question of who shares an attribute; a question that asks for the chain that shows the link plans derived-rule-run.",
  cypher: '@sharedAttribute(attributeType)',
  sharedAttribute: { entityTypeParam: 'entityType', attributeTypeParam: 'attributeType', viaParam: 'via' },
  paramsSchema,
  scope: 'user',
  paged: false,
  cutMeans: 'lowerBound',
  entityParams: ['entityType', 'attributeType'],
  referenceParams: { entityType: 'entityType', stableId: 'stableId' },
  relationshipParams: ['via'],
  indexNeeds,
  usedProperties,
  refsOf: (): readonly ElementRef[] => [],
  normalize,
};
