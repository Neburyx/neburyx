import { z } from 'zod';
import { referenceTextSchema } from './entities.js';
import { countSchema, edgeSchema, nodeSchema } from './graph.js';

const text = z.string().min(1);

/** The kinds of value a filter compares with; a stored value of another kind never matches. */
export const FILTER_KINDS = ['text', 'number', 'boolean', 'date', 'dateTime', 'localDateTime', 'time', 'localTime'] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];

/** The most predicates one request holds, and the most values of one `in`. */
export const MAX_FILTERS = 6;
export const MAX_FILTER_VALUES = 20;
const MAX_FILTER_TEXT = 256;

const OFFSET = '(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)';
const DATE = '\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])';
const TIME = '(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d{1,9})?)?';
const TEMPORAL_PATTERNS: Readonly<Record<'date' | 'dateTime' | 'localDateTime' | 'time' | 'localTime', RegExp>> = {
  date: new RegExp(`^${DATE}$`),
  dateTime: new RegExp(`^${DATE}T${TIME}${OFFSET}$`),
  localDateTime: new RegExp(`^${DATE}T${TIME}$`),
  time: new RegExp(`^${TIME}${OFFSET}$`),
  localTime: new RegExp(`^${TIME}$`),
};

/** A calendar date that exists: 31 February is refused, so no text that the server could not read reaches it. */
function realDate(text: string): boolean {
  const [year, month, day] = text.slice(0, 10).split('-').map(Number);
  const moment = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return moment.getUTCFullYear() === year && moment.getUTCMonth() === (month ?? 1) - 1 && moment.getUTCDate() === day;
}

const temporal = <K extends 'date' | 'dateTime' | 'localDateTime' | 'time' | 'localTime'>(kind: K) =>
  z.strictObject({
    kind: z.literal(kind),
    value: z.string().refine((value) => TEMPORAL_PATTERNS[kind].test(value) && (kind === 'time' || kind === 'localTime' || realDate(value)), { message: 'is not an ISO value of this kind' }),
  });

/** One typed value: the kind says how the stored value is compared, and temporal text is checked to be ISO here, so no bad text reaches the server's own parser. */
export const filterValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), value: z.string().max(MAX_FILTER_TEXT) }),
  z.strictObject({ kind: z.literal('number'), value: z.number().finite().refine((value) => !Number.isInteger(value) || Number.isSafeInteger(value), { message: 'an integer beyond 2^53 is not exact' }) }),
  z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
  temporal('date'),
  temporal('dateTime'),
  temporal('localDateTime'),
  temporal('time'),
  temporal('localTime'),
]);

export type FilterValue = z.infer<typeof filterValueSchema>;

const filterTarget = { on: z.enum(['neighbor', 'relationship']), property: text.max(MAX_FILTER_TEXT) };

/**
 * A condition on the pages of an expansion: the property is one the mapping declares filterable, `on` says whether it is the neighbor's or the relationship's, and the operator is one of three:
 * `eq`, `in` (values of one kind) or `between` (inclusive; `from` or `to` may be left out, not both). Conditions are ANDed.
 */
export const expandFilterSchema = z.union([
  z.strictObject({ ...filterTarget, op: z.literal('eq'), value: filterValueSchema }),
  z.strictObject({ ...filterTarget, op: z.literal('in'), values: z.array(filterValueSchema).min(1).max(MAX_FILTER_VALUES) }),
  z.strictObject({ ...filterTarget, op: z.literal('between'), from: filterValueSchema.optional(), to: filterValueSchema.optional() }),
]);

export type ExpandFilter = z.infer<typeof expandFilterSchema>;

/** What an expansion orders its pages by instead of the observed time: a property the mapping declares sortable, of the neighbor or of the relationship, in ascending or descending order. */
export const expandRankSchema = z.strictObject({ on: z.enum(['neighbor', 'relationship']), property: text.max(MAX_FILTER_TEXT), order: z.enum(['asc', 'desc']) });
export type ExpandRank = z.infer<typeof expandRankSchema>;

/** The shape rules the union cannot say: the values of one `in` and the two ends of one `between` share a kind, and a `between` has an end and is not over booleans. */
export function filterShapeProblem(filter: ExpandFilter): string | undefined {
  if (filter.op === 'in') return filter.values.every((entry) => entry.kind === filter.values[0]?.kind) ? undefined : 'the values of one list have one kind';
  if (filter.op === 'between') {
    if (filter.from === undefined && filter.to === undefined) return 'a range has an end';
    if (filter.from !== undefined && filter.to !== undefined && filter.from.kind !== filter.to.kind) return 'the ends of a range have one kind';
    if ((filter.from ?? filter.to)?.kind === 'boolean') return 'a range is not over booleans';
  }
  return undefined;
}

export const EXPAND_DIRECTIONS = ['out', 'in', 'both'] as const;

/** The one order of a page: the `observed_at` of the relationship's mapping row, newest first, undated last. */
export const EXPAND_SORTS = ['observed'] as const;

/**
 * `POST /v1/graph/expand`: one page of the neighbors of one entity for each asked neighbor type. `limit` is the page size of every type (the source's default when absent); `cursors` holds
 * the `nextCursor` of an earlier page for the types that continue. `mask` is carried because the answer follows the masking setting.
 */
export const expandRequestSchema = z.strictObject({
  sourceId: text,
  ref: z.strictObject({ entityType: text, stableId: referenceTextSchema }),
  relTypes: z.array(text).min(1).optional(),
  neighborTypes: z.array(text).min(1),
  direction: z.enum(EXPAND_DIRECTIONS).optional(),
  sort: z.enum(EXPAND_SORTS).optional(),
  rank: expandRankSchema.optional(),
  filters: z
    .array(expandFilterSchema)
    .min(1)
    .max(MAX_FILTERS)
    .refine((filters) => filters.every((filter) => filterShapeProblem(filter) === undefined), { message: 'a condition has a bad shape' })
    .optional(),
  limit: z.number().int().optional(),
  cursors: z.record(text, text).optional(),
  mask: z.boolean().optional(),
});

/** The page of one neighbor type: how many relationships it holds, whether there is more, and where the next page starts. `matchingTotal` has a value only when the first page holds everything. */
export const expandPageSchema = z.strictObject({
  neighborType: text,
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  matchingTotal: countSchema,
  nextCursor: text.optional(),
});

export const expandResponseSchema = z.strictObject({
  ref: z.strictObject({ sourceId: text, entityType: text, stableId: referenceTextSchema }),
  pageSize: z.number().int().positive(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  pages: z.array(expandPageSchema),
  warnings: z.array(z.string()),
});

export type ExpandRequest = z.infer<typeof expandRequestSchema>;
export type ExpandPage = z.infer<typeof expandPageSchema>;
export type ExpandResponse = z.infer<typeof expandResponseSchema>;
