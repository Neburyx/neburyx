import { z } from 'zod';
import { aggregateSchema, countSchema, nodeSchema, propertySchema, storedEdgeRefSchema } from './graph.js';

/** A stable ID can be one character, so an exact search takes one; the minimum of 2 belongs to type-ahead. */
export const MIN_SEARCH_TEXT_LENGTH = 1;
export const MAX_SEARCH_TEXT_LENGTH = 200;
export const MIN_TYPEAHEAD_TEXT_LENGTH = 2;

/** The most hits a result group shows on one page; a source whose `max_page` is lower shows that many, and a group that has more is a `lowerBound` count of the hits held, with a cursor to the next page. */
export const SEARCH_GROUP_CAP = 25;

/** Why a property is not searched: it has no online index, its index is still building, or its index failed. */
export const SEARCH_DISABLED_REASONS = ['index-unavailable', 'index-building', 'index-failed'] as const;

/** The groups of a search answer, in the order the page shows them. */
export const SEARCH_GROUPS = ['exact', 'related', 'evidence', 'startsWith'] as const;

/** The groups that have a next page; `startsWith` is a capped read whose count is a lower bound when it is cut. */
export const SEARCH_PAGED_GROUPS = ['exact', 'related', 'evidence'] as const;

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

/** The cursor of a group's next page: present only when the read found more than the page. It is opaque and signed for this source, person, group, text and selection; another request cannot use it. */
const nextCursorSchema = z.string().min(1);

const droppedCount = z.number().int().nonnegative();

/** The rows the normalize stage left out, by reason. */
export const droppedSchema = z.strictObject({ 'not-mapped': droppedCount, 'ambiguous-type': droppedCount, 'no-stable-id': droppedCount, 'end-not-shown': droppedCount.optional(), 'end-missing': droppedCount.optional(), 'no-mapping-row': droppedCount.optional(), 'not-visible': droppedCount.optional() });

/**
 * A property of an entity type that is not searched, with why; the type's other properties are searched. `typeSearched` is false when none of the type's properties is searched, so the type itself is
 * not searched: every entry of that type says so, and each names its own property and reason.
 */
export const disabledTypeSchema = z.strictObject({ entityType: z.string().min(1), property: z.string().min(1), reason: z.enum(SEARCH_DISABLED_REASONS), typeSearched: z.boolean() });

const disabledTypesSchema = z.array(disabledTypeSchema).superRefine((entries, context) => {
  const named = new Set(entries.map((entry) => JSON.stringify([entry.entityType, entry.property])));
  if (named.size !== entries.length) context.addIssue({ code: 'custom', message: 'a property of a type is named once' });
  const searched = new Map<string, boolean>();
  for (const entry of entries) {
    if (searched.get(entry.entityType) === !entry.typeSearched) context.addIssue({ code: 'custom', message: 'every entry of a type says the same of whether the type is searched' });
    searched.set(entry.entityType, entry.typeSearched);
  }
});

const knownCountSchema = z.strictObject({ value: z.number().int().nonnegative(), quality: z.enum(['exact', 'lowerBound']), scope: z.string().min(1) });
const unreadCountSchema = z.strictObject({ quality: z.literal('unknown'), scope: z.string().min(1) });

/** The count of a result group: exact when the group has no next page, a lower bound of the hits held when it has one, or unknown (no value) for a group whose read failed. */
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
 * total of the entities matched by any target. Every count is exact up to and including the source's count cap (`heavy_op_threshold`) and a lower bound of the cap above it, so it says how far the pages
 * of a group go; none is a sum of the others, and an exact count is never lower than the hits its group holds in the same answer.
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

/**
 * A hit whose stable ID property is missing, empty or not a usable ID (a float, an integer beyond the safe range, another type): it is listed in its group, counted, and paged with the other hits, with
 * its entity type, its title and its shown properties (masked as a node's are), and it holds no reference, no cursor and no element ID, so it cannot be opened or added.
 */
export const unreferencedHitSchema = z.strictObject({
  entityType: z.string().min(1),
  title: z.string(),
  properties: z.array(propertySchema),
  reason: z.literal('no-stable-id'),
});

