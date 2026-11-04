import { errorBodySchema, errorResponseSchema, meResponseSchema, sourceProfileSchema, sourcesResponseSchema, sourceTestReportSchema, type ErrorResponse, type MeResponse, type SourceProfile, type SourcesResponse, type SourceTestReport } from '@neburyx/contracts';
import type { z } from 'zod';

export type Fetcher = (input: string, init?: { readonly signal?: AbortSignal; readonly method?: 'POST' }) => Promise<Response>;

export type ServerFailure = ErrorResponse['error'];

export interface ClientFailure {
  readonly code: 'NETWORK_UNAVAILABLE' | 'UNREADABLE_RESPONSE' | 'SCHEMA_MISMATCH' | 'ABORTED' | 'UNEXPECTED_FAILURE';
}

export type ApiFailure = ClientFailure | ServerFailure;

export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ApiFailure };

export interface ApiClient {
  getMe(signal?: AbortSignal): Promise<ApiResult<MeResponse>>;
  getSources(signal?: AbortSignal): Promise<ApiResult<SourcesResponse>>;
  getProfile(sourceId: string, signal?: AbortSignal): Promise<ApiResult<SourceProfile>>;
  testSource(sourceId: string, signal?: AbortSignal): Promise<ApiResult<SourceTestReport>>;
}

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

function wasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function failed(code: ClientFailure['code']): { readonly ok: false; readonly failure: ClientFailure } {
  return { ok: false, failure: { code } };
}

function parseJson(text: string): { readonly parsed: true; readonly value: unknown } | { readonly parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false };
  }
}

/** A body with an `error` key is the API's error envelope, whatever the status it came with. */
function isEnvelope(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'error' in value;
}

async function request<T>(fetcher: Fetcher, path: string, schema: z.ZodType<T>, signal: AbortSignal | undefined, method?: 'POST'): Promise<ApiResult<T>> {
  if (wasAborted(signal)) return failed('ABORTED');
  let text: string;
  let response: Response;
  try {
    response = await fetcher(path, signal === undefined && method === undefined ? undefined : { ...(signal === undefined ? {} : { signal }), ...(method === undefined ? {} : { method }) });
    text = await response.text();
  } catch {
    return failed(wasAborted(signal) ? 'ABORTED' : 'NETWORK_UNAVAILABLE');
  }
  if (wasAborted(signal)) return failed('ABORTED');
  const body = parseJson(text);
  if (!response.ok) {
    if (body.parsed && isEnvelope(body.value)) {
      const strict = errorResponseSchema.safeParse(body.value);
      const typed = errorBodySchema.safeParse(body.value);
      return strict.success && typed.success ? { ok: false, failure: typed.data.error } : failed('SCHEMA_MISMATCH');
    }
    if (GATEWAY_STATUSES.has(response.status) || text === '') return failed('NETWORK_UNAVAILABLE');
    return failed(body.parsed ? 'SCHEMA_MISMATCH' : 'UNREADABLE_RESPONSE');
  }
  if (!body.parsed) return failed('UNREADABLE_RESPONSE');
  const parsed = schema.safeParse(body.value);
  return parsed.success ? { ok: true, value: parsed.data } : failed('SCHEMA_MISMATCH');
}

export function createApiClient(fetcher: Fetcher = (input, init) => fetch(input, init)): ApiClient {
  return {
    getMe: (signal) => request(fetcher, '/v1/me', meResponseSchema, signal),
    getSources: (signal) => request(fetcher, '/v1/sources', sourcesResponseSchema, signal),
    getProfile: (sourceId, signal) => request(fetcher, `/v1/sources/${encodeURIComponent(sourceId)}/profile`, sourceProfileSchema, signal),
    testSource: async (sourceId, signal) => {
      const result = await request(fetcher, `/v1/sources/${encodeURIComponent(sourceId)}/test`, sourceTestReportSchema, signal, 'POST');
      return result.ok && result.value.sourceId !== sourceId ? failed('SCHEMA_MISMATCH') : result;
    },
  };
}
