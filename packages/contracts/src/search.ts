import { z } from 'zod';
import { nodeSchema, storedEdgeRefSchema } from './graph.js';

/** A stable ID can be one character, so an exact search takes one; the minimum of 2 belongs to type-ahead. */
export const MIN_SEARCH_TEXT_LENGTH = 1;
export const MAX_SEARCH_TEXT_LENGTH = 200;
export const MIN_TYPEAHEAD_TEXT_LENGTH = 2;

/** The most hits a result group shows by default; a source whose `max_page` is lower shows that many, and a group that has more is a `lowerBound` count of the cap. */
export const SEARCH_GROUP_CAP = 25;

export const SEARCH_DISABLED_REASONS = ['index-unavailable'] as const;

/** The groups of a search answer, in the order the page shows them. */
export const SEARCH_GROUPS = ['exact', 'related', 'evidence', 'startsWith'] as const;

/** Why a relationship mapping row is not searched for evidence: its relationship index is not online, or the row has no `stable_id` to name a relationship by. */
export const SEARCH_EVIDENCE_DISABLED_REASONS = ['index-unavailable', 'no-stable-id'] as const;

/** The match modes a facet counts, and the groups a selection can choose: the order the page shows them. */
export const SEARCH_MATCH_MODES = ['exact', 'related', 'evidence'] as const;

/** What a failure can name: a result group, or the facet read, which is not a result group and is never counted as one. */
export const SEARCH_FAILURE_GROUPS = [...SEARCH_GROUPS, 'facets'] as const;

/** The scopes of the counts of the facets: the entries of the entity-type facet, of the match-mode facet and the total. */
export const FACET_SCOPES = { entityType: 'search:facet:entityType', matchMode: 'search:facet:matchMode', total: 'search:facet:total' } as const;

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

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

/** The selection of a search: the entity types and the match modes to narrow it to, each a non-empty list of different names, absent when it does not narrow; a name is checked against the source's mapping. */
const selection = {
  entityTypes: z.array(z.string().min(1)).min(1).refine(unique, { message: 'an entity type is chosen once' }).optional(),
  matchModes: z.array(z.enum(SEARCH_MATCH_MODES)).min(1).refine(unique, { message: 'a match mode is chosen once' }).optional(),
};

