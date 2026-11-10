import { z } from 'zod';
import { referenceTextSchema, referenceValueSchema } from './entities.js';
import { elementRefSchema, nodeSchema } from './graph.js';

/** The longest case reference and title, in characters (the database checks the same limits). */
export const MAX_CASE_REF_LENGTH = 100;
export const MAX_TITLE_LENGTH = 200;

const codePoints = (text: string): number => Array.from(text).length;
const text = z.string().min(1);

const holdsNoNulOrLoneSurrogate = (value: string): boolean => !value.includes('\u0000') && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);

/** The longest note of a draft or a named view, in characters (the database checks the same limit). */
export const MAX_NOTES_LENGTH = 10_000;

/** The note of the Save dialog that a draft carries; `null` when there is none. */
export const notesSchema = z
  .string()
  .refine(holdsNoNulOrLoneSurrogate, { message: 'a note has no NUL and no unpaired surrogate' })
  .refine((value) => codePoints(value) <= MAX_NOTES_LENGTH, { message: 'a note is at most 10,000 characters' })
  .meta({ maxLength: MAX_NOTES_LENGTH })
  .nullable();

export const INVESTIGATION_STATUSES = ['open', 'closed', 'archived'] as const;

/** Whether the source of an investigation can be read as it was: it can, it is no longer in the configuration, or it now points at another database. Decided without reading the source. */
export const INVESTIGATION_SOURCE_STATES = ['available', 'removed', 'repointed'] as const;

export const caseRefSchema = text.refine(holdsNoNulOrLoneSurrogate, { message: 'a case reference has no NUL and no unpaired surrogate' }).refine((value) => codePoints(value) <= MAX_CASE_REF_LENGTH, { message: 'a case reference is at most 100 characters' }).meta({ maxLength: MAX_CASE_REF_LENGTH });

export const startingEntitySchema = z.strictObject({ entityType: text, stableId: text });

export const investigationSchema = z.strictObject({
  id: z.uuid(),
  sourceId: text,
  title: text,
  caseRef: caseRefSchema.nullable(),
  status: z.enum(INVESTIGATION_STATUSES),
  startingEntity: startingEntitySchema.nullable(),
  sourceState: z.enum(INVESTIGATION_SOURCE_STATES),
  createdAt: z.iso.datetime(),
  lastEditedAt: z.iso.datetime(),
  version: z.number().int().min(1),
});

/** The most rows `GET /v1/investigations` returns, and how many it returns when `limit` is left out (a list policy of this product; no source sets it). */
export const MAX_INVESTIGATION_LIST_LIMIT = 25;
export const DEFAULT_INVESTIGATION_LIST_LIMIT = 5;

export const INVESTIGATION_LIST_SORTS = ['lastEdited'] as const;

export const investigationListQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^[0-9]+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_INVESTIGATION_LIST_LIMIT))
    .optional(),
  sort: z.enum(INVESTIGATION_LIST_SORTS).optional(),
});

/** `savedAt` is when the named view the draft equals was made. */
export const investigationSaveSchema = z.discriminatedUnion('state', [z.strictObject({ state: z.literal('saved'), savedAt: z.iso.datetime() }), z.strictObject({ state: z.literal('unsaved'), savedAt: z.null() })]);

/** `sourceAlias` is kept for a source taken out of the configuration. */
export const investigationListItemSchema = investigationSchema.extend({ sourceAlias: text, save: investigationSaveSchema });

const exactCountOf = <S extends string>(scope: S) => z.strictObject({ value: z.number().int().nonnegative(), quality: z.literal('exact'), scope: z.literal(scope) });

/** Postgres counts over the same investigations the list shows, whatever the `limit`: `sources` counts every source among them, a source no longer in the configuration too; `savedViews` counts their named views, with the newest `updated_at` among them or `null` when there is none. */
export const investigationListCountsSchema = z.strictObject({
  investigations: exactCountOf('investigations'),
  sources: exactCountOf('investigation-sources'),
  savedViews: z.strictObject({ count: exactCountOf('named-views'), lastEditedAt: z.iso.datetime().nullable() }),
});

export const investigationListResponseSchema = z.strictObject({ items: z.array(investigationListItemSchema), hasMore: z.boolean(), counts: investigationListCountsSchema });

/** `POST /v1/investigations`: open an entity as an investigation. The entity names its own source so a reference to another source is refused, not read. */
const openRequestBase = { sourceId: text, caseRef: caseRefSchema.optional(), mask: z.boolean().optional() };

