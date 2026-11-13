import { z } from 'zod';
import type { AuditEvent } from './audit.js';
import { countSchema, elementRefSchema, nodeSchema, type Count, type ElementRef } from './graph.js';
import { codePoints } from './investigations.js';
import { referenceTextSchema } from './entities.js';
import { EXPAND_DIRECTIONS, EXPAND_SORTS } from './expand.js';
import { searchResultSchema, searchTextSchema } from './search.js';
import { degreePreviewSchema } from './degree-preview.js';
import { derivedNeighborsResponseSchema } from './derived-neighbors.js';
import { derivedEdgeDetailSchema } from './edge-detail.js';
import { expandResponseSchema } from './expand.js';
import { linkedEntitiesParamsSchema, sharedAttributeParamsSchema, templateRunResponseSchema, windowSchema } from './template-run.js';

/** The longest question the plan endpoint takes, in characters. */
export const ASK_MESSAGE_MAX_LENGTH = 1000;
/** The longest rationale or reason a plan carries, in characters. */
export const ASK_TEXT_MAX_LENGTH = 500;

/** A preview hash: the 64 lowercase hex characters of an HMAC. */
export const ASK_PREVIEW_HASH_PATTERN = /^[0-9a-f]{64}$/;

const askText = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => codePoints(value) <= max, { message: `at most ${max} characters` })
    .meta({ maxLength: max });

const planShape = { kind: z.literal('plan'), templateVersion: z.number().int().min(1), rationale: askText(ASK_TEXT_MAX_LENGTH) };

const name = z.string().min(1);
const anchor = z.strictObject({ entityType: name, stableId: referenceTextSchema });

/**
 * The typed parameters of each template Ask can plan. Each holds what the template's request holds that a plan may choose, and none holds a source, a mask, a cursor or a continue flag: the application sets those.
 * `limit` is at least 1; its upper bound is the source's, checked when the plan runs.
 */
export const ASK_PLAN_PARAMS = {
  'shared-attribute': sharedAttributeParamsSchema,
  'linked-entities': linkedEntitiesParamsSchema,
  entity: z.strictObject({ ref: anchor }),
  'degree-preview': z.strictObject({ ref: anchor }),
  expand: z.strictObject({
    ref: anchor,
    relTypes: z.array(name).min(1).optional(),
    neighborTypes: z.array(name).min(1),
    direction: z.enum(EXPAND_DIRECTIONS).optional(),
    sort: z.enum(EXPAND_SORTS).optional(),
    window: windowSchema.optional(),
    limit: z.number().int().min(1).optional(),
  }),
  'derived-rule-run': z.strictObject({ ref: anchor, ruleId: name }),
  'derived-edge-support': z.strictObject({ ruleId: name, ends: z.tuple([anchor, anchor]) }),
  search: z.strictObject({ entityTypes: z.array(name).min(1), text: searchTextSchema }),
} as const;

export const ASK_PLAN_TEMPLATE_IDS = Object.keys(ASK_PLAN_PARAMS) as (keyof typeof ASK_PLAN_PARAMS)[];

/** The JSON Schema of the parameters of one template's plan, as Zod writes it from the contract schema: the one source of the catalog the planner shows the model. */
export function askPlanParamsJsonSchema(id: keyof typeof ASK_PLAN_PARAMS): Record<string, unknown> {
  return z.toJSONSchema(ASK_PLAN_PARAMS[id], { io: 'input', unrepresentable: 'throw' });
}

/** The names of the parameters of every plan schema, for the vocabulary the allowlist reads. */
export const ASK_PLAN_PARAM_NAMES: readonly string[] = [...new Set(Object.values(ASK_PLAN_PARAMS).flatMap((schema) => Object.keys(schema.shape)))];

const planOf = <Id extends keyof typeof ASK_PLAN_PARAMS>(id: Id) => z.strictObject({ ...planShape, templateId: z.literal(id), params: ASK_PLAN_PARAMS[id] });

