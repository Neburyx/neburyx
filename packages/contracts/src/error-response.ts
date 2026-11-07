import { z } from 'zod';
import { ERROR_CODES, errorDetailsSchema, partialDetailsSchema, type ErrorCode } from './error-codes.js';
import { ERROR_DETAIL_KEYS } from './error-details.js';
import { ERROR_TABLE } from './error-table.js';

function variantFor(code: ErrorCode): z.ZodObject {
  const { message, retryable } = ERROR_TABLE[code];
  const fields = Object.fromEntries(ERROR_DETAIL_KEYS[code].map((key) => [key, errorDetailsSchema.shape[key]]));
  const shape = {
    code: z.literal(code),
    message: z.literal(message),
    retryable: z.literal(retryable),
    traceId: z.string().min(1),
  };
  if (code === 'PARTIAL_RESULT') return z.strictObject({ ...shape, details: partialDetailsSchema });
  return z.strictObject(
    ERROR_DETAIL_KEYS[code].length > 0 ? { ...shape, details: z.strictObject(fields).optional() } : shape,
  );
}

export const errorResponseSchema = z.object({
  error: z.union(ERROR_CODES.map(variantFor)),
});
