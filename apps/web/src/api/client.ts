import {
  errorBodySchema,
  errorResponseSchema,
  investigationResponseSchema,
  meResponseSchema,
  nodeSchema,
  openInvestigationResponseSchema,
  pathSegmentOf,
  sourceProfileSchema,
  sourcesResponseSchema,
  sourceTestReportSchema,
  type ElementRef,
  type ErrorResponse,
  type GraphNode,
  type InvestigationResponse,
  type MeResponse,
  type OpenInvestigationRequest,
  type OpenInvestigationResponse,
  type SourceProfile,
  type SourcesResponse,
  type SourceTestReport,
} from '@neburyx/contracts';
import type { z } from 'zod';

export interface FetchInit {
  readonly signal?: AbortSignal;
  readonly method?: 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type Fetcher = (input: string, init?: FetchInit) => Promise<Response>;

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
  /** One entity of a source, without its neighbors; `mask` asks for the personal-data fields to be masked. */
  getEntity(ref: ElementRef, options?: { readonly mask?: boolean }, signal?: AbortSignal): Promise<ApiResult<GraphNode>>;
  /** Opens an entity as an investigation: creates one, or resumes the caller's own for the same case reference. */
  openInvestigation(request: OpenInvestigationRequest, signal?: AbortSignal): Promise<ApiResult<OpenInvestigationResponse>>;
  getInvestigation(id: string, signal?: AbortSignal): Promise<ApiResult<InvestigationResponse>>;
}

function sameRef(left: ElementRef, right: ElementRef): boolean {
  return left.sourceId === right.sourceId && left.entityType === right.entityType && left.stableId === right.stableId;
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

async function request<T>(fetcher: Fetcher, path: string, schema: z.ZodType<T>, signal: AbortSignal | undefined, method?: 'POST', body?: unknown): Promise<ApiResult<T>> {
  if (wasAborted(signal)) return failed('ABORTED');
  let text: string;
  let response: Response;
  try {
    response = await fetcher(path, signal === undefined && method === undefined ? undefined : { ...(signal === undefined ? {} : { signal }), ...(method === undefined ? {} : { method }), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    text = await response.text();
  } catch {
    return failed(wasAborted(signal) ? 'ABORTED' : 'NETWORK_UNAVAILABLE');
  }
  if (wasAborted(signal)) return failed('ABORTED');
  const parsedBody = parseJson(text);
  if (!response.ok) {
    if (parsedBody.parsed && isEnvelope(parsedBody.value)) {
      const strict = errorResponseSchema.safeParse(parsedBody.value);
      const typed = errorBodySchema.safeParse(parsedBody.value);
      return strict.success && typed.success ? { ok: false, failure: typed.data.error } : failed('SCHEMA_MISMATCH');
    }
    if (GATEWAY_STATUSES.has(response.status) || text === '') return failed('NETWORK_UNAVAILABLE');
    return failed(parsedBody.parsed ? 'SCHEMA_MISMATCH' : 'UNREADABLE_RESPONSE');
  }
  if (!parsedBody.parsed) return failed('UNREADABLE_RESPONSE');
  const parsed = schema.safeParse(parsedBody.value);
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
    getEntity: async (ref, options, signal) => {
      const path = `/v1/entities/${encodeURIComponent(ref.sourceId)}/${encodeURIComponent(pathSegmentOf(ref.entityType))}/${encodeURIComponent(pathSegmentOf(ref.stableId))}${options?.mask === true ? '?mask=true' : ''}`;
      const result = await request(fetcher, path, nodeSchema, signal);
      return result.ok && !sameRef(result.value.ref, ref) ? failed('SCHEMA_MISMATCH') : result;
    },
    openInvestigation: async (open, signal) => {
      const result = await request(fetcher, '/v1/investigations', openInvestigationResponseSchema, signal, 'POST', open);
      if (!result.ok) return result;
      const { investigation } = result.value;
      const startsAt = investigation.startingEntity;
      const named = startsAt !== null && startsAt.entityType === open.entity.entityType && startsAt.stableId === open.entity.stableId;
      return investigation.sourceId !== open.sourceId || !named || ('entity' in result.value && !sameRef(result.value.entity.ref, open.entity)) ? failed('SCHEMA_MISMATCH') : result;
    },
    getInvestigation: async (id, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}`, investigationResponseSchema, signal);
      return result.ok && result.value.investigation.id !== id ? failed('SCHEMA_MISMATCH') : result;
    },
  };
}
