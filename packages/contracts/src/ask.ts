import { z } from 'zod';
import { countSchema, elementRefSchema, type Count, type ElementRef } from './graph.js';
import { codePoints } from './investigations.js';
import { linkedEntitiesParamsSchema, sharedAttributeParamsSchema } from './template-run.js';

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

/** What a planner answers: a template of the catalog with its typed parameters, or `unsupported`. Nothing in it is query text. */
export const askPlanSchema = z.union([
  z.strictObject({ ...planShape, templateId: z.literal('shared-attribute'), params: sharedAttributeParamsSchema }),
  z.strictObject({ ...planShape, templateId: z.literal('linked-entities'), params: linkedEntitiesParamsSchema }),
  z.strictObject({ kind: z.literal('unsupported'), reason: askText(ASK_TEXT_MAX_LENGTH) }),
]);

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
  z.strictObject({ plan: askPlanSchema }),
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

export const askRunRequestSchema = z.strictObject({ planId: z.uuid() });

export const ASK_RUN_OUTCOMES = ['complete', 'partial', 'failed'] as const;

export const askRunResponseSchema = z.strictObject({ planId: z.uuid(), outcome: z.enum(ASK_RUN_OUTCOMES) });

export type AskPlan = z.infer<typeof askPlanSchema>;
export type AskPlanRequest = z.infer<typeof askPlanRequestSchema>;
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

/** The seam Ask plans through: the Community default says it is not available; an installed planner answers a plan for the text it is given. */
export interface AskPlanner {
  availability(): AskAvailability;
  plan(input: { readonly text: string }): Promise<AskPlan>;
}
