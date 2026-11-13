import { MIN_SHARED_MAX, referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import { normalizeSharedAttributeCount } from '../normalize/shared-attribute-count.js';
import type { Item, Row } from '../types.js';
import { sharedAttributeTemplate } from './shared-attribute.js';
import { integerCandidateOf } from './stable-id.js';

export const SHARED_ATTRIBUTE_COUNT_ID = 'shared-attribute-count';

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

/**
 * The heavy-operation probe of the shared-attribute run (TAS §8.1): counts the distinct other entities that hold at least `minShared` of the anchor's attribute nodes, reading at most the count cap plus one of them, with the
 * run's own anchor, window and stop-list clauses. It returns a number and two flags only. It is not a template a pattern can bind (it is not in `PRESET_TEMPLATES`), has no name or description for a list or a planner to offer,
 * and the run route cannot name it. With Enterprise policy the count must become policy-aware or `unknown` before it can reveal anything about entities a viewer may not see; the Community gate has no such policy.
 */
export const sharedAttributeCountTemplate: TemplateDefinition = {
  ...sharedAttributeTemplate,
  id: SHARED_ATTRIBUTE_COUNT_ID,
  auditAction: 'entity.shared_attribute_count',
  name: undefined,
  description: undefined,
  sharedAttribute: { entityTypeParam: 'entityType', attributeTypeParam: 'attributeType', viaParam: 'via', count: true },
  paramsSchema,
  normalize: (rows: readonly Row[]): readonly Item[] => [{ ...normalizeSharedAttributeCount(rows) }],
};
