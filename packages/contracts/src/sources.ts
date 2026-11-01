import { z } from 'zod';

export const SOURCE_STATES = ['connected', 'degraded', 'unavailable', 'unknown'] as const;

export const sourceStateSchema = z.enum(SOURCE_STATES);

const definitionCount = z.number().int().nonnegative();

export const mappingSummarySchema = z.strictObject({
  entityTypes: definitionCount,
  relationshipTypes: definitionCount,
  derivedRules: definitionCount,
});

export const sourceSummarySchema = z.strictObject({
  id: z.string().min(1),
  alias: z.string().min(1),
  state: sourceStateSchema,
  stateReason: z.string().min(1).nullable(),
  readOnly: z.literal(true),
  synthetic: z.boolean(),
  lastTestAt: z.iso.datetime().nullable(),
  mappingSummary: mappingSummarySchema,
});

export const sourcesResponseSchema = z.strictObject({
  items: z.array(sourceSummarySchema),
  nextCursor: z.null(),
});

export type SourceState = z.infer<typeof sourceStateSchema>;
export type SourceSummary = z.infer<typeof sourceSummarySchema>;
export type SourcesResponse = z.infer<typeof sourcesResponseSchema>;
