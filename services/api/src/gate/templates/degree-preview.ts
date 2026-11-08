import { referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TemplateDefinition } from '../catalog.js';
import type { NormalizeContext } from '../normalize/index.js';
import type { Item, Params, Plan, Row, SourceAllowlist } from '../types.js';
import { declarationsOf, degreePairsOf } from './degree-pairs.js';
import { integerCandidateOf } from './stable-id.js';

export const DEGREE_PREVIEW_BOUNDED_ID = 'degree-preview-bounded';
export const DEGREE_PREVIEW_CHEAP_ID = 'degree-preview-cheap';

/**
 * What one count of a degree read says: the number of relationships read, and whether the read stopped at the cap. A pair whose read stopped at the cap may instead hold the number of a degree
 * property the mapping declares, as `estimated`; `provenFloor` is then the cap, the most the live read proved.
 */
export interface DegreeValue {
  readonly value: number;
  readonly quality: 'exact' | 'lowerBound' | 'estimated';
  readonly provenFloor?: number;
  /** When the customer computed an estimated number, from the date property the mapping names; never the time of the read. */
  readonly observedAt?: string;
  /** Set on a lower bound whose declared property held a value that could not be taken (not a whole number above the cap); an absent property does not set it. */
  readonly propertyIgnored?: true;
}

/** A node was found: one value for each mapped pair of its entity type, in `degreePairsOf` order. No node, or an entity type with no pair, gives `found: false`. */
export type DegreeItem = { readonly found: false } | { readonly found: true; readonly counts: readonly DegreeValue[]; readonly duplicate: boolean };

const paramsSchema = z.strictObject({ entityType: z.string().min(1), stableId: referenceValueSchema }).transform((params) => ({ ...params, stableInteger: integerCandidateOf(params.stableId) }));

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

/** The pairs of the request's entity type and the degree declarations of each, from the model the normalize stage was given. */
function declaredPairsOf(context: NormalizeContext) {
  const entityType = String(context.params?.['entityType']);
  return declarationsOf(degreePairsOf(context.model.relationships, entityType), context.model.entitiesByType.get(entityType)?.degree);
}

/**
 * The row of a bounded degree read: the columns `c0`, `c1`, ... of every pair, then the columns `p<i>` of the pairs that declare a degree property, in the order of the pairs and no others. Any other
 * shape is a read the gate cannot trust.
 */
function readBoundedRow(row: Row, cap: number, context: NormalizeContext): { readonly counts: readonly number[]; readonly properties: ReadonlyMap<number, { readonly stored: unknown; readonly date: unknown }> } {
  const declared = declaredPairsOf(context);
  const propertyColumns = declared.flatMap((declaration, index) => (declaration === undefined ? [] : [index]));
  const names = Object.keys(row);
  const expected = [...declared.map((_declaration, index) => `c${index}`), ...declared.flatMap((declaration, index) => (declaration === undefined ? [] : [`p${index}`, ...(declaration.observedAt === undefined ? [] : [`t${index}`])]))];
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw new AppError('INTERNAL_ERROR');
  const counts = declared.map((_declaration, index) => row[`c${index}`]);
  if (!counts.every((count): count is number => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= cap + 1)) throw new AppError('INTERNAL_ERROR');
  return { counts, properties: new Map(propertyColumns.map((index) => [index, { stored: row[`p${index}`], date: row[`t${index}`] }])) };
}

/** A declared property's number, taken only when it is a whole number above the cap: what the live read saw at the cap cannot be less. */
const estimateOf = (stored: unknown, cap: number): number | undefined => (typeof stored === 'number' && Number.isSafeInteger(stored) && stored > cap ? stored : undefined);

const DATE_KINDS: ReadonlySet<string> = new Set(['date', 'dateTime', 'localDateTime']);

/** The text of a stored date: non-empty text as it is, a `date`, `dateTime` or `localDateTime` as its text; any other kind of value (a time, a duration, a number, a point, a list) gives nothing. */
function dateTextOf(stored: unknown): string | undefined {
  if (typeof stored === 'string') return stored.trim() === '' ? undefined : stored;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined;
  const tag: unknown = Reflect.get(stored, '$type');
  const text: unknown = Reflect.get(stored, 'value');
  return typeof tag === 'string' && DATE_KINDS.has(tag) && typeof text === 'string' && text !== '' ? text : undefined;
}

function normalizeBounded(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  const cap = context?.countCap;
  if (context === undefined || cap === undefined) throw new Error('the bounded degree read needs the count cap');
  const [row, ...others] = rows;
  if (others.length > 0) throw new AppError('INTERNAL_ERROR');
  if (row === undefined) return [{ found: false } satisfies DegreeItem];
  const { counts: read, properties } = readBoundedRow(row, cap, context);
  const counts = read.map((count, index): DegreeValue => {
    if (count <= cap) return { value: count, quality: 'exact' };
    const held = properties.get(index);
    const estimate = estimateOf(held?.stored, cap);
    if (estimate === undefined) return { value: cap, quality: 'lowerBound', ...(held === undefined || held.stored === null || held.stored === undefined ? {} : { propertyIgnored: true as const }) };
    const observedAt = dateTextOf(held?.date);
    return { value: estimate, quality: 'estimated', provenFloor: cap, ...(observedAt === undefined ? {} : { observedAt }) };
  });
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
  version: '2',
  auditAction: 'entity.degree_preview',
  cypher: '@degreeCounts(entityType)',
  degreeCounts: { param: 'entityType', form: 'bounded' },
  paramsSchema,
  scope: 'user',
  paged: false,
  cutMeans: 'duplicate',
  entityParams: ['entityType'],
  referenceParams: { entityType: 'entityType', stableId: 'stableId' },
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