/** The unreferenced hits of a group's page, in the order they were read; present only when there is one. The group's `dropped['no-stable-id']` is their number. */
const unreferencedListSchema = z.array(unreferencedHitSchema).min(1).optional();

/** A record that holds the searched ID in a `reference` property. The related read adds nothing to `exact` or to its count; an entity that is also an exact match through its own `search` property is in both groups. */
export const relatedHitSchema = z.strictObject({
  node: nodeSchema,
  /** The `reference` properties of the record that hold the typed text, as the search matched them; empty when none can be named. */
  matchedProperties: z.array(z.string().min(1)),
});

/** The related records of a search: the records whose `reference` properties hold the typed text, from one read of their own. */
export const relatedGroupSchema = z.strictObject({
  hits: z.array(relatedHitSchema),
  unreferenced: unreferencedListSchema,
  /** The hits held, the unreferenced ones too: exact when the group has no next page, a lower bound when the read found more, unknown for a group whose read failed. */
  count: groupCountSchema,
  /** False when the group had no property to read (no `reference` property, or only personal-data ones while masked, or every type left out). */
  searchable: z.boolean(),
  disabledTypes: disabledTypesSchema,
  nextCursor: nextCursorSchema.optional(),
});

const rowSchema = { relationshipType: z.string().min(1), from: z.string().min(1), to: z.string().min(1) };

/** An evidence property of a relationship mapping row that the evidence group does not search, named with the row (its relationship type and the entity types of its ends) and why its index is not online. */
export const disabledRelationshipSchema = z.strictObject({ ...rowSchema, property: z.string().min(1), reason: z.enum(SEARCH_DISABLED_REASONS) });

/** A rule of the mapping that uses the hit's relationship type: configured, not proof that the relationship supports a derived relationship. */
export const evidenceRuleSchema = z.strictObject({ ruleId: z.string().min(1), ruleVersion: z.number().int().positive() });

/** One evidence value of a relationship: the value of an evidence property as text, or, for a value that is neither text nor a number, the property that holds it, marked `unreadable`. */
export const evidenceRecordSchema = z.union([z.strictObject({ sourceRecordId: z.string().min(1) }), z.strictObject({ property: z.string().min(1), unreadable: z.literal(true) })]);

const evidenceRecordsSchema = z.array(evidenceRecordSchema).min(1);

/** A stored relationship that carries the searched record ID in an evidence property: its reference, the values of all its evidence properties and the configured rules that use its type. */
export const storedEvidenceHitSchema = z.strictObject({
  supports: storedEdgeRefSchema,
  records: evidenceRecordsSchema,
  rules: z.array(evidenceRuleSchema),
});

/**
 * One relationship of an aggregate that carries the searched record ID. Its element ID is shown as text only: it is never a reference, and nothing is opened or copied by it, because it can name
 * another relationship once this one is deleted.
 */
export const aggregateMemberSchema = z.strictObject({ elementId: z.string().min(1), records: evidenceRecordsSchema, observedAt: z.string().min(1).optional() });

/**
 * The relationships of a type with no `stable_id` between two entities that carry the searched record ID: the aggregate (the type and both ends), its members on this page in element ID order,
 * and their number, a lower bound when more may be on another page.
 */
export const aggregateEvidenceHitSchema = z
  .strictObject({
    aggregate: aggregateSchema,
    members: z.array(aggregateMemberSchema).min(1),
    memberCount: countSchema,
    rules: z.array(evidenceRuleSchema),
  })
  .superRefine((hit, context) => {
    if (new Set(hit.members.map((member) => member.elementId)).size !== hit.members.length) context.addIssue({ code: 'custom', message: 'a member is listed once', path: ['members'] });
    if ((hit.memberCount.quality !== 'exact' && hit.memberCount.quality !== 'lowerBound') || hit.memberCount.value !== hit.members.length) {
      context.addIssue({ code: 'custom', message: 'the member count is the members listed, exact or a lower bound', path: ['memberCount'] });
    }
  });

export const evidenceHitSchema = z.union([storedEvidenceHitSchema, aggregateEvidenceHitSchema]);

