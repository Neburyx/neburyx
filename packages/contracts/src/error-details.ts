import type { ErrorCode } from './error-codes.js';
import { errorDetailsSchema, partialDetailsSchema } from './error-codes.js';

type DetailKey = keyof typeof errorDetailsSchema.shape;

export const ERROR_DETAIL_KEYS: Readonly<Record<ErrorCode, readonly DetailKey[]>> = {
  QUERY_BUDGET_EXCEEDED: ['maxPage'],
  QUERY_TIMEOUT: ['timeoutMs'],
  SOURCE_UNAVAILABLE: [],
  SOURCE_BUSY: [],
  RATE_LIMITED: ['retryAfterMs'],
  ACCESS_DENIED: [],
  CURSOR_INVALIDATED: [],
  PARTIAL_RESULT: ['retained', 'requested'],
  EVIDENCE_NOT_AVAILABLE: [],
  CONFLICTED_VIEW_VERSION: [],
  CONFLICT: [],
  EXPORT_FAILED: [],
  ASK_UNSUPPORTED: [],
  ASK_PLAN_INVALID: [],
  INVALID_REQUEST: [],
  UNSUPPORTED_MEDIA_TYPE: [],
  NOT_FOUND: [],
  INTERNAL_ERROR: [],
  SOURCE_MISMATCH: [],
};

export function allowedDetails(code: ErrorCode, details: unknown): Record<string, number> | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  if (code === 'PARTIAL_RESULT') return partialAllowed(details);
  const allowed: Record<string, number> = {};
  try {
    for (const key of ERROR_DETAIL_KEYS[code]) {
      const candidate = Object.getOwnPropertyDescriptor(details, key)?.value;
      const parsed = errorDetailsSchema.shape[key].safeParse(candidate);
      if (parsed.success && parsed.data !== undefined) allowed[key] = parsed.data;
    }
  } catch {
    return undefined;
  }
  return Object.keys(allowed).length > 0 ? allowed : undefined;
}

function partialAllowed(details: object): Record<string, number> | undefined {
  try {
    const parsed = partialDetailsSchema.safeParse({
      retained: Object.getOwnPropertyDescriptor(details, 'retained')?.value,
      requested: Object.getOwnPropertyDescriptor(details, 'requested')?.value,
    });
    return parsed.success ? { retained: parsed.data.retained, requested: parsed.data.requested } : undefined;
  } catch {
    return undefined;
  }
}
