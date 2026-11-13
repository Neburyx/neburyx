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
  'AUDIT_UNAVAILABLE',
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

/** Why an `ACCESS_DENIED` was given: the person's access changed since an export was made for them, or the export's source did, or an AI route was called while the preview is not switched on. */
export const ACCESS_DENIED_REASONS = ['access-changed', 'export-source-changed', 'ai-preview-off'] as const;

export type AccessDeniedReason = (typeof ACCESS_DENIED_REASONS)[number];

/** Why an `INVALID_REQUEST` is more than a malformed body: an export names more elements than one export holds. */
export const INVALID_REQUEST_REASONS = ['export-too-large', 'pattern-limit', 'pattern-personal-condition'] as const;

/** The three limits of one export: entities, stored relationships, and aggregated or derived relationships. */
export const EXPORT_LIMIT_NAMES = ['entities', 'relationships', 'aggregates'] as const;
export type ExportLimitName = (typeof EXPORT_LIMIT_NAMES)[number];

export type InvalidRequestReason = (typeof INVALID_REQUEST_REASONS)[number];

/** The status a read-only refusal names. */
export const READ_ONLY_STATUSES = ['closed', 'archived'] as const;

/** What a source-changed refusal names: the source now points at another database, or is no longer configured. */
export const SOURCE_CHANGED_STATES = ['repointed', 'removed'] as const;

const reasonsOf = (code: ErrorCode): readonly string[] =>
  code === 'CONFLICT' ? CONFLICT_REASONS : code === 'SOURCE_UNAVAILABLE' ? SOURCE_UNAVAILABLE_REASONS : code === 'ACCESS_DENIED' ? ACCESS_DENIED_REASONS : code === 'INVALID_REQUEST' ? INVALID_REQUEST_REASONS : [];

export const errorDetailsSchema = z.strictObject({
  retained: retainedSchema.optional(),
  requested: requestedSchema.optional(),
  maxPage: z.number().int().positive().optional(),
  /** The most hops a run of a template may read: the lower of the template's maximum and the source's `max_hops`. */
  maxHops: z.number().int().positive().optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
  reason: z.enum([...SOURCE_UNAVAILABLE_REASONS, ...CONFLICT_REASONS, ...ACCESS_DENIED_REASONS, ...INVALID_REQUEST_REASONS]).optional(),
  status: z.enum(READ_ONLY_STATUSES).optional(),
  sourceState: z.enum(SOURCE_CHANGED_STATES).optional(),
  /** The most entities, and the most relationships, one export holds. */
  maxEntities: z.number().int().positive().optional(),
  maxRelationships: z.number().int().positive().optional(),
  maxAggregates: z.number().int().positive().optional(),
  /** Which of the three limits the export went over. */
  exceeded: z.enum(EXPORT_LIMIT_NAMES).optional(),
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
    .refine(({ code, details }) => details?.reason === undefined || reasonsOf(code).some((reason) => reason === details.reason), { message: 'the reason belongs to the code' })
    .refine(({ code, details }) => (details?.maxEntities === undefined && details?.maxRelationships === undefined && details?.maxAggregates === undefined && details?.exceeded === undefined) || (code === 'INVALID_REQUEST' && details.reason === 'export-too-large'), { message: 'only an export that is too large names its limits' })
    .refine(({ code, details }) => details?.status === undefined || (code === 'CONFLICT' && details.reason === 'investigation-read-only'), { message: 'only a read-only refusal names the status' }),
});

export type ErrorResponse = z.infer<typeof errorBodySchema>;
