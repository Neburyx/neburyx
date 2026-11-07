import type { ErrorCode } from './error-codes.js';
import { errorDetailsSchema, partialDetailsSchema, type ErrorDetails } from './error-codes.js';

type DetailKey = keyof typeof errorDetailsSchema.shape;

export const ERROR_DETAIL_KEYS: Readonly<Record<ErrorCode, readonly DetailKey[]>> = {
  QUERY_BUDGET_EXCEEDED: ['maxPage'],
  QUERY_TIMEOUT: ['timeoutMs'],
  SOURCE_UNAVAILABLE: ['reason'],
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

export function allowedDetails(code: ErrorCode, details: unknown): ErrorDetails | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  if (code === 'PARTIAL_RESULT') return partialAllowed(details);
  const allowed: Record<string, number | string> = {};
  try {
    for (const key of ERROR_DETAIL_KEYS[code]) {
      const candidate = Object.getOwnPropertyDescriptor(details, key)?.value;
      const parsed = errorDetailsSchema.shape[key].safeParse(candidate);
      if (parsed.success && parsed.data !== undefined) allowed[key] = parsed.data;
    }
  } catch {
    return undefined;
  }
  if (Object.keys(allowed).length === 0) return undefined;
  const parsed = errorDetailsSchema.safeParse(allowed);
  return parsed.success ? parsed.data : undefined;
}

function partialAllowed(details: object): ErrorDetails | undefined {
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
