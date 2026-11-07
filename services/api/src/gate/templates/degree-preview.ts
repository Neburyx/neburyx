import { stableIdSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TemplateDefinition } from '../catalog.js';
import type { NormalizeContext } from '../normalize/index.js';
import type { Item, Params, Plan, Row, SourceAllowlist } from '../types.js';
import { degreePairsOf } from './degree-pairs.js';
import { integerCandidateOf } from './stable-id.js';

export const DEGREE_PREVIEW_BOUNDED_ID = 'degree-preview-bounded';
export const DEGREE_PREVIEW_CHEAP_ID = 'degree-preview-cheap';

/** What one count of a degree read says: the number of relationships read, and whether the read stopped at the cap. */
export interface DegreeValue {
  readonly value: number;
  readonly quality: 'exact' | 'lowerBound';
}

/** A node was found: one value for each mapped pair of its entity type, in `degreePairsOf` order. No node, or an entity type with no pair, gives `found: false`. */
export type DegreeItem = { readonly found: false } | { readonly found: true; readonly counts: readonly DegreeValue[]; readonly duplicate: boolean };

const paramsSchema = z.strictObject({ entityType: z.string().min(1), stableId: stableIdSchema }).transform((params) => ({ ...params, stableInteger: integerCandidateOf(params.stableId) }));

const readsNothing = (params: Params, allowlist: SourceAllowlist): boolean => degreePairsOf(allowlist.relationshipRows, String(params['entityType'])).length === 0;

function indexNeeds(params: Params, allowlist: SourceAllowlist) {
  const property = allowlist.stableIds.get(String(params['entityType']));
  return property === undefined ? [] : [{ entityType: String(params['entityType']), property, accepts: 'value' as const }];
}

/** How many pairs the request's entity type has in the mapping, which is how many columns the row must hold. */
export function pairCountOf(context: NormalizeContext): number {
  return degreePairsOf(context.model.relationships, String(context.params?.['entityType'])).length;
}

/** The columns `c0`, `c1`, ... of the one row, `columns` of them, each a whole number from zero to `max`; any other shape is a read the gate cannot trust. */
export function readCounts(row: Row, max: number, columns: number): readonly number[] {
  const names = Object.keys(row);
  const counts = names.map((_name, index) => row[`c${index}`]);
  if (names.length !== columns || names.some((name, index) => name !== `c${index}`) || !counts.every((count): count is number => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= max)) {
    throw new AppError('INTERNAL_ERROR');
  }
  return counts;
}

function normalizeBounded(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  const cap = context?.countCap;
  if (context === undefined || cap === undefined) throw new Error('the bounded degree read needs the count cap');
  const [row, ...others] = rows;
  if (others.length > 0) throw new AppError('INTERNAL_ERROR');
  if (row === undefined) return [{ found: false } satisfies DegreeItem];
  const counts = readCounts(row, cap + 1, pairCountOf(context)).map((count): DegreeValue => (count > cap ? { value: cap, quality: 'lowerBound' } : { value: count, quality: 'exact' }));
  return [{ found: true, counts, duplicate: context.hasMore } satisfies DegreeItem];
}

/**
 * Counts the relationships of one node by mapped relationship type and direction, each count cut at the source's `heavy_op_threshold`: a pair is read for at most `cap + 1` relationships, so the read
 * is bounded whatever the node and whatever the server's plan, and a count at `cap + 1` is a lower bound that says `cap`. The node is found as the entity read finds it: by its label and `stable_id` property,
 * matched as the text and, when the text is a canonical 64-bit integer, as that integer too, the first by element ID; a second node with the ID sets the duplicate flag. The label, the property and every
 * relationship type are written in by the gate from the mapping.
 */
export const degreePreviewBoundedTemplate: TemplateDefinition = {
  id: DEGREE_PREVIEW_BOUNDED_ID,
  version: '1',
  auditAction: 'entity.degree_preview',
  cypher: '@degreeCounts(entityType)',
  degreeCounts: { param: 'entityType', form: 'bounded' },
  paramsSchema,
  scope: 'user',
  paged: false,
  entityParams: ['entityType'],
  relationshipParams: [],
  indexNeeds,
  readsNothing,
  refsOf: () => [],
  normalize: normalizeBounded,
};

function normalizeCheap(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the cheap degree read needs the normalize context');
  const [row, ...others] = rows;
  if (others.length > 0) throw new AppError('INTERNAL_ERROR');
  if (row === undefined) return [{ found: false } satisfies DegreeItem];
  const counts = readCounts(row, Number.MAX_SAFE_INTEGER, pairCountOf(context)).map((count): DegreeValue => ({ value: count, quality: 'exact' }));
  return [{ found: true, counts, duplicate: context.hasMore } satisfies DegreeItem];
}

/**
 * Counts the relationships of one node by mapped relationship type and direction with the server's own count of a node's relationships (`COUNT { (n)-[:T]->() }`, no property predicate, no label on the other end),
 * which a server answers from the degree of the node and not by expanding it. It is for an entity type whose checks showed the server to do that; the anchor, the names and the parameters are those of the bounded read.
 */
export const degreePreviewCheapTemplate: TemplateDefinition = {
  ...degreePreviewBoundedTemplate,
  id: DEGREE_PREVIEW_CHEAP_ID,
  degreeCounts: { param: 'entityType', form: 'cheap' },
  normalize: normalizeCheap,
};