/** A plan of one template of the catalog with its typed parameters. */
const templatePlanSchema = z.union([
  planOf('shared-attribute'),
  planOf('linked-entities'),
  planOf('entity'),
  planOf('degree-preview'),
  planOf('expand'),
  planOf('derived-rule-run'),
  planOf('derived-edge-support'),
  planOf('search'),
]);
const unsupportedPlanSchema = z.strictObject({ kind: z.literal('unsupported'), reason: askText(ASK_TEXT_MAX_LENGTH) });

/** What a planner answers: a template of the catalog with its typed parameters, or `unsupported`. Nothing in it is query text. */
export const askPlanSchema = z.union([templatePlanSchema, unsupportedPlanSchema]);

const askClarificationSchema = z.strictObject({
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  choices: z.array(elementRefSchema),
  count: countSchema,
  unreferenced: z.number().int().min(0),
});

const askBlockedTokenSchema = z.strictObject({ text: z.string().min(1), start: z.number().int().min(0), end: z.number().int().min(1) });

/** What the plan endpoint answers: a plan, a clarification to resolve, the tokens that stop the question, or the preview with its hash (`changed` when a hash sent with `send: true` was not the one of the current preview). */
export const askPlanResponseSchema = z.union([
  /** A plan of a template is stored when it is answered: it comes with its ID and the time it stops being runnable. A plan that is `unsupported` is not stored and has neither. */
  z.strictObject({ plan: templatePlanSchema, planId: z.uuid(), expiresAt: z.iso.datetime() }),
  z.strictObject({ plan: unsupportedPlanSchema }),
  z.strictObject({ clarification: askClarificationSchema }),
  z.strictObject({ blocked: z.strictObject({ tokens: z.array(askBlockedTokenSchema).min(1) }) }),
  z.strictObject({ preview: z.string().min(1), previewHash: z.string().regex(ASK_PREVIEW_HASH_PATTERN), changed: z.literal(true).optional() }),
]);

/** The most resolutions one request carries. */
export const ASK_MAX_RESOLUTIONS = 10;

const spanShape = { start: z.number().int().min(0), end: z.number().int().min(1) };

/**
 * What the investigator chose for a span of the typed message, counted in UTF-16 code units: an entity of the source for it (**Pick an entity**), or to use it as a value to search for. A span has one form or the other.
 */
export const askResolutionSchema = z
  .union([z.strictObject({ ...spanShape, ref: elementRefSchema }), z.strictObject({ ...spanShape, value: z.literal(true) })])
  .refine((resolution) => resolution.end > resolution.start, { message: 'a span is not empty' });

export const askResolutionsSchema = z.array(askResolutionSchema).max(ASK_MAX_RESOLUTIONS);

/**
 * What `POST /v1/ask/edit` takes: the plan to change, the template (which must be the plan's own) and the new parameters of it, in which every reference carries the `sourceId` it is in, so a reference
 * of another source than the plan's is refused. The parameters are checked against the template's own schema and the mapping, not here.
 */
export const askEditRequestSchema = z.strictObject({ planId: z.uuid(), templateId: z.enum(ASK_PLAN_TEMPLATE_IDS), params: z.record(z.string(), z.unknown()) });

/** What `POST /v1/ask/edit` answers: the new plan, stored as `proposed` with its own ID and expiry; the old one is cancelled. */
export const askEditResponseSchema = z.strictObject({ plan: templatePlanSchema, planId: z.uuid(), expiresAt: z.iso.datetime() });

export const askCancelRequestSchema = z.strictObject({ planId: z.uuid() });

export const askCancelResponseSchema = z.strictObject({ planId: z.uuid(), state: z.literal('cancelled') });

/** What `POST /v1/ask/run` takes: the plan to run and, as every read of the product does, whether the personal data of the nodes of the answer is masked. */
export const askRunRequestSchema = z.strictObject({ planId: z.uuid(), mask: z.boolean().optional() });

export const ASK_RUN_OUTCOMES = ['complete', 'partial', 'failed'] as const;

