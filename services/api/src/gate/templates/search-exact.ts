import { searchTextSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { MAX_SEARCH_PROPERTIES } from '../../mapping/model.js';
import type { TemplateDefinition } from '../catalog.js';
import { normalizeRows, type NormalizeContext } from '../normalize/index.js';
import type { Item, Params, Plan, Row } from '../types.js';
import { integerCandidateOf } from './stable-id.js';

export const SEARCH_EXACT_ID = 'entity-search';

/**
 * One property of one entity type that the search matches: the type and the property both come from the mapping's `search` lists. `value` matches the text and the integer it can be
 * (a RANGE index or a constraint serves it); `text` matches the text only (a TEXT index holds strings only).
 */
export const searchTargetSchema = z.strictObject({ entityType: z.string().min(1), property: z.string().min(1), match: z.enum(['value', 'text']) });

export type SearchTarget = z.infer<typeof searchTargetSchema>;

export const targetsSchema = z.array(searchTargetSchema).max(MAX_SEARCH_PROPERTIES);

export function targetsOf(params: Params): readonly SearchTarget[] {
  const parsed = targetsSchema.safeParse(params['targets']);
  return parsed.success ? parsed.data : [];
}

export function normalizeSearch(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the search needs the normalize context');
  return [{ ...normalizeRows(context, rows) }];
}

/**
 * Matches the whole typed text, as stored, against each target property, as the text and, when the text is a canonical 64-bit integer, as that integer too (both parameters),
 * so an index on the property serves each branch and no function touches the property. The branches are written in by the gate from the mapping, joined by `UNION` so an
 * entity found through two properties is one row; each branch is cut at `$limit + 1` so a common value cannot make the union read every match, and the combined result is cut at
 * `$limit + 1` too: the gate shows `$limit` of them and learns whether there are more.
 */
export const searchExactTemplate: TemplateDefinition = {
  id: SEARCH_EXACT_ID,
  version: '1',
  auditAction: 'entity.search',
  cypher: 'CALL { @searchBranches(targets) } WITH n LIMIT $limit + 1 RETURN n',
  searchBranches: {
    param: 'targets',
    value: 'MATCH (n:@label) WHERE n.@property IN [$text, $textInteger] RETURN n LIMIT $limit + 1',
    text: 'MATCH (n:@label) WHERE n.@property = $text RETURN n LIMIT $limit + 1',
  },
  paramsSchema: z.strictObject({ text: searchTextSchema, targets: targetsSchema }).transform((params) => ({ ...params, textInteger: integerCandidateOf(params.text) })),
  scope: 'user',
  paged: false,
  entityParams: [],
  relationshipParams: [],
  usedProperties: (params) => targetsOf(params),
  indexNeeds: (params) => targetsOf(params).map((target) => ({ entityType: target.entityType, property: target.property, accepts: target.match === 'text' ? ('any' as const) : ('value' as const) })),
  readsNothing: (params) => targetsOf(params).length === 0,
  refsOf: () => [],
  normalize: normalizeSearch,
};
