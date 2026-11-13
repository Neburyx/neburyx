import { z } from 'zod';
import type { AuditEvent } from './audit.js';
import { countSchema, elementRefSchema, nodeSchema, type Count, type ElementRef } from './graph.js';
import { codePoints } from './investigations.js';
import { referenceTextSchema } from './entities.js';
import { EXPAND_DIRECTIONS, EXPAND_SORTS } from './expand.js';
import { searchResultSchema, searchTextSchema } from './search.js';
import { degreePreviewSchema } from './degree-preview.js';
import { patternRunResponseSchema } from './pattern-run.js';
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

/** The template identifier of a plan that runs one of the investigator's saved patterns; it is not a template of the catalog, so the planner is told of it by the pattern catalog of the request. */
export const SAVED_PATTERN_TEMPLATE_ID = 'saved-pattern';
export const SAVED_PATTERN_TEMPLATE_VERSION = 1;

/** An opaque key of one request's pattern catalog: it names neither a pattern nor its owner, and means nothing in another request. */
export const PATTERN_KEY = /^pat_[1-9][0-9]*$/;

const savedPatternPlanShape = { ...planShape, templateId: z.literal(SAVED_PATTERN_TEMPLATE_ID) };

/** What the model answers for a saved pattern: the key of the catalog it was shown, and the placeholder of the starting entity when the pattern asks for one. */
export const plannedSavedPatternParamsSchema = z.strictObject({ patternKey: z.string().regex(PATTERN_KEY), ref: anchor.optional() });
const plannedSavedPatternSchema = z.strictObject({ ...savedPatternPlanShape, params: plannedSavedPatternParamsSchema });

/** The same plan once the application has turned the key and the placeholder back into what they stood for: the pattern's own id and version, and the reference. */
/** The parameters of a saved-pattern plan as it is stored. */
export const storedSavedPatternParamsSchema = z.strictObject({ patternId: z.uuid(), patternVersion: z.number().int().min(1), ref: anchor.optional() });
const savedPatternPlanSchema = z.strictObject({ ...savedPatternPlanShape, params: storedSavedPatternParamsSchema });

const planOf = <Id extends keyof typeof ASK_PLAN_PARAMS>(id: Id) => z.strictObject({ ...planShape, templateId: z.literal(id), params: ASK_PLAN_PARAMS[id] });

/** The kinds of question Ask refuses, neutral names; the closed list the refusal answer draws its `family` from. The last two are set by the server only. */
export const ASK_REFUSAL_FAMILIES = [
  'path',
  'property-selection',
  'similar-records',
  'ranking-or-aggregate',
  'attribute-combination',
  'indirect-attribute',
  'unnamed-relation',
  'judgement',
  'personal-data',
  'loaded-view',
  'other',
  'plan-not-usable',
  'model-refused',
] as const;

export const askRefusalFamilySchema = z.enum(ASK_REFUSAL_FAMILIES);

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
  plannedSavedPatternSchema,
  savedPatternPlanSchema,
]);

/** What a planner answers when it refuses: it may name a family, and its `reason` is free text the route never passes on. */
const unsupportedPlanSchema = z.strictObject({ kind: z.literal('unsupported'), family: askRefusalFamilySchema.optional(), reason: askText(ASK_TEXT_MAX_LENGTH) });

/** What the plan endpoint answers for a refusal: the family and the fixed sentence of that family. */
const unsupportedAnswerSchema = z.strictObject({ kind: z.literal('unsupported'), family: askRefusalFamilySchema, reason: askText(ASK_TEXT_MAX_LENGTH) });

/** What a planner answers: a template of the catalog with its typed parameters, or `unsupported`. Nothing in it is query text. */
export const askPlanSchema = z.union([templatePlanSchema, unsupportedPlanSchema]);

/** What the plan endpoint answers as a plan: a template, or a refusal with its family and fixed sentence. */
export const askPlanAnswerSchema = z.union([templatePlanSchema, unsupportedAnswerSchema]);

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
  z.strictObject({ plan: templatePlanSchema, planId: z.uuid(), expiresAt: z.iso.datetime(), patternCatalogCut: z.literal(true).optional() }),
  z.strictObject({ plan: unsupportedAnswerSchema }),
  z.strictObject({ clarification: askClarificationSchema }),
  z.strictObject({ blocked: z.strictObject({ tokens: z.array(askBlockedTokenSchema).min(1) }) }),
  z.strictObject({ preview: z.string().min(1), previewHash: z.string().regex(ASK_PREVIEW_HASH_PATTERN), changed: z.literal(true).optional(), patternLabels: z.array(z.string().min(1)).optional(), patternText: z.string().min(1).optional(), patternCatalogCut: z.literal(true).optional() }),
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
export const askEditRequestSchema = z.strictObject({ planId: z.uuid(), templateId: z.enum([...ASK_PLAN_TEMPLATE_IDS, SAVED_PATTERN_TEMPLATE_ID]), params: z.record(z.string(), z.unknown()) });

/** What `POST /v1/ask/edit` answers: the new plan, stored as `proposed` with its own ID and expiry; the old one is cancelled. */
export const askEditResponseSchema = z.strictObject({ plan: templatePlanSchema, planId: z.uuid(), expiresAt: z.iso.datetime() });

export const askCancelRequestSchema = z.strictObject({ planId: z.uuid() });

export const askCancelResponseSchema = z.strictObject({ planId: z.uuid(), state: z.literal('cancelled') });