/** The entity as a reference the API returned (a token for a keyed entity type, the ID as it is for any other, of any length a body carries). */
export const referenceOpenRequestSchema = z.strictObject({ ...openRequestBase, entity: elementRefSchema.extend({ stableId: referenceTextSchema }) });

/** The entity as a raw value to resolve: for a keyed entity type it is accepted only when the request is not masked. */
export const valueOpenRequestSchema = z.strictObject({ ...openRequestBase, entity: z.strictObject({ sourceId: text, entityType: text, value: referenceValueSchema }) });

export const openInvestigationRequestSchema = z.union([referenceOpenRequestSchema, valueOpenRequestSchema]);

/** The version of the caller's draft, which the first write sends in `If-Match`. */
const draftVersionSchema = z.strictObject({ version: z.number().int().min(1) });

const availableInvestigationSchema = investigationSchema.extend({ sourceState: z.literal('available') });
const unavailableInvestigationSchema = investigationSchema.extend({ sourceState: z.enum(INVESTIGATION_SOURCE_STATES).exclude(['available']) });

/** An investigation whose source is as it was comes with the entity that was read. One whose source is not (removed or pointing at another database) was resumed, and nothing was read from the source, so there is no entity. */
export const openInvestigationResponseSchema = z.union([
  z.strictObject({ investigation: availableInvestigationSchema, created: z.boolean(), entity: nodeSchema, draft: draftVersionSchema }),
  z.strictObject({ investigation: unavailableInvestigationSchema, created: z.literal(false), draft: draftVersionSchema }),
]);

const refEntry = z.strictObject({ t: text, id: text });
const edgeFields = { t: text, from: refEntry, to: refEntry, id: text.optional(), ruleId: text.optional() };
const hasOneForm = (edge: { readonly id?: string | undefined; readonly ruleId?: string | undefined }): boolean => edge.id === undefined || edge.ruleId === undefined;
const oneForm = { message: 'a stored relationship has an id, a derived one a rule, an aggregate one neither, and none has both', path: ['ruleId'] };

/** An edge of a stored document: its type and both ends with the entity type of each, because a stable ID is unique per entity type and not across types. An `id` makes it a stored relationship, a `ruleId` a derived one, and neither an aggregate. */
export const edgeEntrySchema = z.strictObject(edgeFields).refine(hasOneForm, oneForm);
const layoutEdgeSchema = z.strictObject({ ...edgeFields, hidden: z.boolean() }).refine(hasOneForm, oneForm);

export const layoutDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  viewport: z.strictObject({ zoom: z.number(), x: z.number(), y: z.number() }).optional(),
  layout: text,
  nodes: z.array(refEntry.extend({ x: z.number().optional(), y: z.number().optional(), pinned: z.boolean(), hidden: z.boolean(), groupId: text.nullable() })),
  edges: z.array(layoutEdgeSchema),
  groups: z.array(z.strictObject({ id: text, label: text, by: text, members: z.array(refEntry) })),
});

export const queryContextDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  loaded: z.strictObject({ nodes: z.array(refEntry), edges: z.array(edgeEntrySchema) }),
  expansions: z.array(z.strictObject({ from: refEntry, relTypes: z.array(text), neighborTypes: z.array(text), window: z.unknown().nullable(), sort: text, pages: z.number().int().min(1) })),
  filters: z.strictObject({
    entityTypes: z.array(text),
    relTypes: z.array(text),
    time: z.unknown().nullable(),
    properties: z.array(z.strictObject({ key: text, op: text, values: z.array(text) })),
  }),
});

export const draftSchema = z.strictObject({ version: z.number().int().min(1), layout: layoutDocumentSchema, queryContext: queryContextDocumentSchema, notes: notesSchema });

/** The most a stored document may hold, in bytes of its JSON text (data-model §5.2: 1 MB per document). */
export const MAX_DRAFT_DOCUMENT_BYTES = 1_048_576;

/** `PUT /v1/investigations/{id}/draft`; the draft's `version` goes in `If-Match`. */
/** `notes` is required: a client writes back the note it last received, and nothing in a write leaves it out. */
export const draftWriteRequestSchema = z.strictObject({ layout: layoutDocumentSchema, queryContext: queryContextDocumentSchema, notes: notesSchema });

/** The new version of the draft, and whether it now equals a named view. */
export const draftWriteResponseSchema = z.strictObject({ version: z.number().int().min(1), save: investigationSaveSchema, notes: notesSchema });

