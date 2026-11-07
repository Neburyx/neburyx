import { z } from 'zod';
import { stableIdSchema } from './entities.js';
import { elementRefSchema, nodeSchema } from './graph.js';

/** The longest case reference and title, in characters (the database checks the same limits). */
export const MAX_CASE_REF_LENGTH = 100;
export const MAX_TITLE_LENGTH = 200;

const codePoints = (text: string): number => Array.from(text).length;
const text = z.string().min(1);

export const INVESTIGATION_STATUSES = ['open', 'closed', 'archived'] as const;

/** Whether the source of an investigation can be read as it was: it can, it is no longer in the configuration, or it now points at another database. Decided without reading the source. */
export const INVESTIGATION_SOURCE_STATES = ['available', 'removed', 'repointed'] as const;

export const caseRefSchema = text.refine((value) => codePoints(value) <= MAX_CASE_REF_LENGTH, { message: 'a case reference is at most 100 characters' }).meta({ maxLength: MAX_CASE_REF_LENGTH });

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
export const openInvestigationRequestSchema = z.strictObject({
  sourceId: text,
  entity: elementRefSchema.extend({ stableId: stableIdSchema }),
  caseRef: caseRefSchema.optional(),
  mask: z.boolean().optional(),
});

const availableInvestigationSchema = investigationSchema.extend({ sourceState: z.literal('available') });
const unavailableInvestigationSchema = investigationSchema.extend({ sourceState: z.enum(INVESTIGATION_SOURCE_STATES).exclude(['available']) });

/** An investigation whose source is as it was comes with the entity that was read. One whose source is not (removed or pointing at another database) was resumed, and nothing was read from the source, so there is no entity. */
export const openInvestigationResponseSchema = z.union([
  z.strictObject({ investigation: availableInvestigationSchema, created: z.boolean(), entity: nodeSchema }),
  z.strictObject({ investigation: unavailableInvestigationSchema, created: z.literal(false) }),
]);

const refEntry = z.strictObject({ t: text, id: text });
const edgeEntry = z.strictObject({ t: text, from: text, to: text, id: text.optional() });

export const layoutDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  viewport: z.strictObject({ zoom: z.number(), x: z.number(), y: z.number() }).optional(),
  layout: text,
  nodes: z.array(refEntry.extend({ x: z.number().optional(), y: z.number().optional(), pinned: z.boolean(), hidden: z.boolean(), groupId: text.nullable() })),
  edges: z.array(edgeEntry.extend({ hidden: z.boolean() })),
  groups: z.array(z.strictObject({ id: text, label: text, by: text, members: z.array(refEntry) })),
});

export const queryContextDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  loaded: z.strictObject({ nodes: z.array(refEntry), edges: z.array(edgeEntry) }),
  expansions: z.array(z.strictObject({ from: refEntry, relTypes: z.array(text), neighborTypes: z.array(text), window: z.unknown().nullable(), sort: text, pages: z.number().int().min(1) })),
  filters: z.strictObject({
    entityTypes: z.array(text),
    relTypes: z.array(text),
    time: z.unknown().nullable(),
    properties: z.array(z.strictObject({ key: text, op: text, values: z.array(text) })),
  }),
});

export const draftSchema = z.strictObject({ version: z.number().int().min(1), layout: layoutDocumentSchema, queryContext: queryContextDocumentSchema });

export const investigationResponseSchema = z.strictObject({ investigation: investigationSchema, draft: draftSchema });

export type Investigation = z.infer<typeof investigationSchema>;
export type OpenInvestigationRequest = z.infer<typeof openInvestigationRequestSchema>;
export type OpenInvestigationResponse = z.infer<typeof openInvestigationResponseSchema>;
export type LayoutDocument = z.infer<typeof layoutDocumentSchema>;
export type QueryContextDocument = z.infer<typeof queryContextDocumentSchema>;
export type InvestigationResponse = z.infer<typeof investigationResponseSchema>;
export type InvestigationListItem = z.infer<typeof investigationListItemSchema>;
export type InvestigationListResponse = z.infer<typeof investigationListResponseSchema>;
export type InvestigationListCounts = z.infer<typeof investigationListCountsSchema>;
export type InvestigationSave = z.infer<typeof investigationSaveSchema>;
export type InvestigationSourceState = (typeof INVESTIGATION_SOURCE_STATES)[number];
