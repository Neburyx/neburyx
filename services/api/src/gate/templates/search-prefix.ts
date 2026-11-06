import { typeaheadTextSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import { normalizeSearch, targetsOf, targetsSchema } from './search-exact.js';

export const SEARCH_PREFIX_ID = 'entity-search-prefix';

/** A prefix is served the same way by a RANGE index, a constraint and a TEXT index, so the two match forms of a target are one branch text. */
const PREFIX_BRANCH = 'MATCH (n:@label) WHERE n.@property STARTS WITH $text AND n.@property <> $text RETURN n LIMIT $limit + 1';

/**
 * Matches the start of each target property against the whole typed text, as stored and case-sensitive, with no function on the property, so an index seeks it. A value equal to the text
 * is left out because it belongs to the exact group; the filter sits before the branch's limit, so it does not use up the branch's rows. The text is a parameter and never a pattern.
 * A stored integer is never matched by a prefix of its digits. Branches and limits are as in the exact search template.
 */
export const searchPrefixTemplate: TemplateDefinition = {
  id: SEARCH_PREFIX_ID,
  version: '1',
  auditAction: 'entity.search',
  cypher: 'CALL { @searchBranches(targets) } WITH n LIMIT $limit + 1 RETURN n',
  searchBranches: { param: 'targets', allowlist: 'search', value: PREFIX_BRANCH, text: PREFIX_BRANCH },
  paramsSchema: z.strictObject({ text: typeaheadTextSchema, targets: targetsSchema }),
  scope: 'user',
  paged: false,
  entityParams: [],
  relationshipParams: [],
  usedProperties: (params) => targetsOf(params),
  indexNeeds: (params) => targetsOf(params).map((target) => ({ entityType: target.entityType, property: target.property, accepts: 'any' as const })),
  readsNothing: (params) => targetsOf(params).length === 0,
  refsOf: () => [],
  normalize: normalizeSearch,
};
