import {
  canCarryInPath,
  coverageResponseSchema,
  draftWriteResponseSchema,
  readRefsResponseSchema,
  renameResponseSchema,
  statusChangeResponseSchema,
  deleteInvestigationResponseSchema,
  deleteViewResponseSchema,
  saveViewResponseSchema,
  namedViewSchema,
  viewListResponseSchema,
  restoreViewResponseSchema,
  degreePreviewSchema,
  edgeDetailSchema,
  edgeRefSegmentOf,
  errorBodySchema,
  errorResponseSchema,
  derivedNeighborsResponseSchema,
  expandResponseSchema,
  investigationListResponseSchema,
  ownedViewListResponseSchema,
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
  templateListResponseSchema,
  type CoverageRequest,
  type CoverageResponse,
  type DegreePreview,
  type DegreePreviewRequest,
  type DraftWriteRequest,
  type DraftWriteResponse,
  exportSchema,
  type ExportRecord,
  type ExportRequest,
  type ReadRefsRequest,
  type RenameResponse,
  type StatusChangeResponse,
  type DeleteInvestigationResponse,
  type DeleteViewResponse,
  type SaveViewRequest,
  type SaveViewResponse,
  type NamedView,
  type OwnedViewListResponse,
  type ViewListResponse,
  type RestoreViewResponse,
  type ReadRefsResponse,
  type EdgeDetail,
  type EntityLookupRequest,
  type ElementRef,
  type ErrorResponse,
  type ExpandRequest,
  type DerivedNeighborsRequest,
  type DerivedNeighborsResponse,
  type ExpandResponse,
  type GraphNode,
  type Investigation,
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
  type TemplateListResponse,
  type SourcesResponse,
  type SourceTestReport,
  type EdgeReadRef,
} from '@neburyx/contracts';
import type { z } from 'zod';
import { sourcesOfEdge } from '../state/keys.js';

export interface FetchInit {
  readonly signal?: AbortSignal;
  readonly method?: 'POST' | 'PUT' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Lets the request finish after the page is left; the browser caps the body of such a request. */
  readonly keepalive?: boolean;
}

export type Fetcher = (input: string, init?: FetchInit) => Promise<Response>;

export type ServerFailure = ErrorResponse['error'];

export interface ClientFailure {
  readonly code: 'NETWORK_UNAVAILABLE' | 'UNREADABLE_RESPONSE' | 'SCHEMA_MISMATCH' | 'ABORTED' | 'UNEXPECTED_FAILURE';
}

export type ApiFailure = ClientFailure | ServerFailure;

export interface DownloadedFile {
  readonly blob: Blob;
  readonly filename: string;
}

export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ApiFailure };

