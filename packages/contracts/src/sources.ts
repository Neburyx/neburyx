import { z } from 'zod';
import { addressable, addressableTextOfAtMost } from './addressable-text.js';
import { MAX_STABLE_ID_LENGTH, referenceTextSchema } from './entities.js';
import { caseRefSchema } from './investigations.js';
import { mappingSummarySchema, sourceStateSchema } from './source-basics.js';
import { PATTERN_LIMITS } from './pattern.js';
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

/** The investigation a synthetic source offers to open first: its starting entity, as a reference (the token of a keyed type, which is longer than a path carries) and not as the configured value, and the case reference it carries. */
export const demoCaseSchema = z.strictObject({
  entityType: addressableTextOfAtMost(MAX_STABLE_ID_LENGTH),
  stableId: addressable(referenceTextSchema),
  caseRef: addressable(caseRefSchema),
});

/** The members of a source summary, before the rule that ties the demo case to a synthetic source (a refined schema cannot be narrowed to some of its members). */
export const sourceSummaryFieldsSchema = z.strictObject({
  id: z.string().min(1),
  alias: z.string().min(1),
  state: sourceStateSchema,
  stateReason: z.string().min(1).nullable(),
  readOnly: z.literal(true),
  synthetic: z.boolean(),
  lastTestAt: z.iso.datetime().nullable(),
  lastTest: lastTestSchema.nullable(),
  mappingSummary: mappingSummarySchema,
  demoCase: demoCaseSchema.nullable(),
  /** The source's server-side transaction timeout in milliseconds (its `timeout_ms`), which a running request is shown against. Absent in an answer from before the field existed. */
  timeoutMs: z.number().int().positive().optional(),
  /** The most steps a pattern may have on this source (its `max_hops`, at most the contract's step limit, which the API keeps equal to its ceiling). Absent in an answer from before the field existed. */
  maxHops: z.number().int().min(1).max(PATTERN_LIMITS.steps).optional(),
});

export const sourceSummarySchema = sourceSummaryFieldsSchema.refine((source) => source.demoCase === null || source.synthetic, { message: 'only a synthetic source has a demo case', path: ['demoCase'] });

export const sourcesResponseSchema = z.strictObject({
  items: z.array(sourceSummarySchema),
  nextCursor: z.null(),
});

export type SourceState = z.infer<typeof sourceStateSchema>;
export type SourceSummary = z.infer<typeof sourceSummarySchema>;
export type DemoCase = z.infer<typeof demoCaseSchema>;
export type LastTest = z.infer<typeof lastTestSchema>;
export type SourcesResponse = z.infer<typeof sourcesResponseSchema>;