/** A title as typed: at least one character that is not whitespace, at most `MAX_TITLE_LENGTH` code points, no NUL and no unpaired surrogate. */
export const investigationTitleSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'a title is not empty or only whitespace' })
  .refine(holdsNoNulOrLoneSurrogate, { message: 'a title has no NUL and no unpaired surrogate' })
  .refine((value) => codePoints(value) <= MAX_TITLE_LENGTH, { message: 'a title is at most 200 characters' })
  .meta({ maxLength: MAX_TITLE_LENGTH });

/** `PUT /v1/investigations/{id}`: the investigation's own version goes in the body as `expectedVersion`. */
export const renameRequestSchema = z.strictObject({ title: investigationTitleSchema, expectedVersion: z.number().int().min(1) });

export const renameResponseSchema = z.strictObject({ investigation: investigationSchema });

/** `POST /v1/investigations/{id}/status`: the status to move to. */
export const statusChangeRequestSchema = z.strictObject({ status: z.enum(INVESTIGATION_STATUSES), expectedVersion: z.number().int().min(1) });

/** The investigation after a status change, with when it was closed and archived (`null` while it is not). */
export const statusChangeResponseSchema = z.strictObject({ investigation: investigationSchema.extend({ closedAt: z.iso.datetime().nullable(), archivedAt: z.iso.datetime().nullable() }) });

/** Why a saved filter is no longer kept after the mapping changed. A filter has exactly one reason, the first that holds in this order. */
export const DROPPED_FILTER_REASONS = ['type-removed', 'property-removed', 'now-personal', 'not-filterable'] as const;

/** `entityType` and `relType` name a type filter, `property` the key of a property filter. The name is as it was saved, since the mapping that gave it a display name may be gone. */
export const droppedFilterSchema = z.strictObject({ kind: z.enum(['entityType', 'relType', 'property']), name: text, reason: z.enum(DROPPED_FILTER_REASONS) });

/** The items of a draft that the current mapping does not cover: nodes whose entity type is not mapped, and relationships whose type, derived rule or end type is not. They stay in the draft. */
export const unmappedItemsSchema = z.strictObject({ nodes: z.array(refEntry), edges: z.array(edgeEntrySchema) });

export const mappingChangeSchema = z.strictObject({ droppedFilters: z.array(droppedFilterSchema) });

/** `unmapped` is present whenever the source is as it was; `mappingChange` only when the mapping changed since the draft was written. */
export const investigationResponseSchema = z.strictObject({ investigation: investigationSchema, draft: draftSchema, unmapped: unmappedItemsSchema.optional(), mappingChange: mappingChangeSchema.optional() });

export type Investigation = z.infer<typeof investigationSchema>;
export type OpenInvestigationRequest = z.infer<typeof openInvestigationRequestSchema>;
export type ReferenceOpenRequest = z.infer<typeof referenceOpenRequestSchema>;
export type ValueOpenRequest = z.infer<typeof valueOpenRequestSchema>;
export type OpenInvestigationResponse = z.infer<typeof openInvestigationResponseSchema>;
export type LayoutDocument = z.infer<typeof layoutDocumentSchema>;
export type QueryContextDocument = z.infer<typeof queryContextDocumentSchema>;
export type DraftWriteRequest = z.infer<typeof draftWriteRequestSchema>;
export type DraftWriteResponse = z.infer<typeof draftWriteResponseSchema>;
export type RenameRequest = z.infer<typeof renameRequestSchema>;
export type RenameResponse = z.infer<typeof renameResponseSchema>;
export type StatusChangeRequest = z.infer<typeof statusChangeRequestSchema>;
export type StatusChangeResponse = z.infer<typeof statusChangeResponseSchema>;
export type InvestigationResponse = z.infer<typeof investigationResponseSchema>;
export type DroppedFilter = z.infer<typeof droppedFilterSchema>;
export type DroppedFilterReason = (typeof DROPPED_FILTER_REASONS)[number];
export type UnmappedItems = z.infer<typeof unmappedItemsSchema>;
export type MappingChange = z.infer<typeof mappingChangeSchema>;
export type InvestigationListItem = z.infer<typeof investigationListItemSchema>;
export type InvestigationListResponse = z.infer<typeof investigationListResponseSchema>;
export type InvestigationListCounts = z.infer<typeof investigationListCountsSchema>;
export type InvestigationSave = z.infer<typeof investigationSaveSchema>;
export type InvestigationSourceState = (typeof INVESTIGATION_SOURCE_STATES)[number];
