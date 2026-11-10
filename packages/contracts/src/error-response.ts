import { z } from 'zod';
import { CONFLICT_REASONS, ERROR_CODES, errorDetailsSchema, partialDetailsSchema, READ_ONLY_STATUSES, SOURCE_UNAVAILABLE_REASONS, type ErrorCode } from './error-codes.js';
import { ERROR_DETAIL_KEYS } from './error-details.js';
import { CONFLICT_ENTRIES, ERROR_TABLE, SOURCE_UNAVAILABLE_ENTRIES } from './error-table.js';

function variantFor(code: ErrorCode): z.ZodObject {
  const { message, retryable } = ERROR_TABLE[code];
  const keys = code === 'CONFLICT' ? [] : ERROR_DETAIL_KEYS[code];
  const fields = Object.fromEntries(keys.map((key) => [key, errorDetailsSchema.shape[key]]));
  const shape = {
    code: z.literal(code),
    message: z.literal(message),
    retryable: z.literal(retryable),
    traceId: z.string().min(1),
  };
  if (code === 'PARTIAL_RESULT') return z.strictObject({ ...shape, details: partialDetailsSchema });
  return z.strictObject(
    keys.length > 0 ? { ...shape, details: z.strictObject(fields).optional() } : shape,
  );
}

/** An unavailable source always says why: the reason in its details, with that reason's sentence and retry flag. */
const unavailableVariants = SOURCE_UNAVAILABLE_REASONS.map((reason) =>
  z.strictObject({
    code: z.literal('SOURCE_UNAVAILABLE'),
    message: z.literal(SOURCE_UNAVAILABLE_ENTRIES[reason].message),
    retryable: z.literal(SOURCE_UNAVAILABLE_ENTRIES[reason].retryable),
    traceId: z.string().min(1),
    details: z.strictObject({ reason: z.literal(reason), ...(reason === 'repeated-timeouts' ? { retryAfterMs: errorDetailsSchema.shape.retryAfterMs } : {}) }),
  }),
);

/** A refused update says why: the reason in its details, with that reason's sentence; only a read-only refusal names the status. */
const conflictVariants = CONFLICT_REASONS.map((reason) =>
  z.strictObject({
    code: z.literal('CONFLICT'),
    message: z.literal(CONFLICT_ENTRIES[reason].message),
    retryable: z.literal(CONFLICT_ENTRIES[reason].retryable),
    traceId: z.string().min(1),
    details: z.strictObject({ reason: z.literal(reason), ...(reason === 'investigation-read-only' ? { status: z.enum(READ_ONLY_STATUSES) } : {}) }),
  }),
);

export const errorResponseSchema = z.object({
  error: z.union([...ERROR_CODES.filter((code) => code !== 'SOURCE_UNAVAILABLE').map(variantFor), ...unavailableVariants, ...conflictVariants]),
});