/** `POST /v1/search/entities`: one source, one text, optionally with the `pii` fields masked and narrowed to chosen entity types and match modes. With `typeahead` the text is 2 to 200 characters and no selection is taken. */
export const searchRequestSchema = z.union([
  z.strictObject({ ...requestBase, ...selection, text: searchTextSchema, typeahead: z.literal(false).optional() }),
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

function facetCountSchema<Scope extends string>(scope: Scope) {
  return z.union([
    z.strictObject({ value: z.number().int().nonnegative(), quality: z.enum(['exact', 'lowerBound']), scope: z.literal(scope) }),
    z.strictObject({ quality: z.literal('unknown'), scope: z.literal(scope) }),
  ]);
}

/**
 * The size of the match set of the typed text, whatever is selected, as bounded probes of one read: an entry for each entity type that has an eligible `search` or `reference` target (the entities of that
 * type matched by either, each counted once), an entry for each match mode that has an eligible target (distinct entities for `exact` and `related`, supporting relationships for `evidence`) and the
 * total of the entities matched by any target. Every count is exact up to and including the cap and a lower bound above it; none is a sum of the others.
 */
export const facetsSchema = z.union([
  z.strictObject({ searchable: z.literal(false) }),
  z.strictObject({
    searchable: z.literal(true),
    total: facetCountSchema(FACET_SCOPES.total),
    entityType: z.array(z.strictObject({ entityType: z.string().min(1), count: facetCountSchema(FACET_SCOPES.entityType) })),
    matchMode: z.array(z.strictObject({ mode: z.enum(SEARCH_MATCH_MODES), count: facetCountSchema(FACET_SCOPES.matchMode) })),
  }),
]);

/** The selection the answer was made for: the entity types and the match modes asked for, each empty when the request did not narrow by it. */
export const filtersSchema = z.strictObject({ entityTypes: z.array(z.string().min(1)), matchModes: z.array(z.enum(SEARCH_MATCH_MODES)) });

/** A group whose read failed while the other group's was answered: the group has no hits and an `unknown` count, and a retry repeats the whole search. */
export const groupFailureSchema = z.strictObject({
  group: z.enum(SEARCH_FAILURE_GROUPS),
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

/** A relationship mapping row left out of the evidence group: the relationship type and the entity types of its ends. */
export const disabledRelationshipSchema = z.strictObject({ relationshipType: z.string().min(1), from: z.string().min(1), to: z.string().min(1), reason: z.enum(SEARCH_EVIDENCE_DISABLED_REASONS) });

/** A rule of the mapping that uses the hit's relationship type: configured, not proof that the relationship supports a derived relationship. */
export const evidenceRuleSchema = z.strictObject({ ruleId: z.string().min(1), ruleVersion: z.number().int().positive() });

/** A relationship that carries the searched record ID in an evidence property: its reference, the values of all its evidence properties and the configured rules that use its type. */
export const evidenceHitSchema = z.strictObject({
  supports: storedEdgeRefSchema,
  records: z.array(z.strictObject({ sourceRecordId: z.string().min(1) })).min(1),
  rules: z.array(evidenceRuleSchema),
});

/** The evidence records of a search: the relationships whose evidence properties hold the typed text, from one read of their own. */
export const evidenceGroupSchema = z.strictObject({
  hits: z.array(evidenceHitSchema),
  /** The supporting relationships held: exact up to and including the cap, a lower bound when the read found more, unknown for a group whose read failed. */
  count: groupCountSchema,
  /** False when the group had no relationship row to read (no evidence property, every row left out, or a type-ahead request). */
  searchable: z.boolean(),
  disabledRelationshipTypes: z.array(disabledRelationshipSchema),
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
    evidence: evidenceGroupSchema,
    /** The groups whose read failed while another group's was answered; empty when every read answered. */
    failures: z.array(groupFailureSchema),
    dropped: droppedSchema,
    warnings: z.array(z.string()),
    elapsedMs: z.number().int().nonnegative(),
    /** Present exactly when the request asked for type-ahead. */
    startsWith: startsWithGroupSchema.optional(),
    /** The counts of the whole match set; present in every answer that is not a type-ahead answer. */
    facets: facetsSchema.optional(),
    /** The selection the answer was made for; present in every answer that is not a type-ahead answer. */
    filters: filtersSchema.optional(),
  })
  .superRefine((result, context) => {
    const failedAll = new Set(result.failures.map((failure) => failure.group));
    const failed = new Set([...failedAll].filter((group) => group !== 'facets'));
    if (failedAll.size !== result.failures.length) context.addIssue({ code: 'custom', message: 'a group fails once', path: ['failures'] });
    const read = (result.searchable ? 1 : 0) + (result.related.searchable ? 1 : 0) + (result.evidence.searchable ? 1 : 0) + (result.startsWith !== undefined && result.searchable ? 1 : 0);
    if (failed.size > 0 && failed.size >= read) context.addIssue({ code: 'custom', message: 'when every group read failed the search failed as a whole and has no answer', path: ['failures'] });
    const unread = [
      ...(failed.has('exact') && !result.searchable ? ['exact'] : []),
      ...(failed.has('related') && !result.related.searchable ? ['related'] : []),
      ...(failed.has('evidence') && !result.evidence.searchable ? ['evidence'] : []),
    ];
    if (unread.length > 0) context.addIssue({ code: 'custom', message: 'a group that was not read cannot have failed', path: ['failures'] });
    if ((result.counts.exact.quality === 'unknown') !== failed.has('exact') || (failed.has('exact') && result.exact.length > 0)) {
      context.addIssue({ code: 'custom', message: 'the exact count is unknown, and the group empty, exactly when its read failed', path: ['counts', 'exact'] });
    }
    if ((result.related.count.quality === 'unknown') !== failed.has('related') || (failed.has('related') && result.related.hits.length > 0)) {
      context.addIssue({ code: 'custom', message: 'the related count is unknown, and the group empty, exactly when its read failed', path: ['related', 'count'] });
    }
    if ((result.evidence.count.quality === 'unknown') !== failed.has('evidence') || (failed.has('evidence') && result.evidence.hits.length > 0)) {
      context.addIssue({ code: 'custom', message: 'the evidence count is unknown, and the group empty, exactly when its read failed', path: ['evidence', 'count'] });
    }
    if (result.startsWith === undefined) {
      if (failed.has('startsWith')) context.addIssue({ code: 'custom', message: 'a startsWith failure needs the startsWith group', path: ['failures'] });
      if (result.facets === undefined) context.addIssue({ code: 'custom', message: 'an answer that is not a type-ahead answer holds the facets', path: ['facets'] });
      if (result.filters === undefined) context.addIssue({ code: 'custom', message: 'an answer that is not a type-ahead answer holds the filters', path: ['filters'] });
      const facetsFailed = failedAll.has('facets');
      if (result.facets !== undefined) {
        const unreadTotal = result.facets.searchable && result.facets.total.quality === 'unknown';
        if (facetsFailed !== unreadTotal) context.addIssue({ code: 'custom', message: 'the facet total is unknown, and the facets empty, exactly when the facet read failed', path: ['facets', 'total'] });
        if (facetsFailed && (!result.facets.searchable || result.facets.entityType.length > 0 || result.facets.matchMode.length > 0)) {
          context.addIssue({ code: 'custom', message: 'a failed facet read has searchable facets with no entries', path: ['facets'] });
        }
        if (result.facets.searchable && !facetsFailed) {
          const unknown = [result.facets.total, ...result.facets.entityType.map((entry) => entry.count), ...result.facets.matchMode.map((entry) => entry.count)].some((count) => count.quality === 'unknown');
          if (unknown) context.addIssue({ code: 'custom', message: 'a facet count is unknown only when the facet read failed', path: ['facets'] });
        }
      }
      if (result.facets !== undefined && result.facets.searchable) {
        if (new Set(result.facets.entityType.map((entry) => entry.entityType)).size !== result.facets.entityType.length) context.addIssue({ code: 'custom', message: 'an entity type has one facet entry', path: ['facets', 'entityType'] });
        if (new Set(result.facets.matchMode.map((entry) => entry.mode)).size !== result.facets.matchMode.length) context.addIssue({ code: 'custom', message: 'a match mode has one facet entry', path: ['facets', 'matchMode'] });
      }
      return;
    }
    if (result.facets !== undefined || result.filters !== undefined) context.addIssue({ code: 'custom', message: 'a type-ahead answer holds neither facets nor filters', path: ['facets'] });
    if (failedAll.has('facets')) context.addIssue({ code: 'custom', message: 'a type-ahead answer reads no facets, so none fails', path: ['failures'] });
    if ((result.startsWith.count.quality === 'unknown') !== failed.has('startsWith') || (failed.has('startsWith') && result.startsWith.nodes.length > 0)) {
      context.addIssue({ code: 'custom', message: 'the startsWith count is unknown, and the group empty, exactly when its read failed', path: ['startsWith', 'count'] });
    }
  });

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type DisabledType = z.infer<typeof disabledTypeSchema>;
export type RelatedHit = z.infer<typeof relatedHitSchema>;
export type RelatedGroup = z.infer<typeof relatedGroupSchema>;
export type EvidenceHit = z.infer<typeof evidenceHitSchema>;
export type EvidenceGroup = z.infer<typeof evidenceGroupSchema>;
export type DisabledRelationship = z.infer<typeof disabledRelationshipSchema>;
export type StartsWithGroup = z.infer<typeof startsWithGroupSchema>;
export type GroupFailure = z.infer<typeof groupFailureSchema>;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];
export type SearchFailureGroup = (typeof SEARCH_FAILURE_GROUPS)[number];
export type SearchMatchMode = (typeof SEARCH_MATCH_MODES)[number];
export type Facets = z.infer<typeof facetsSchema>;
export type SearchFilters = z.infer<typeof filtersSchema>;
