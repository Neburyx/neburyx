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

/** Why a source is unavailable, sent in the details of `SOURCE_UNAVAILABLE`; each has its own sentence and says whether a retry can help (`SOURCE_UNAVAILABLE_ENTRIES`). */
export const SOURCE_UNAVAILABLE_REASONS = ['unreachable', 'authentication', 'refused', 'index-unavailable', 'index-building', 'index-failed', 'index-list-unreadable', 'repeated-timeouts'] as const;

export type SourceUnavailableReason = (typeof SOURCE_UNAVAILABLE_REASONS)[number];

/** Why an update was refused with `CONFLICT`; a `CONFLICT` with no reason means the item was changed elsewhere. */
export const CONFLICT_REASONS = ['status-change-not-allowed', 'investigation-read-only', 'source-changed'] as const;

export type ConflictReason = (typeof CONFLICT_REASONS)[number];

/** The status a read-only refusal names. */
export const READ_ONLY_STATUSES = ['closed', 'archived'] as const;

/** What a source-changed refusal names: the source now points at another database, or is no longer configured. */
export const SOURCE_CHANGED_STATES = ['repointed', 'removed'] as const;

export const errorDetailsSchema = z.strictObject({
  retained: retainedSchema.optional(),
  requested: requestedSchema.optional(),
  maxPage: z.number().int().positive().optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
  reason: z.enum([...SOURCE_UNAVAILABLE_REASONS, ...CONFLICT_REASONS]).optional(),
  status: z.enum(READ_ONLY_STATUSES).optional(),
  sourceState: z.enum(SOURCE_CHANGED_STATES).optional(),
});

export type ErrorDetails = z.infer<typeof errorDetailsSchema>;

export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    traceId: z.string().min(1),
    details: errorDetailsSchema.optional(),
  })
    .refine(({ code, details }) => code !== 'PARTIAL_RESULT' || partialDetailsSchema.safeParse(details).success, { message: 'PARTIAL_RESULT carries retained and requested counts' })
    .refine(({ code, details }) => details?.reason === undefined || (code === 'CONFLICT' ? CONFLICT_REASONS : code === 'SOURCE_UNAVAILABLE' ? SOURCE_UNAVAILABLE_REASONS : []).some((reason) => reason === details.reason), { message: 'the reason belongs to the code' })
    .refine(({ code, details }) => details?.status === undefined || (code === 'CONFLICT' && details.reason === 'investigation-read-only'), { message: 'only a read-only refusal names the status' }),
});

export type ErrorResponse = z.infer<typeof errorBodySchema>;
