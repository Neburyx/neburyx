import type { ErrorCode } from './error-codes.js';
import { ACCESS_DENIED_REASONS, CONFLICT_REASONS, errorDetailsSchema, INVALID_REQUEST_REASONS, partialDetailsSchema, SOURCE_UNAVAILABLE_REASONS, type ErrorDetails } from './error-codes.js';

type DetailKey = keyof typeof errorDetailsSchema.shape;

export const ERROR_DETAIL_KEYS: Readonly<Record<ErrorCode, readonly DetailKey[]>> = {
  QUERY_BUDGET_EXCEEDED: ['maxPage'],
  QUERY_TIMEOUT: ['timeoutMs'],
  SOURCE_UNAVAILABLE: ['reason', 'retryAfterMs'],
  SOURCE_BUSY: [],
  RATE_LIMITED: ['retryAfterMs'],
  ACCESS_DENIED: ['reason'],
  CURSOR_INVALIDATED: [],
  PARTIAL_RESULT: ['retained', 'requested'],
  EVIDENCE_NOT_AVAILABLE: [],
  CONFLICTED_VIEW_VERSION: [],
  CONFLICT: ['reason', 'status', 'sourceState'],
  EXPORT_FAILED: [],
  ASK_UNSUPPORTED: [],
  ASK_PLAN_INVALID: [],
  INVALID_REQUEST: ['reason', 'maxEntities', 'maxRelationships', 'maxAggregates', 'exceeded'],
  UNSUPPORTED_MEDIA_TYPE: [],
  NOT_FOUND: [],
  INTERNAL_ERROR: [],
  SOURCE_MISMATCH: [],
  AUDIT_UNAVAILABLE: [],
};

const REASONS_OF_CODE: Partial<Record<ErrorCode, readonly string[]>> = {
  SOURCE_UNAVAILABLE: SOURCE_UNAVAILABLE_REASONS,
  CONFLICT: CONFLICT_REASONS,
  ACCESS_DENIED: ACCESS_DENIED_REASONS,
  INVALID_REQUEST: INVALID_REQUEST_REASONS,
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
  if (typeof allowed['reason'] === 'string' && !REASONS_OF_CODE[code]?.includes(allowed['reason'])) delete allowed['reason'];
  if (code === 'CONFLICT' && allowed['reason'] !== 'investigation-read-only') delete allowed['status'];
  if (code === 'CONFLICT' && allowed['reason'] !== 'source-changed') delete allowed['sourceState'];
  if (code === 'INVALID_REQUEST' && allowed['reason'] !== 'export-too-large') for (const key of ['maxEntities', 'maxRelationships', 'maxAggregates', 'exceeded']) delete allowed[key];
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
