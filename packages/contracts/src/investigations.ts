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
export type InvestigationSourceState = (typeof INVESTIGATION_SOURCE_STATES)[number];
