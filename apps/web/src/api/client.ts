import {
  canCarryInPath,
  coverageResponseSchema,
  degreePreviewSchema,
  edgeDetailSchema,
  edgeRefSegmentOf,
  errorBodySchema,
  errorResponseSchema,
  derivedNeighborsResponseSchema,
  expandResponseSchema,
  investigationListResponseSchema,
  investigationResponseSchema,
  meResponseSchema,
  nodeSchema,
  openInvestigationResponseSchema,
  pathSegmentOf,
  searchMoreResultSchema,
  searchResultSchema,
  sourceProfileSchema,
  sourcesResponseSchema,
  sourceTestReportSchema,
  type CoverageRequest,
  type CoverageResponse,
  type DegreePreview,
  type DegreePreviewRequest,
  type EdgeDetail,
  type EntityLookupRequest,
  type ElementRef,
  type ErrorResponse,
  type ExpandRequest,
  type DerivedNeighborsRequest,
  type DerivedNeighborsResponse,
  type ExpandResponse,
  type GraphNode,
  type InvestigationListResponse,
  type InvestigationResponse,
  type MeResponse,
  type OpenInvestigationRequest,
  type OpenInvestigationResponse,
  type SearchMoreRequest,
  type SearchMoreResult,
  type SearchRequest,
  type SearchResult,
  type SourceProfile,
  type SourcesResponse,
  type SourceTestReport,
  type EdgeReadRef,
} from '@neburyx/contracts';
import type { z } from 'zod';
import { sourcesOfEdge } from '../state/keys.js';

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
  /** One stored edge of a source with its evidence, by the reference the client holds; `mask` asks for the end titles to be masked. The answer names the edge asked for, or it is refused. */
  getEdge(ref: EdgeReadRef, options?: { readonly mask?: boolean }, signal?: AbortSignal): Promise<ApiResult<EdgeDetail>>;
  /** One entity of a source by a reference or a raw value in a request body, for an ID that a path cannot carry; a raw value of a keyed type is accepted only unmasked. */
  lookupEntity(request: EntityLookupRequest, signal?: AbortSignal): Promise<ApiResult<GraphNode>>;
  /** Opens an entity as an investigation: creates one, or resumes the caller's own for the same case reference. */
  openInvestigation(request: OpenInvestigationRequest, signal?: AbortSignal): Promise<ApiResult<OpenInvestigationResponse>>;
  getInvestigation(id: string, signal?: AbortSignal): Promise<ApiResult<InvestigationResponse>>;
  /** The caller's most recently edited open investigations, across every source they may read; Postgres only. */
  listInvestigations(limit: number, signal?: AbortSignal): Promise<ApiResult<InvestigationListResponse>>;
  /** The exact matches of a text in one source, and with `typeahead` the entities that start with it; every hit and the answer name the source that was asked, or the answer is refused. */
  searchEntities(request: SearchRequest, signal?: AbortSignal): Promise<ApiResult<SearchResult>>;
  /** The next page of one group of a search, from that group's cursor; the page names the source and the group that were asked, or it is refused. */
  searchMore(request: SearchMoreRequest, signal?: AbortSignal): Promise<ApiResult<SearchMoreResult>>;
  /** How many relationships a node has by type and direction, each count with its quality, before anything is loaded; the answer names the node asked for, or it is refused. */
  previewExpansion(request: DegreePreviewRequest, signal?: AbortSignal): Promise<ApiResult<DegreePreview>>;
  /** How many relationships of the loaded entities are not yet retrieved, from the previews the server already holds; it reads no source. */
  graphCoverage(request: CoverageRequest, signal?: AbortSignal): Promise<ApiResult<CoverageResponse>>;
  /** One page of the neighbors of a node for each asked neighbor type; the answer names the node and the source asked for and holds nothing of another source, or it is refused. */
  expandNeighbors(request: ExpandRequest, signal?: AbortSignal): Promise<ApiResult<ExpandResponse>>;
  /** The rule-derived neighbors of a node, one result for each rule of the source whose first type is the node's; the answer names the node and the source asked for and holds nothing of another source, or it is refused. */
  derivedNeighbors(request: DerivedNeighborsRequest, signal?: AbortSignal): Promise<ApiResult<DerivedNeighborsResponse>>;
}

