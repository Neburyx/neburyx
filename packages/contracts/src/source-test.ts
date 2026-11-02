import { z } from 'zod';
import { mappingSummarySchema, sourceStateSchema } from './sources.js';

export const TEST_OUTCOMES = ['pass', 'warn', 'fail'] as const;
export const READ_ONLY_CHECKS = ['privileges-inspected', 'write-probe', 'not-verified'] as const;
export const OPERATION_STATUSES = ['supported', 'by-template', 'unsupported'] as const;

export const testOutcomeSchema = z.enum(TEST_OUTCOMES);
export const readOnlyCheckSchema = z.enum(READ_ONLY_CHECKS);

const text = z.string().min(1);

export const serverInfoSchema = z.strictObject({
  product: text,
  version: z.string(),
  edition: text,
});

export const operationSchema = z.strictObject({
  name: text,
  status: z.enum(OPERATION_STATUSES),
});

export const sourceTestReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceId: text,
  checkedAt: z.iso.datetime(),
  outcome: testOutcomeSchema,
  state: sourceStateSchema.exclude(['unknown']),
  stateReason: text.nullable(),
  server: serverInfoSchema.nullable(),
  versionSupported: z.boolean().nullable(),
  operations: z.array(operationSchema),
  readOnlyCheck: readOnlyCheckSchema,
  mappingSummary: mappingSummarySchema,
});

export type SourceTestReport = z.infer<typeof sourceTestReportSchema>;
export type TestOutcome = z.infer<typeof testOutcomeSchema>;