/** The relationships a list of evidence hits holds: one for a stored hit, its members for an aggregate; the evidence counts count these. */
export const relationshipsOf = (hits: readonly z.infer<typeof evidenceHitSchema>[]): number => hits.reduce((sum, hit) => sum + ('members' in hit ? hit.members.length : 1), 0);

/** The evidence records of a search: the relationships whose evidence properties hold the typed text, from one read of their own. */
export const evidenceGroupSchema = z.strictObject({
  hits: z.array(evidenceHitSchema),
  /** The supporting relationships held (a stored hit is one, an aggregate its members): exact when the group has no next page, a lower bound when the read found more, unknown for a group whose read failed. */
  count: groupCountSchema,
  /** False when the group had no relationship row to read (no evidence property, every row left out, or a type-ahead request). */
  searchable: z.boolean(),
  disabledRelationshipTypes: z.array(disabledRelationshipSchema),
  nextCursor: nextCursorSchema.optional(),
});

/** The entities whose `search` property starts with the typed text and are not in the exact group; a lower bound when more were read than the cap, never counted as exact matches. It has no next page. */
export const startsWithGroupSchema = z.strictObject({
  nodes: z.array(nodeSchema),
  unreferenced: unreferencedListSchema,
  /** The hits held, the unreferenced ones too. */
  count: groupCountSchema,
  dropped: droppedSchema,
  warnings: z.array(z.string()),
});