/** Whether the reference an answer carries is the one that was asked for: the same text in the path segment, whichever form. */
function sameEdgeRef(left: EdgeReadRef, right: EdgeReadRef): boolean {
  return edgeRefSegmentOf(left) === edgeRefSegmentOf(right);
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
    getEdge: async (ref, options, signal) => {
      const result = await request(fetcher, `/v1/edges/${encodeURIComponent(edgeRefSegmentOf(ref))}${options?.mask === true ? '?mask=true' : ''}`, edgeDetailSchema, signal);
      return result.ok && !sameEdgeRef(result.value.ref, ref) ? failed('SCHEMA_MISMATCH') : result;
    },
    lookupEntity: async (lookup, signal) => {
      const result = await request(fetcher, '/v1/entities/lookup', nodeSchema, signal, 'POST', lookup);
      if (!result.ok) return result;
      const asked = 'ref' in lookup ? lookup.ref : lookup.value;
      const exact = 'ref' in lookup ? result.value.ref.stableId === lookup.ref.stableId : true;
      return result.value.ref.sourceId !== lookup.sourceId || result.value.ref.entityType !== asked.entityType || !exact ? failed('SCHEMA_MISMATCH') : result;
    },
    getEntity: async (ref, options, signal) => {
      if (!canCarryInPath(ref.stableId) || !canCarryInPath(ref.entityType)) {
        const result = await request(fetcher, '/v1/entities/lookup', nodeSchema, signal, 'POST', { sourceId: ref.sourceId, ...(options?.mask === true ? { mask: true } : {}), ref: { entityType: ref.entityType, stableId: ref.stableId } });
        return result.ok && !sameRef(result.value.ref, ref) ? failed('SCHEMA_MISMATCH') : result;
      }
      const path = `/v1/entities/${encodeURIComponent(ref.sourceId)}/${encodeURIComponent(pathSegmentOf(ref.entityType))}/${encodeURIComponent(pathSegmentOf(ref.stableId))}${options?.mask === true ? '?mask=true' : ''}`;
      const result = await request(fetcher, path, nodeSchema, signal);
      return result.ok && !sameRef(result.value.ref, ref) ? failed('SCHEMA_MISMATCH') : result;
    },
    openInvestigation: async (open, signal) => {
      const result = await request(fetcher, '/v1/investigations', openInvestigationResponseSchema, signal, 'POST', open);
      if (!result.ok) return result;
      const { investigation } = result.value;
      const startsAt = investigation.startingEntity;
      // a request that named the entity by a reference is answered with that same reference; one that named it by a raw value is answered with the canonical reference of the same source and entity type
      const named = startsAt !== null && startsAt.entityType === open.entity.entityType && ('stableId' in open.entity ? startsAt.stableId === open.entity.stableId : true);
      const sameEntity = (node: ElementRef): boolean => node.sourceId === open.entity.sourceId && node.entityType === open.entity.entityType && ('stableId' in open.entity ? node.stableId === open.entity.stableId : startsAt !== null && node.stableId === startsAt.stableId);
      return investigation.sourceId !== open.sourceId || !named || ('entity' in result.value && !sameEntity(result.value.entity.ref)) ? failed('SCHEMA_MISMATCH') : result;
    },
    searchEntities: async (search, signal) => {
      const result = await request(fetcher, '/v1/search/entities', searchResultSchema, signal, 'POST', search);
      if (!result.ok) return result;
      const hits = [...result.value.exact, ...(result.value.startsWith?.nodes ?? [])];
      return result.value.sourceId !== search.sourceId || hits.some((node) => node.ref.sourceId !== search.sourceId) ? failed('SCHEMA_MISMATCH') : result;
    },
    searchMore: async (more, signal) => {
      const result = await request(fetcher, '/v1/search/entities/more', searchMoreResultSchema, signal, 'POST', more);
      if (!result.ok) return result;
      const page = result.value;
      const refs = page.group === 'exact' ? page.nodes.map((node) => node.ref.sourceId) : page.group === 'related' ? page.hits.map((hit) => hit.node.ref.sourceId) : page.hits.flatMap((hit) => ('supports' in hit ? [hit.supports.sourceId] : [hit.aggregate.from.sourceId, hit.aggregate.to.sourceId]));
      return page.sourceId !== more.sourceId || page.group !== more.group || refs.some((sourceId) => sourceId !== more.sourceId) ? failed('SCHEMA_MISMATCH') : result;
    },
    previewExpansion: async (preview, signal) => {
      const result = await request(fetcher, '/v1/graph/preview-expansion', degreePreviewSchema, signal, 'POST', preview);
      return result.ok && !sameRef(result.value.ref, { sourceId: preview.sourceId, ...preview.ref }) ? failed('SCHEMA_MISMATCH') : result;
    },
    graphCoverage: (coverage, signal) => request(fetcher, '/v1/graph/coverage', coverageResponseSchema, signal, 'POST', coverage),
    expandNeighbors: async (expansion, signal) => {
      const result = await request(fetcher, '/v1/graph/expand', expandResponseSchema, signal, 'POST', expansion);
      if (!result.ok) return result;
      const answer = result.value;
      const named = [...answer.nodes.flatMap((node) => [node.ref.sourceId]), ...answer.edges.flatMap((edge) => sourcesOfEdge(edge))];
      const asked = expansion.neighborTypes;
      const sameTypes = answer.pages.length === asked.length && answer.pages.every((page, index) => page.neighborType === asked[index]);
      return !sameRef(answer.ref, { sourceId: expansion.sourceId, ...expansion.ref }) || named.some((sourceId) => sourceId !== expansion.sourceId) || !sameTypes ? failed('SCHEMA_MISMATCH') : result;
    },
    derivedNeighbors: async (derived, signal) => {
      const result = await request(fetcher, '/v1/graph/derived-neighbors', derivedNeighborsResponseSchema, signal, 'POST', derived);
      if (!result.ok) return result;
      const answer = result.value;
      const named = answer.results.flatMap((entry) => [...entry.nodes.map((node) => node.ref.sourceId), ...entry.edges.flatMap((edge) => sourcesOfEdge(edge))]);
      return !sameRef(answer.ref, { sourceId: derived.sourceId, ...derived.ref }) || named.some((sourceId) => sourceId !== derived.sourceId) ? failed('SCHEMA_MISMATCH') : result;
    },
    listInvestigations: (limit, signal) => request(fetcher, `/v1/investigations?limit=${limit}&sort=lastEdited`, investigationListResponseSchema, signal),
    getInvestigation: async (id, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}`, investigationResponseSchema, signal);
      return result.ok && result.value.investigation.id !== id ? failed('SCHEMA_MISMATCH') : result;
    },
  };
}
