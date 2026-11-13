import { z } from 'zod';
import { referenceTextSchema } from './entities.js';
import { countSchema, edgeSchema, elementRefSchema, nodeSchema } from './graph.js';

const text = z.string().min(1);
const DAY_MS = 86_400_000;

/** The widest window a run takes, in days, either as a count of days or as a range of dates. */
export const WINDOW_MAX_DAYS = 3650;
/** The most shared attribute nodes a run may require of a match. */
export const MIN_SHARED_MAX = 50;

const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dayOf = (value: string): number => Date.parse(`${value}T00:00:00Z`);
const isCalendarDate = (value: string): boolean => {
  const time = dayOf(value);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
};

/** A time window: the last `days` x 24 hours up to the request, or the days `from` to `to` inclusive (UTC); exactly one of the two. */
export const windowSchema = z.union([
  z.strictObject({ days: z.number().int().min(1).max(WINDOW_MAX_DAYS) }),
  z
    .strictObject({ from: dateText, to: dateText })
    .refine((range) => isCalendarDate(range.from) && isCalendarDate(range.to) && dayOf(range.from) <= dayOf(range.to) && (dayOf(range.to) - dayOf(range.from)) / DAY_MS < WINDOW_MAX_DAYS, { message: 'a window of dates is calendar dates, in order, at most 3650 days' }),
]);

export type Window = z.infer<typeof windowSchema>;

/** What a caller sends for the shared-attribute template: the anchor, the attribute type and the relationship type that joins them (with a preset the preset names them), a window, a minimum of shared attribute nodes and a page size. */
export const sharedAttributeParamsSchema = z.strictObject({
  ref: z.strictObject({ entityType: text, stableId: referenceTextSchema }),
  attributeType: text.optional(),
  via: text.optional(),
  window: windowSchema.optional(),
  minShared: z.number().int().min(1).max(MIN_SHARED_MAX).optional(),
  limit: z.number().int().min(1).optional(),
});

/** The most hops a linked-entities run is asked for; the gate refuses more than the template and the source allow. */
export const LINKED_HOPS_MAX = 4;

/** What a caller sends for the linked-entities template: the anchor, the target type and the relationship types (with a preset the preset names the target type and one relationship type), the direction, the hops, a window and a page size. */
export const linkedEntitiesParamsSchema = z.strictObject({
  ref: z.strictObject({ entityType: text, stableId: referenceTextSchema }),
  targetType: text.optional(),
  via: z.array(text).min(1).optional(),
  direction: z.enum(['out', 'in', 'both']).optional(),
  maxHops: z.number().int().min(1).max(LINKED_HOPS_MAX).optional(),
  window: windowSchema.optional(),
  limit: z.number().int().min(1).optional(),
});

/** `POST /v1/templates/{id}/run`: the source, the parameters of the template (checked by its own schema) and `mask`, which the nodes of the answer follow. */
export const templateRunRequestSchema = z.strictObject({
  sourceId: text,
  params: z.record(z.string(), z.unknown()),
  mask: z.boolean().optional(),
  /** Continue a run that stopped as heavy: it skips the estimate and returns a first page of at most `HEAVY_CONTINUE_LIMIT`. */
  continue: z.boolean().optional(),
});

export const TEMPLATE_RUN_NOTICE_CODES = ['stopListSkipped', 'noStopList', 'undatedExcluded', 'readBounded', 'evidenceCut', 'windowNotApplied', 'supernodesSkipped'] as const;

/** One notice of a run: a code with the typed payload that code carries (none for these codes); the client writes the sentence. */
export const templateRunNoticeSchema = z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('stopListSkipped') }),
  z.strictObject({ code: z.literal('noStopList') }),
  z.strictObject({ code: z.literal('undatedExcluded') }),
  z.strictObject({ code: z.literal('readBounded') }),
  z.strictObject({ code: z.literal('evidenceCut') }),
  z.strictObject({ code: z.literal('windowNotApplied'), relationshipTypes: z.array(text) }),
  z.strictObject({ code: z.literal('supernodesSkipped'), entities: z.array(elementRefSchema) }),
]);

/** How a match of a linked-entities run was reached: in one or two hops, and through which entity when there were two. */
export const linkedMatchSchema = z.strictObject({ match: elementRefSchema, hops: z.union([z.literal(1), z.literal(2)]), through: elementRefSchema.optional() });

/** The page size "Continue with 25" offers after a heavy answer (TAS §8.1): a fixed product value; the source's `max_page` can only lower it. */
export const HEAVY_CONTINUE_LIMIT = 25;

export const templateRunOkSchema = z.strictObject({
  status: z.literal('ok'),
  templateId: text,
  templateVersion: text,
  presetId: text.optional(),
  count: countSchema,
  matchIds: z.array(elementRefSchema),
  /** For a linked-entities run: how each match was reached. */
  links: z.array(linkedMatchSchema).optional(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  notices: z.array(templateRunNoticeSchema),
  warnings: z.array(z.string()),
});

/**
 * A run that would match more than the source's `heavy_op_threshold` stops with the estimate and no rows (TAS §8.1): the estimate is a lower bound at the threshold, `threshold` is the source's, and `continueLimit` is the page
 * size a continue of this request would use. An estimate that is `exact`, `estimated` or `unknown` is never heavy.
 */
export const templateRunHeavySchema = z
  .strictObject({
    status: z.literal('heavy'),
    templateId: text,
    templateVersion: text,
    presetId: text.optional(),
    estimate: countSchema,
    threshold: z.number().int().min(1),
    continueLimit: z.number().int().min(1).max(HEAVY_CONTINUE_LIMIT),
    notices: z.array(templateRunNoticeSchema),
    warnings: z.array(z.string()),
  })
  .refine((answer) => answer.estimate.quality === 'lowerBound' && answer.estimate.value === answer.threshold, { message: 'a heavy answer holds a lower bound at the threshold', path: ['estimate'] });

/** The answer of a run: the result, or the stop of a heavy run; `status` tells them apart. */
export const templateRunResponseSchema = z.union([templateRunOkSchema, templateRunHeavySchema]);

export type LinkedEntitiesParams = z.infer<typeof linkedEntitiesParamsSchema>;
export type LinkedMatch = z.infer<typeof linkedMatchSchema>;
export type SharedAttributeParams = z.infer<typeof sharedAttributeParamsSchema>;
export type TemplateRunRequest = z.infer<typeof templateRunRequestSchema>;
export type TemplateRunNotice = z.infer<typeof templateRunNoticeSchema>;
export type TemplateRunOk = z.infer<typeof templateRunOkSchema>;
export type TemplateRunHeavy = z.infer<typeof templateRunHeavySchema>;
export type TemplateRunResponse = z.infer<typeof templateRunResponseSchema>;