export interface InvestigationPageQuery {
  readonly status?: Investigation['status'];
  /** The caller's deleted investigations that can still be restored; no `status` goes with it. */
  readonly deleted?: boolean;
  readonly sourceId?: string;
  readonly text?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ApiClient {
  getMe(signal?: AbortSignal): Promise<ApiResult<MeResponse>>;
  getSources(signal?: AbortSignal): Promise<ApiResult<SourcesResponse>>;
  getProfile(sourceId: string, signal?: AbortSignal): Promise<ApiResult<SourceProfile>>;
  /** The built-in templates and the presets of a source, with each template's parameter schema; reads no source. The answer names the source asked for, or it is a `SCHEMA_MISMATCH`. */
  listTemplates(sourceId: string, signal?: AbortSignal): Promise<ApiResult<TemplateListResponse>>;
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
  /** Replaces the caller's draft of an investigation when `version` is the draft's version; a stale one is refused as `CONFLICTED_VIEW_VERSION`. */
  saveDraft(id: string, version: number, draft: DraftWriteRequest, options?: { readonly signal?: AbortSignal; readonly keepalive?: boolean }): Promise<ApiResult<DraftWriteResponse>>;
  /** Closes, archives or reopens the caller's investigation when `expectedVersion` is its version; the answer names the investigation asked for. */
  changeInvestigationStatus(id: string, status: Investigation['status'], expectedVersion: number, signal?: AbortSignal): Promise<ApiResult<StatusChangeResponse>>;
  /** Stores a new title for the caller's investigation when `expectedVersion` is its version; the answer names the investigation asked for. */
  renameInvestigation(id: string, title: string, expectedVersion: number, signal?: AbortSignal): Promise<ApiResult<RenameResponse>>;
  /** Asks the server to build an export of the references given; `key` is the idempotency key, the same text for a retry of the same attempt. */
  createExport(investigationId: string, request: ExportRequest, key: string, signal?: AbortSignal): Promise<ApiResult<ExportRecord>>;
  /** The file of an export, with the name the server gave it. A refusal is the server's own failure. */
  downloadExport(id: string, signal?: AbortSignal): Promise<ApiResult<DownloadedFile>>;
  /** Deletes the caller's investigation when `version` is its version; the answer names the investigation asked for and the date until which it can be restored. */
  deleteInvestigation(id: string, version: number, signal?: AbortSignal): Promise<ApiResult<DeleteInvestigationResponse>>;
  /** Restores a deleted investigation of the caller when `expectedVersion` is its version, and answers it as `getInvestigation` does. */
  restoreInvestigation(id: string, expectedVersion: number, signal?: AbortSignal): Promise<ApiResult<InvestigationResponse>>;
  /** Deletes a named view when `version` is the view's version, with a note that is kept with it; a stale version is refused as `CONFLICTED_VIEW_VERSION`. The view cannot be restored. */
  deleteView(id: string, viewId: string, version: number, note: string | null, signal?: AbortSignal): Promise<ApiResult<DeleteViewResponse>>;
  /** Saves the caller's draft as a named view when `draftVersion` is the draft's version; a stale one is refused as `CONFLICTED_VIEW_VERSION`, and a title read at another version of the investigation as `CONFLICT`. */
  saveView(id: string, draftVersion: number, view: SaveViewRequest, signal?: AbortSignal): Promise<ApiResult<SaveViewResponse>>;
  /** One page of the investigation's named views, newest first, from the first page or from a cursor; `count` is the exact number of all of them. */
  listViews(id: string, page: { readonly cursor?: string; readonly limit?: number }, signal?: AbortSignal): Promise<ApiResult<ViewListResponse>>;
  /** Changes the name of a named view when `version` is the view's version; a stale one is refused as `CONFLICTED_VIEW_VERSION`. */
  renameView(id: string, viewId: string, version: number, name: string, signal?: AbortSignal): Promise<ApiResult<NamedView>>;
  /** Copies a named view over the caller's draft when `draftVersion` is the draft's version; a stale one is refused as `CONFLICTED_VIEW_VERSION`. The answer is the draft as it is now. */
  restoreView(id: string, viewId: string, draftVersion: number, signal?: AbortSignal): Promise<ApiResult<RestoreViewResponse>>;
  /** Reads again the items a stored draft names, by reference; the answer names the source asked for and holds nothing of another, or it is refused. */
  readRefs(request: ReadRefsRequest, signal?: AbortSignal): Promise<ApiResult<ReadRefsResponse>>;
  /** The caller's most recently edited open investigations, across every source they may read; Postgres only. */
  listInvestigations(limit: number, signal?: AbortSignal): Promise<ApiResult<InvestigationListResponse>>;
  /** One page of the caller's investigations of one status, from the first page or from a cursor; `matching` is the exact number the filters select. */
  listInvestigationPage(query: InvestigationPageQuery, signal?: AbortSignal): Promise<ApiResult<InvestigationListResponse>>;
  /** One page of the named views of all the caller's investigations, newest first; `count` is the exact number of all of them. */
  listOwnedViews(page: { readonly cursor?: string; readonly limit?: number }, signal?: AbortSignal): Promise<ApiResult<OwnedViewListResponse>>;
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

interface RequestExtras {
  readonly headers?: Readonly<Record<string, string>>;
  readonly keepalive?: boolean;
}

async function request<T>(fetcher: Fetcher, path: string, schema: z.ZodType<T>, signal: AbortSignal | undefined, method?: 'POST' | 'PUT' | 'DELETE', body?: unknown, extras: RequestExtras = {}): Promise<ApiResult<T>> {
  if (wasAborted(signal)) return failed('ABORTED');
  let text: string;
  let response: Response;
  try {
    response = await fetcher(path, signal === undefined && method === undefined ? undefined : { ...(signal === undefined ? {} : { signal }), ...(method === undefined ? {} : { method }), ...(extras.keepalive === true ? { keepalive: true } : {}), ...(body === undefined ? (extras.headers === undefined ? {} : { headers: extras.headers }) : { headers: { 'content-type': 'application/json', ...extras.headers }, body: JSON.stringify(body) }) });
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

const FILENAME = /filename="([^"\\]+)"/;

/** A download is bytes, not JSON, so a refusal is read from the envelope the server sent and a success is the file itself. */
async function download(fetcher: Fetcher, path: string, signal: AbortSignal | undefined): Promise<ApiResult<DownloadedFile>> {
  if (wasAborted(signal)) return failed('ABORTED');
  let response: Response;
  let bytes: ArrayBuffer;
  try {
    response = await fetcher(path, signal === undefined ? undefined : { signal });
    bytes = await response.arrayBuffer();
  } catch {
    return failed(wasAborted(signal) ? 'ABORTED' : 'NETWORK_UNAVAILABLE');
  }
  if (wasAborted(signal)) return failed('ABORTED');
  if (!response.ok) {
    const text = new TextDecoder().decode(bytes);
    const parsedBody = parseJson(text);
    if (parsedBody.parsed && isEnvelope(parsedBody.value)) {
      const strict = errorResponseSchema.safeParse(parsedBody.value);
      const typed = errorBodySchema.safeParse(parsedBody.value);
      return strict.success && typed.success ? { ok: false, failure: typed.data.error } : failed('SCHEMA_MISMATCH');
    }
    return GATEWAY_STATUSES.has(response.status) || text === '' ? failed('NETWORK_UNAVAILABLE') : failed('UNREADABLE_RESPONSE');
  }
  const filename = FILENAME.exec(response.headers.get('content-disposition') ?? '')?.[1];
  if (filename === undefined) return failed('UNREADABLE_RESPONSE');
  return { ok: true, value: { blob: new Blob([bytes], { type: response.headers.get('content-type') ?? 'application/octet-stream' }), filename } };
}

export function createApiClient(fetcher: Fetcher = (input, init) => fetch(input, init)): ApiClient {
  return {
    getMe: (signal) => request(fetcher, '/v1/me', meResponseSchema, signal),
    getSources: (signal) => request(fetcher, '/v1/sources', sourcesResponseSchema, signal),
    getProfile: (sourceId, signal) => request(fetcher, `/v1/sources/${encodeURIComponent(sourceId)}/profile`, sourceProfileSchema, signal),
    listTemplates: async (sourceId, signal) => {
      const result = await request(fetcher, `/v1/templates?sourceId=${encodeURIComponent(sourceId)}`, templateListResponseSchema, signal);
      return result.ok && result.value.sourceId !== sourceId ? failed('SCHEMA_MISMATCH') : result;
    },
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
    listInvestigationPage: (query, signal) => {
      const parts = [
        ['limit', query.limit === undefined ? undefined : String(query.limit)],
        ['cursor', query.cursor],
        ['status', query.status],
        ['deleted', query.deleted === true ? 'true' : undefined],
        ['source', query.sourceId],
        ['q', query.text],
      ].flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${encodeURIComponent(value)}`]));
      return request(fetcher, `/v1/investigations${parts.length === 0 ? '' : `?${parts.join('&')}`}`, investigationListResponseSchema, signal);
    },
    listOwnedViews: (page, signal) => {
      const query = [...(page.limit === undefined ? [] : [`limit=${page.limit}`]), ...(page.cursor === undefined ? [] : [`cursor=${encodeURIComponent(page.cursor)}`])].join('&');
      return request(fetcher, `/v1/views${query === '' ? '' : `?${query}`}`, ownedViewListResponseSchema, signal);
    },
    listInvestigations: (limit, signal) => request(fetcher, `/v1/investigations?limit=${limit}&sort=lastEdited`, investigationListResponseSchema, signal),
    saveDraft: async (id, version, draft, options) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}/draft`, draftWriteResponseSchema, options?.signal, 'PUT', draft, { headers: { 'if-match': `"${version}"` }, ...(options?.keepalive === true ? { keepalive: true } : {}) });
      return result.ok && result.value.notes !== draft.notes ? failed('SCHEMA_MISMATCH') : result;
    },
    changeInvestigationStatus: async (id, status, expectedVersion, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}/status`, statusChangeResponseSchema, signal, 'POST', { status, expectedVersion });
      return result.ok && (result.value.investigation.id !== id || result.value.investigation.status !== status) ? failed('SCHEMA_MISMATCH') : result;
    },
    renameInvestigation: async (id, title, expectedVersion, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}`, renameResponseSchema, signal, 'PUT', { title, expectedVersion });
      return result.ok && result.value.investigation.id !== id ? failed('SCHEMA_MISMATCH') : result;
    },
    createExport: async (investigationId, body, key, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(investigationId)}/exports`, exportSchema, signal, 'POST', body, { headers: { 'idempotency-key': key } });
      return result.ok && result.value.status !== 'ready' ? failed('SCHEMA_MISMATCH') : result;
    },
    downloadExport: (id, signal) => download(fetcher, `/v1/exports/${encodeURIComponent(id)}/download`, signal),
    deleteInvestigation: async (id, version, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}`, deleteInvestigationResponseSchema, signal, 'DELETE', undefined, { headers: { 'if-match': `"${version}"` } });
      return result.ok && (result.value.id !== id || result.value.version !== version + 1) ? failed('SCHEMA_MISMATCH') : result;
    },
    restoreInvestigation: async (id, expectedVersion, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}/restore`, investigationResponseSchema, signal, 'POST', { expectedVersion });
      return result.ok && (result.value.investigation.id !== id || result.value.investigation.version !== expectedVersion + 1) ? failed('SCHEMA_MISMATCH') : result;
    },
    deleteView: async (id, viewId, version, note, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}/views/${encodeURIComponent(viewId)}/delete`, deleteViewResponseSchema, signal, 'POST', note === null ? {} : { note }, { headers: { 'if-match': `"${version}"` } });
      return result.ok && (result.value.id !== viewId || result.value.version !== version + 1) ? failed('SCHEMA_MISMATCH') : result;
    },
    saveView: async (id, draftVersion, view, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}/views`, saveViewResponseSchema, signal, 'POST', view, { headers: { 'if-match': `"${draftVersion}"` } });
      if (!result.ok) return result;
      const { value } = result;
      const echoed = value.view.name === view.name && value.view.notes === view.notes && value.draft.notes === view.notes && value.draft.version === draftVersion + 1;
      const retitled = view.title === undefined ? value.investigation === undefined : value.investigation?.title === view.title && value.investigation.version === (view.expectedInvestigationVersion ?? 0) + 1;
      return echoed && retitled ? result : failed('SCHEMA_MISMATCH');
    },
    listViews: async (id, page, signal) => {
      const query = [...(page.limit === undefined ? [] : [`limit=${page.limit}`]), ...(page.cursor === undefined ? [] : [`cursor=${encodeURIComponent(page.cursor)}`])].join('&');
      return request(fetcher, `/v1/investigations/${encodeURIComponent(id)}/views${query === '' ? '' : `?${query}`}`, viewListResponseSchema, signal);
    },
    renameView: async (id, viewId, version, name, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}/views/${encodeURIComponent(viewId)}`, namedViewSchema, signal, 'PUT', { name }, { headers: { 'if-match': `"${version}"` } });
      return result.ok && (result.value.id !== viewId || result.value.name !== name || result.value.version !== version + 1) ? failed('SCHEMA_MISMATCH') : result;
    },
    restoreView: async (id, viewId, draftVersion, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}/views/${encodeURIComponent(viewId)}/restore`, restoreViewResponseSchema, signal, 'POST', undefined, { headers: { 'if-match': `"${draftVersion}"` } });
      return result.ok && (result.value.draft.basedOnViewId !== viewId || result.value.draft.version !== draftVersion + 1) ? failed('SCHEMA_MISMATCH') : result;
    },
    readRefs: async (refs, signal) => {
      const result = await request(fetcher, '/v1/graph/read-refs', readRefsResponseSchema, signal, 'POST', refs);
      if (!result.ok) return result;
      const named = [...result.value.nodes.map((node) => node.ref.sourceId), ...result.value.edges.flatMap((edge) => sourcesOfEdge(edge)), ...result.value.missing.entities.map((ref) => ref.sourceId)];
      return named.some((sourceId) => sourceId !== refs.sourceId) ? failed('SCHEMA_MISMATCH') : result;
    },
    getInvestigation: async (id, signal) => {
      const result = await request(fetcher, `/v1/investigations/${encodeURIComponent(id)}`, investigationResponseSchema, signal);
      return result.ok && result.value.investigation.id !== id ? failed('SCHEMA_MISMATCH') : result;
    },
  };
}