/** What a run of a plan answers: the template it ran and the answer of the service its manual route uses, whole, so a run reads exactly as the person's own click would. */
export const askRunResultSchema = z.union([
  z.strictObject({ templateId: z.literal('shared-attribute'), result: templateRunResponseSchema }),
  z.strictObject({ templateId: z.literal('linked-entities'), result: templateRunResponseSchema }),
  z.strictObject({ templateId: z.literal('entity'), result: nodeSchema }),
  z.strictObject({ templateId: z.literal('degree-preview'), result: degreePreviewSchema }),
  z.strictObject({ templateId: z.literal('expand'), result: expandResponseSchema }),
  z.strictObject({ templateId: z.literal('derived-rule-run'), result: derivedNeighborsResponseSchema }),
  z.strictObject({ templateId: z.literal('derived-edge-support'), result: derivedEdgeDetailSchema }),
  z.strictObject({ templateId: z.literal('search'), result: searchResultSchema }),
]);

/** `complete` or `partial` (the result reports a cut); a run that failed answers the error of the read, and only the run's own record says `failed`. */
export const ASK_RUN_ANSWER_OUTCOMES = ['complete', 'partial'] as const;

export const askRunResponseSchema = z.strictObject({ planId: z.uuid(), outcome: z.enum(ASK_RUN_ANSWER_OUTCOMES), result: askRunResultSchema });

export type AskPlan = z.infer<typeof askPlanSchema>;
export type AskPlanRequest = z.infer<typeof askPlanRequestSchema>;
export type AskRunResult = z.infer<typeof askRunResultSchema>;
export type AskEditRequest = z.infer<typeof askEditRequestSchema>;
export type AskCancelRequest = z.infer<typeof askCancelRequestSchema>;
export type AskRunRequest = z.infer<typeof askRunRequestSchema>;

export type AskResolution = z.infer<typeof askResolutionSchema>;

/**
 * What the plan endpoint takes: the typed message, the source it is asked in (required: a question without a source is malformed), the investigator's choices for spans of it, `send` (false by
 * default: nothing is sent to a model) and, with `send: true`, the hash of the preview the investigator saw.
 */
export const askPlanRequestSchema = z
  .strictObject({
    message: askText(ASK_MESSAGE_MAX_LENGTH),
    sourceId: z.string().min(1),
    resolutions: askResolutionsSchema.optional(),
    send: z.boolean().optional(),
    previewHash: z.string().regex(ASK_PREVIEW_HASH_PATTERN).optional(),
  })
  .refine((request) => request.send !== true || request.previewHash !== undefined, { message: 'a send needs the preview hash', path: ['previewHash'] });

/** What an exact search for a typed text found: the references of the hits, how many hits had no reference, and how many hits there are with the quality of that number. */
export interface AskEntityMatches {
  readonly refs: readonly ElementRef[];
  readonly unreferenced: number;
  readonly count: Count;
}

/** The application's exact search of the investigation's source, through the gate, for a typed text; given to the resolution of a question. */
export type AskEntitySearch = (query: { readonly text: string }, signal: AbortSignal) => Promise<AskEntityMatches>;

/** Whether the investigation's source holds the entity a reference names, read through the gate. */
export type AskEntityLookup = (ref: ElementRef, signal: AbortSignal) => Promise<boolean>;

export type AskAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

/** Who asked and where: ids only, never text, so the audit of the planning call can name the actor. */
export interface AskPlanContext {
  readonly actorId: string;
  readonly actorRole: Exclude<AuditEvent['actorRole'], 'system'>;
  readonly traceId: string;
  readonly investigationId?: string;
  readonly sourceId?: string;
}

export interface AskPlanInput {
  /** The previewed text: the question rebuilt from allowed tokens, with placeholders where typed names and IDs were. */
  readonly text: string;
  readonly context: AskPlanContext;
}

/** The seam Ask plans through: the Community default says it is not available; an installed planner answers a plan for the text it is given. */
export interface AskPlanner {
  availability(): AskAvailability;
  plan(input: AskPlanInput): Promise<AskPlan>;
}
