import { z } from 'zod';
import { nodeSchema } from './graph.js';

/** A stable ID can be one character, so an exact search takes one; the minimum of 2 belongs to type-ahead. */
export const MIN_SEARCH_TEXT_LENGTH = 1;
export const MAX_SEARCH_TEXT_LENGTH = 200;
export const MIN_TYPEAHEAD_TEXT_LENGTH = 2;

/** The most hits a result group shows by default; a source whose `max_page` is lower shows that many, and a group that has more is a `lowerBound` count of the cap. */
export const SEARCH_GROUP_CAP = 25;

export const SEARCH_DISABLED_REASONS = ['index-unavailable'] as const;

/** The groups of a search answer, in the order the page shows them. */
export const SEARCH_GROUPS = ['exact', 'related', 'startsWith'] as const;

/** The codes of a read that fails for one group only; every other failure fails the whole search. */
export const SEARCH_GROUP_FAILURE_CODES = ['QUERY_TIMEOUT', 'SOURCE_BUSY', 'RATE_LIMITED', 'INTERNAL_ERROR'] as const;

const codePoints = (value: string): number => Array.from(value).length;

/** The typed text, counted as characters and not as UTF-16 units, which a length limit of the schema would count. */
export const searchTextSchema = z
  .string()
  .refine((value) => codePoints(value) >= MIN_SEARCH_TEXT_LENGTH && codePoints(value) <= MAX_SEARCH_TEXT_LENGTH, { message: 'search text is 1 to 200 characters' })
  .meta({ minLength: MIN_SEARCH_TEXT_LENGTH, maxLength: MAX_SEARCH_TEXT_LENGTH });

/** The text of a type-ahead lookup: 2 to 200 characters, counted as code points. */
export const typeaheadTextSchema = z
  .string()
  .refine((value) => codePoints(value) >= MIN_TYPEAHEAD_TEXT_LENGTH && codePoints(value) <= MAX_SEARCH_TEXT_LENGTH, { message: 'type-ahead text is 2 to 200 characters' })
  .meta({ minLength: MIN_TYPEAHEAD_TEXT_LENGTH, maxLength: MAX_SEARCH_TEXT_LENGTH });

const requestBase = { sourceId: z.string().min(1), mask: z.boolean().optional() };

/** `POST /v1/search/entities`: one source, one text, optionally with the `pii` fields masked. With `typeahead` the text is 2 to 200 characters. */
export const searchRequestSchema = z.union([
  z.strictObject({ ...requestBase, text: searchTextSchema, typeahead: z.literal(false).optional() }),
  /** Asked for by the canvas Search tool only: adds the `startsWith` group to the answer. */
  z.strictObject({ ...requestBase, text: typeaheadTextSchema, typeahead: z.literal(true) }),
]);

const droppedCount = z.number().int().nonnegative();

/** The rows the normalize stage left out, by reason. */
export const droppedSchema = z.strictObject({ 'not-mapped': droppedCount, 'ambiguous-type': droppedCount, 'no-stable-id': droppedCount, 'not-visible': droppedCount.optional() });

export const disabledTypeSchema = z.strictObject({ entityType: z.string().min(1), reason: z.enum(SEARCH_DISABLED_REASONS) });

const knownCountSchema = z.strictObject({ value: z.number().int().nonnegative(), quality: z.enum(['exact', 'lowerBound']), scope: z.string().min(1) });
const unreadCountSchema = z.strictObject({ quality: z.literal('unknown'), scope: z.string().min(1) });

/** The count of a result group: exact up to the cap, a lower bound above it, or unknown (no value) for a group whose read failed. */
const groupCountSchema = z.union([knownCountSchema, unreadCountSchema]);

/** A group whose read failed while the other group's was answered: the group has no hits and an `unknown` count, and a retry repeats the whole search. */
export const groupFailureSchema = z.strictObject({
  group: z.enum(SEARCH_GROUPS),
  code: z.enum(SEARCH_GROUP_FAILURE_CODES),
  /** The budget of a read that timed out, in milliseconds. */
  timeoutMs: z.number().int().positive().optional(),
});

