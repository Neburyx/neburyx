import { z } from 'zod';

export const ERROR_CODES = [
  'QUERY_BUDGET_EXCEEDED',
  'QUERY_TIMEOUT',
  'SOURCE_UNAVAILABLE',
  'SOURCE_BUSY',
  'RATE_LIMITED',
  'ACCESS_DENIED',
  'CURSOR_INVALIDATED',
  'PARTIAL_RESULT',
  'EVIDENCE_NOT_AVAILABLE',
  'CONFLICTED_VIEW_VERSION',
  'CONFLICT',
  'EXPORT_FAILED',
  'ASK_UNSUPPORTED',
  'ASK_PLAN_INVALID',
  'INVALID_REQUEST',
  'UNSUPPORTED_MEDIA_TYPE',
  'NOT_FOUND',
  'INTERNAL_ERROR',
  'SOURCE_MISMATCH',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

const retainedSchema = z.number().int().nonnegative();
const requestedSchema = z.number().int().positive();

/** What a partial result keeps and what was asked for: whole counts of the operation's own items, the first strictly below the second. */
export const partialDetailsSchema = z
  .strictObject({ retained: retainedSchema, requested: requestedSchema })
  .refine(({ retained, requested }) => retained < requested, { message: 'retained must be below requested' });

export const errorDetailsSchema = z.strictObject({
  retained: retainedSchema.optional(),
  requested: requestedSchema.optional(),
  maxPage: z.number().int().positive().optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    traceId: z.string().min(1),
    details: errorDetailsSchema.optional(),
  }).refine(({ code, details }) => code !== 'PARTIAL_RESULT' || partialDetailsSchema.safeParse(details).success, { message: 'PARTIAL_RESULT carries retained and requested counts' }),
});

export type ErrorResponse = z.infer<typeof errorBodySchema>;