export const searchResultSchema = z
  .strictObject({
    sourceId: z.string().min(1),
    exact: z.array(nodeSchema),
    /** The unreferenced hits of the exact group; `counts.exact` includes them. */
    exactUnreferenced: unreferencedListSchema,
    /** The most hits the group shows for this source: 25, or the source's `max_page` when that is lower. */
    cap: z.number().int().positive(),
    /** False when no property was left to search (every type left out, or only personal-data properties while masked), so the answer is not a search that found nothing. */
    searchable: z.boolean(),
    counts: z.strictObject({ exact: groupCountSchema }),
    /** The cursor of the exact group's next page. */
    exactNextCursor: nextCursorSchema.optional(),
    disabledTypes: disabledTypesSchema,
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
    const paged: readonly (readonly [string, string | undefined, z.infer<typeof groupCountSchema> | undefined])[] = [
      ['exactNextCursor', result.exactNextCursor, result.counts.exact],
      ['related', result.related.nextCursor, result.related.count],
      ['evidence', result.evidence.nextCursor, result.evidence.count],
    ];
    for (const [path, cursor, count] of paged) {
      if (cursor !== undefined && count?.quality !== 'lowerBound') context.addIssue({ code: 'custom', message: 'a group with a next page has a lower-bound count', path: [path] });
    }
    if ((result.counts.exact.quality === 'unknown') !== failed.has('exact') || (failed.has('exact') && (result.exact.length > 0 || result.exactUnreferenced !== undefined))) {
      context.addIssue({ code: 'custom', message: 'the exact count is unknown, and the group empty, exactly when its read failed', path: ['counts', 'exact'] });
    }
    if ((result.related.count.quality === 'unknown') !== failed.has('related') || (failed.has('related') && (result.related.hits.length > 0 || result.related.unreferenced !== undefined))) {
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
    if ((result.startsWith.count.quality === 'unknown') !== failed.has('startsWith') || (failed.has('startsWith') && (result.startsWith.nodes.length > 0 || result.startsWith.unreferenced !== undefined))) {
      context.addIssue({ code: 'custom', message: 'the startsWith count is unknown, and the group empty, exactly when its read failed', path: ['startsWith', 'count'] });
    }
  });

/**
 * `POST /v1/search/entities/more`: the next page of one group of a search, from the `nextCursor` that group's last page gave. The text, the mask and the entity types are those of the search the cursor
 * came from; a cursor of another group, text, selection, source or person is refused as `CURSOR_INVALIDATED`. The entity types narrow the `exact` and `related` groups as in the search. The `startsWith`
 * group has no next page, so it is not a group of this request.
 */
export const searchMoreRequestSchema = z.strictObject({
  ...requestBase,
  text: searchTextSchema,
  group: z.enum(SEARCH_PAGED_GROUPS),
  cursor: nextCursorSchema,
  entityTypes: selection.entityTypes,
});

const moreBase = {
  sourceId: z.string().min(1),
  /**
   * The group's count: the hits of every page read so far (the first page, the pages before this one and this one), the unreferenced ones too and, for `evidence`, each supporting relationship
   * (a stored hit is one, an aggregate its members). A lower bound when there is a next page, exact when this is the last; unknown when the read failed. The hits of the earlier pages travel in the
   * signed cursor, so a client shows this count as it is and does not add pages up.
   */
  count: groupCountSchema,
  nextCursor: nextCursorSchema.optional(),
  dropped: droppedSchema,
  warnings: z.array(z.string()),
  /** The read of this page failed with a code of its group: no hit, an unknown count and no cursor; the cursor the request sent can be sent again. */
  failure: groupFailureSchema.optional(),
};

/** The next page of one group, in that group's own shape: entities for `exact`, related records for `related`, supporting relationships for `evidence`. */
export const searchMoreResultSchema = z
  .discriminatedUnion('group', [
    z.strictObject({ ...moreBase, group: z.literal('exact'), nodes: z.array(nodeSchema), unreferenced: unreferencedListSchema }),
    z.strictObject({ ...moreBase, group: z.literal('related'), hits: z.array(relatedHitSchema), unreferenced: unreferencedListSchema }),
    z.strictObject({ ...moreBase, group: z.literal('evidence'), hits: z.array(evidenceHitSchema) }),
  ])
  .superRefine((result, context) => {
    const held = ('nodes' in result ? result.nodes.length : result.group === 'evidence' ? relationshipsOf(result.hits) : result.hits.length) + ('unreferenced' in result ? (result.unreferenced?.length ?? 0) : 0);
    if (result.failure !== undefined) {
      if (result.failure.group !== result.group) context.addIssue({ code: 'custom', message: 'a page fails for its own group', path: ['failure', 'group'] });
      if (held > 0 || result.count.quality !== 'unknown' || result.nextCursor !== undefined) context.addIssue({ code: 'custom', message: 'a failed page has no hit, an unknown count and no cursor', path: ['failure'] });
      return;
    }
    if (result.count.quality === 'unknown') context.addIssue({ code: 'custom', message: 'the count of a page is unknown only when its read failed', path: ['count'] });
    if (result.nextCursor !== undefined && result.count.quality !== 'lowerBound') context.addIssue({ code: 'custom', message: 'a page with a next page has a lower-bound count', path: ['count'] });
  });

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchMoreRequest = z.infer<typeof searchMoreRequestSchema>;
export type SearchMoreResult = z.infer<typeof searchMoreResultSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type DisabledType = z.infer<typeof disabledTypeSchema>;
export type RelatedHit = z.infer<typeof relatedHitSchema>;
export type UnreferencedHit = z.infer<typeof unreferencedHitSchema>;
export type RelatedGroup = z.infer<typeof relatedGroupSchema>;
export type EvidenceHit = z.infer<typeof evidenceHitSchema>;
export type StoredEvidenceHit = z.infer<typeof storedEvidenceHitSchema>;
export type AggregateEvidenceHit = z.infer<typeof aggregateEvidenceHitSchema>;
export type AggregateMember = z.infer<typeof aggregateMemberSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type EvidenceGroup = z.infer<typeof evidenceGroupSchema>;
export type DisabledRelationship = z.infer<typeof disabledRelationshipSchema>;
export type StartsWithGroup = z.infer<typeof startsWithGroupSchema>;
export type GroupFailure = z.infer<typeof groupFailureSchema>;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];
export type SearchPagedGroup = (typeof SEARCH_PAGED_GROUPS)[number];
export type SearchFailureGroup = (typeof SEARCH_FAILURE_GROUPS)[number];
export type SearchMatchMode = (typeof SEARCH_MATCH_MODES)[number];
export type Facets = z.infer<typeof facetsSchema>;
export type SearchFilters = z.infer<typeof filtersSchema>;