/** A record that holds the searched ID in a `reference` property. The related read adds nothing to `exact` or to its count; an entity that is also an exact match through its own `search` property is in both groups. */
export const relatedHitSchema = z.strictObject({
  node: nodeSchema,
  /** The `reference` properties of the record that hold the typed text, as the search matched them; empty when none can be named. */
  matchedProperties: z.array(z.string().min(1)),
});

/** The related records of a search: the records whose `reference` properties hold the typed text, from one read of their own. */
export const relatedGroupSchema = z.strictObject({
  hits: z.array(relatedHitSchema),
  /** The hits held: exact up to and including the cap, a lower bound when the read found more, unknown for a group whose read failed. */
  count: groupCountSchema,
  /** False when the group had no property to read (no `reference` property, or only personal-data ones while masked, or every type left out). */
  searchable: z.boolean(),
  disabledTypes: z.array(disabledTypeSchema),
});

/** The entities whose `search` property starts with the typed text and are not in the exact group; a lower bound when more were read than the cap, never counted as exact matches. */
export const startsWithGroupSchema = z.strictObject({
  nodes: z.array(nodeSchema),
  count: groupCountSchema,
  dropped: droppedSchema,
  warnings: z.array(z.string()),
});

export const searchResultSchema = z
  .strictObject({
    sourceId: z.string().min(1),
    exact: z.array(nodeSchema),
    /** The most hits the group shows for this source: 25, or the source's `max_page` when that is lower. */
    cap: z.number().int().positive(),
    /** False when no property was left to search (every type left out, or only personal-data properties while masked), so the answer is not a search that found nothing. */
    searchable: z.boolean(),
    counts: z.strictObject({ exact: groupCountSchema }),
    disabledTypes: z.array(disabledTypeSchema),
    related: relatedGroupSchema,
    /** The groups whose read failed while another group's was answered; empty when every read answered. */
    failures: z.array(groupFailureSchema),
    dropped: droppedSchema,
    warnings: z.array(z.string()),
    elapsedMs: z.number().int().nonnegative(),
    /** Present exactly when the request asked for type-ahead. */
    startsWith: startsWithGroupSchema.optional(),
  })
  .superRefine((result, context) => {
    const failed = new Set(result.failures.map((failure) => failure.group));
    if (failed.size !== result.failures.length) context.addIssue({ code: 'custom', message: 'a group fails once', path: ['failures'] });
    const read = 1 + (result.related.searchable ? 1 : 0) + (result.startsWith === undefined ? 0 : 1);
    if (failed.size >= read) context.addIssue({ code: 'custom', message: 'when every group read failed the search failed as a whole and has no answer', path: ['failures'] });
    if ((result.counts.exact.quality === 'unknown') !== failed.has('exact') || (failed.has('exact') && result.exact.length > 0)) {
      context.addIssue({ code: 'custom', message: 'the exact count is unknown, and the group empty, exactly when its read failed', path: ['counts', 'exact'] });
    }
    if ((result.related.count.quality === 'unknown') !== failed.has('related') || (failed.has('related') && result.related.hits.length > 0)) {
      context.addIssue({ code: 'custom', message: 'the related count is unknown, and the group empty, exactly when its read failed', path: ['related', 'count'] });
    }
    if (result.startsWith === undefined) {
      if (failed.has('startsWith')) context.addIssue({ code: 'custom', message: 'a startsWith failure needs the startsWith group', path: ['failures'] });
      return;
    }
    if ((result.startsWith.count.quality === 'unknown') !== failed.has('startsWith') || (failed.has('startsWith') && result.startsWith.nodes.length > 0)) {
      context.addIssue({ code: 'custom', message: 'the startsWith count is unknown, and the group empty, exactly when its read failed', path: ['startsWith', 'count'] });
    }
  });

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type DisabledType = z.infer<typeof disabledTypeSchema>;
export type RelatedHit = z.infer<typeof relatedHitSchema>;
export type RelatedGroup = z.infer<typeof relatedGroupSchema>;
export type StartsWithGroup = z.infer<typeof startsWithGroupSchema>;
export type GroupFailure = z.infer<typeof groupFailureSchema>;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];
