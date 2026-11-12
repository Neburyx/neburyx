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

/** `POST /v1/templates/{id}/run`: the source, the parameters of the template (checked by its own schema) and `mask`, which the nodes of the answer follow. */
export const templateRunRequestSchema = z.strictObject({
  sourceId: text,
  params: z.record(z.string(), z.unknown()),
  mask: z.boolean().optional(),
});

export const TEMPLATE_RUN_NOTICE_CODES = ['stopListSkipped', 'noStopList', 'undatedExcluded', 'readBounded', 'evidenceCut'] as const;

/** One notice of a run: a code with the typed payload that code carries (none for these codes); the client writes the sentence. */
export const templateRunNoticeSchema = z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('stopListSkipped') }),
  z.strictObject({ code: z.literal('noStopList') }),
  z.strictObject({ code: z.literal('undatedExcluded') }),
  z.strictObject({ code: z.literal('readBounded') }),
  z.strictObject({ code: z.literal('evidenceCut') }),
]);

export const templateRunResponseSchema = z.strictObject({
  status: z.literal('ok'),
  templateId: text,
  templateVersion: text,
  presetId: text.optional(),
  count: countSchema,
  matchIds: z.array(elementRefSchema),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  notices: z.array(templateRunNoticeSchema),
  warnings: z.array(z.string()),
});

export type SharedAttributeParams = z.infer<typeof sharedAttributeParamsSchema>;
export type TemplateRunRequest = z.infer<typeof templateRunRequestSchema>;
export type TemplateRunNotice = z.infer<typeof templateRunNoticeSchema>;
export type TemplateRunResponse = z.infer<typeof templateRunResponseSchema>;