/** What `POST /v1/ask/run` takes: the plan to run and, as every read of the product does, whether the personal data of the nodes of the answer is masked. */
export const askRunRequestSchema = z
  .strictObject({ planId: z.uuid(), mask: z.boolean().optional(), continue: z.literal(true).optional(), continueToken: z.string().regex(ASK_PREVIEW_HASH_PATTERN).optional() })
  .refine((request) => (request.continue === true) === (request.continueToken !== undefined), { message: 'a continue and its token come together', path: ['continueToken'] });

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
  /** A run of a saved pattern is the saved run's own answer for its kind: a pattern answer with `matches`, or a template answer for a saved run of a preset; a pattern that cannot run is a refusal. */
  z.strictObject({ templateId: z.literal(SAVED_PATTERN_TEMPLATE_ID), result: z.union([patternRunResponseSchema, templateRunResponseSchema]) }),
]);

/** `complete` or `partial` (the result reports a cut); a run that failed answers the error of the read, and only the run's own record says `failed`. */
export const ASK_RUN_ANSWER_OUTCOMES = ['complete', 'partial'] as const;

/** Whether a result is the stop of a run that would read more than the source allows without being asked again: the plan was given back, so the answer carries the token to continue it. */
export function isHeavyResult(run: AskRunResult): boolean {
  return (run.templateId === 'shared-attribute' || run.templateId === 'linked-entities' || run.templateId === SAVED_PATTERN_TEMPLATE_ID) && run.result.status === 'heavy';
}

/**
 * What a run answers. A result that stopped as heavy comes with `continueToken` (the plan is `proposed` again, nothing was run or recorded), and only such a result does: the token is the signature that
 * lets `POST /v1/ask/run` with `continue: true` read it.
 */
export const askRunResponseSchema = z
  .strictObject({ planId: z.uuid(), outcome: z.enum(ASK_RUN_ANSWER_OUTCOMES), result: askRunResultSchema, continueToken: z.string().regex(ASK_PREVIEW_HASH_PATTERN).optional() })
  .refine((answer) => isHeavyResult(answer.result) === (answer.continueToken !== undefined), { message: 'a heavy result comes with a continue token and no other result does', path: ['continueToken'] });

export type AskPlan = z.infer<typeof askPlanSchema>;
export type AskPlanAnswer = z.infer<typeof askPlanAnswerSchema>;
export type AskRefusalFamily = z.infer<typeof askRefusalFamilySchema>;
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

/** What a pattern needs of the plan that names it, by its key: the type of the entity it starts at, and whether the question gives that entity or the pattern holds it. */
export interface AskPatternEntry {
  readonly anchorType: string;
  readonly startingEntity: 'asked' | 'held';
}

/** The saved patterns offered for one question: the text the model is shown, and what a plan that names a key is checked against. Nothing in it is a pattern's id, a typed value or an owner. */
export interface AskPatternCatalog {
  readonly text: string;
  /** Whether the catalog leaves out saved patterns the caller may run, because there are more than it holds. */
  readonly cut: boolean;
  /** The names of saved patterns that passed the allowlist and are shown to the model; the preview lists them. */
  readonly labels: readonly string[];
  /** Looks at the parameters of a model request before it is sent and throws when anything of a saved pattern that may not reach the model is in them. The planner calls it for every request of the turn, the repair included. */
  readonly check: (parameters: Readonly<Record<string, string | number>>) => void;
  readonly entries: ReadonlyMap<string, AskPatternEntry>;
}

export interface AskPlanInput {
  /** The previewed text: the question rebuilt from allowed tokens, with placeholders where typed names and IDs were. */
  readonly text: string;
  readonly context: AskPlanContext;
  /** The saved patterns the caller may run on the question's source, offered by key; absent when there are none. */
  readonly patterns?: AskPatternCatalog;
}

/** One step of a saved pattern as a plan may be told of it: types and kinds only, never a property, a value or a name. */
export interface AskPatternStep {
  readonly relationshipTypes: readonly string[];
  readonly direction: 'out' | 'in' | 'both';
  readonly arrivesAt: string;
  readonly conditions: readonly { readonly on: 'neighbor' | 'relationship'; readonly kind: 'eq' | 'in' | 'between' }[];
  readonly windowed: boolean;
}

/** The structure of a saved pattern that may reach the planner. It has no field for a name, a description, a value, an owner, an identifier or a time. */
export type AskPatternProjection =
  | {
      readonly kind: 'definition';
      readonly anchorType: string;
      readonly startingEntity: 'asked' | 'held';
      readonly steps: readonly AskPatternStep[];
    }
  | {
      /** A saved run of one of the source's presets: the template, the types and relationship types the preset binds, and the numbers the run was saved with. */
      readonly kind: 'preset-run';
      readonly template: 'shared-attribute' | 'linked-entities';
      readonly anchorType: string;
      readonly startingEntity: 'asked' | 'held';
      readonly otherType: string;
      readonly relationshipTypes: readonly string[];
      readonly direction?: 'out' | 'in' | 'both';
      readonly maxHops?: number;
      readonly minShared?: number;
      readonly windowed: boolean;
    };

/** What the application lists of a caller's saved patterns on a source: the offers, and whether it left some out because there are more than a catalog holds. */
export interface AskPatternListing {
  readonly offers: readonly AskPatternOffer[];
  readonly cut: boolean;
}

/** A pattern the caller may run, as the application hands it to the extension: the structure, and the id, version and typed name that only the application and the checks of the extension may hold. */
export interface AskPatternOffer {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly projection: AskPatternProjection;
}

/** The seam Ask plans through: the Community default says it is not available; an installed planner answers a plan for the text it is given. */
export interface AskPlanner {
  availability(): AskAvailability;
  /** Whether the prompt the planner uses has a place for the saved patterns; when it has not, none is built, previewed or hashed. Absent means it has. */
  offersPatterns?(): boolean;
  plan(input: AskPlanInput): Promise<AskPlan>;
}
