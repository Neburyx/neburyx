import { z } from 'zod';
import { mappingSummarySchema, sourceStateSchema } from './source-basics.js';
import { DEGREE_STATUSES, readOnlyCheckSchema, serverInfoSchema, testOutcomeSchema } from './source-test.js';

export { SOURCE_STATES, mappingSummarySchema, sourceStateSchema } from './source-basics.js';

/** What the newest stored test of a source, made for its current connection and mapping, found. */
export const lastTestSchema = z
  .strictObject({
    checkedAt: z.iso.datetime(),
    outcome: testOutcomeSchema,
    server: serverInfoSchema.pick({ product: true, version: true }).nullable(),
    versionSupported: z.boolean().nullable(),
    readOnlyCheck: readOnlyCheckSchema,
    loginCanWrite: z.boolean().nullable(),
    degreeStatus: z.enum(DEGREE_STATUSES),
    degreeWarnings: z.array(z.string().min(1)),
  })
  .refine((test) => test.server !== null || test.versionSupported === null, { message: 'versionSupported is null when the server did not answer', path: ['versionSupported'] });

export const sourceSummarySchema = z.strictObject({
  id: z.string().min(1),
  alias: z.string().min(1),
  state: sourceStateSchema,
  stateReason: z.string().min(1).nullable(),
  readOnly: z.literal(true),
  synthetic: z.boolean(),
  lastTestAt: z.iso.datetime().nullable(),
  lastTest: lastTestSchema.nullable(),
  mappingSummary: mappingSummarySchema,
});

export const sourcesResponseSchema = z.strictObject({
  items: z.array(sourceSummarySchema),
  nextCursor: z.null(),
});

export type SourceState = z.infer<typeof sourceStateSchema>;
export type SourceSummary = z.infer<typeof sourceSummarySchema>;
export type LastTest = z.infer<typeof lastTestSchema>;
export type SourcesResponse = z.infer<typeof sourcesResponseSchema>;
