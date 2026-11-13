import type { TemplateDefinition } from '../catalog.js';
import { normalizeLinkedEntitiesCount } from '../normalize/linked-entities-count.js';
import type { Item, Row } from '../types.js';
import { linkedEntitiesTemplate } from './linked-entities.js';

export const LINKED_ENTITIES_COUNT_ID = 'linked-entities-count';

/**
 * The heavy-operation probe of the linked-entities run (TAS §8.1): counts the entities the run would return, reading at most the count cap plus one of them, with the run's own bounds on the frontier and on the degree of a
 * middle entity. It returns a number and two flags only. It is not a template a pattern can bind (it is not in `PRESET_TEMPLATES`), has no name or description for a list or a planner to offer, and the run route cannot
 * name it. With Enterprise policy the count must become policy-aware or `unknown` before it can reveal anything about entities a viewer may not see; the Community gate has no such policy.
 */
export const linkedEntitiesCountTemplate: TemplateDefinition = {
  ...linkedEntitiesTemplate,
  id: LINKED_ENTITIES_COUNT_ID,
  auditAction: 'entity.linked_entities_count',
  name: undefined,
  description: undefined,
  linkedEntities: { entityTypeParam: 'entityType', targetTypeParam: 'targetType', viaParam: 'via', count: true },
  normalize: (rows: readonly Row[]): readonly Item[] => [{ ...normalizeLinkedEntitiesCount(rows) }],
};
