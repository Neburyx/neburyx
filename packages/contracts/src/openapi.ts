import { z } from 'zod';
import { errorResponseSchema } from './error-response.js';
import { aiStatusResponseSchema } from './ai.js';
import { healthResponseSchema } from './health.js';
import { nodeSchema } from './graph.js';
import { MAX_READ_REFS, readRefsRequestSchema, readRefsResponseSchema } from './read-refs.js';
import { deleteInvestigationResponseSchema, restoreInvestigationRequestSchema, DEFAULT_INVESTIGATION_LIST_LIMIT, INVESTIGATION_STATUSES, MAX_LIST_TEXT_LENGTH, MIN_LIST_TEXT_LENGTH, draftWriteRequestSchema, draftWriteResponseSchema, MAX_DRAFT_DOCUMENT_BYTES, INVESTIGATION_LIST_SORTS, investigationListResponseSchema, investigationResponseSchema, MAX_INVESTIGATION_LIST_LIMIT, MAX_TITLE_LENGTH, openInvestigationRequestSchema, openInvestigationResponseSchema, renameRequestSchema, renameResponseSchema, statusChangeRequestSchema, statusChangeResponseSchema } from './investigations.js';
import { deleteViewRequestSchema, deleteViewResponseSchema, MAX_VIEW_PAGE, namedViewSchema, ownedViewListResponseSchema, renameViewRequestSchema, restoreViewResponseSchema, saveViewRequestSchema, saveViewResponseSchema, viewListResponseSchema } from './views.js';
import { IDEMPOTENCY_KEY_PATTERN, exportFileSchema, exportRequestSchema, exportSchema } from './exports.js';
import { meResponseSchema } from './me.js';
import { readyResponseSchema } from './ready.js';
import { sourceProfileSchema } from './profile.js';
import { coverageRequestSchema, coverageResponseSchema } from './coverage.js';
import { degreePreviewRequestSchema, degreePreviewSchema } from './degree-preview.js';
import { derivedNeighborsRequestSchema, derivedNeighborsResponseSchema } from './derived-neighbors.js';
import { patternRunRequestSchema, patternRunResponseSchema } from './pattern-run.js';
import { patternPreviewRequestSchema, patternPreviewResponseSchema, patternValidateRequestSchema, patternValidateResponseSchema } from './pattern.js';
import { templateListResponseSchema } from './template-list.js';
import { templateRunRequestSchema, templateRunResponseSchema } from './template-run.js';
import { edgeDetailSchema } from './edge-detail.js';
import { entityLookupRequestSchema } from './entities.js';
import { expandRequestSchema, expandResponseSchema } from './expand.js';
import { searchMoreRequestSchema, searchMoreResultSchema, searchRequestSchema, searchResultSchema } from './search.js';
import { sourceTestReportSchema } from './source-test.js';
import { sourcesResponseSchema } from './sources.js';

const API_TITLE = 'Neburyx API';
const API_VERSION = '0.0.0';

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: { readonly schemas: { readonly AiStatusResponse: Record<string, unknown>; readonly PatternRunRequest: Record<string, unknown>; readonly PatternRunResponse: Record<string, unknown>; readonly PatternValidateRequest: Record<string, unknown>; readonly PatternValidateResponse: Record<string, unknown>; readonly PatternPreviewRequest: Record<string, unknown>; readonly PatternPreviewResponse: Record<string, unknown>; readonly CoverageRequest: Record<string, unknown>; readonly CoverageResponse: Record<string, unknown>; readonly DegreePreview: Record<string, unknown>; readonly DegreePreviewRequest: Record<string, unknown>; readonly DerivedNeighborsRequest: Record<string, unknown>; readonly DerivedNeighborsResponse: Record<string, unknown>; readonly TemplateListResponse: Record<string, unknown>; readonly TemplateRunRequest: Record<string, unknown>; readonly TemplateRunResponse: Record<string, unknown>; readonly DraftWriteRequest: Record<string, unknown>; readonly DraftWriteResponse: Record<string, unknown>; readonly EdgeDetail: Record<string, unknown>; readonly EntityLookupRequest: Record<string, unknown>; readonly ErrorResponse: Record<string, unknown>; readonly Export: Record<string, unknown>; readonly ExportFile: Record<string, unknown>; readonly ExportRequest: Record<string, unknown>; readonly ExpandRequest: Record<string, unknown>; readonly ExpandResponse: Record<string, unknown>; readonly GraphNode: Record<string, unknown>; readonly HealthResponse: Record<string, unknown>; readonly InvestigationListResponse: Record<string, unknown>; readonly InvestigationResponse: Record<string, unknown>; readonly MeResponse: Record<string, unknown>; readonly NamedView: Record<string, unknown>; readonly OpenInvestigationRequest: Record<string, unknown>; readonly OpenInvestigationResponse: Record<string, unknown>; readonly ReadRefsRequest: Record<string, unknown>; readonly ReadRefsResponse: Record<string, unknown>; readonly ReadyResponse: Record<string, unknown>; readonly RenameRequest: Record<string, unknown>; readonly RenameResponse: Record<string, unknown>; readonly RenameViewRequest: Record<string, unknown>; readonly RestoreViewResponse: Record<string, unknown>; readonly SaveViewRequest: Record<string, unknown>; readonly SaveViewResponse: Record<string, unknown>; readonly SearchMoreRequest: Record<string, unknown>; readonly SearchMoreResult: Record<string, unknown>; readonly SearchRequest: Record<string, unknown>; readonly SearchResult: Record<string, unknown>; readonly SourceProfile: Record<string, unknown>; readonly SourceTestReport: Record<string, unknown>; readonly SourcesResponse: Record<string, unknown>; readonly DeleteInvestigationResponse: Record<string, unknown>; readonly DeleteViewRequest: Record<string, unknown>; readonly DeleteViewResponse: Record<string, unknown>; readonly RestoreInvestigationRequest: Record<string, unknown>; readonly StatusChangeRequest: Record<string, unknown>; readonly StatusChangeResponse: Record<string, unknown>; readonly ViewListResponse: Record<string, unknown>; readonly OwnedViewListResponse: Record<string, unknown>; } };
}

const RETRY_AFTER_HEADER = { 'Retry-After': { description: 'Whole seconds to wait', schema: { type: 'integer', minimum: 1 } } };

function schemaJson(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  return json;
}

const jsonBody = (name: string): Record<string, unknown> => ({
  'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
});

export function buildOpenApiDocument(
  errorResponse: z.ZodType = errorResponseSchema,
  meResponse: z.ZodType = meResponseSchema,
  healthResponse: z.ZodType = healthResponseSchema,
  readyResponse: z.ZodType = readyResponseSchema,
  sourcesResponse: z.ZodType = sourcesResponseSchema,
  sourceProfile: z.ZodType = sourceProfileSchema,
  sourceTestReport: z.ZodType = sourceTestReportSchema,
  graphNode: z.ZodType = nodeSchema,
  investigationResponse: z.ZodType = investigationResponseSchema,
  openInvestigationResponse: z.ZodType = openInvestigationResponseSchema,
  openInvestigationRequest: z.ZodType = openInvestigationRequestSchema,
  searchRequest: z.ZodType = searchRequestSchema,
  searchResult: z.ZodType = searchResultSchema,
  investigationList: z.ZodType = investigationListResponseSchema,
  degreePreviewRequest: z.ZodType = degreePreviewRequestSchema,
  degreePreview: z.ZodType = degreePreviewSchema,
  derivedNeighborsRequest: z.ZodType = derivedNeighborsRequestSchema,
  derivedNeighborsResponse: z.ZodType = derivedNeighborsResponseSchema,
  templateListResponse: z.ZodType = templateListResponseSchema,
  templateRunRequest: z.ZodType = templateRunRequestSchema,
  templateRunResponse: z.ZodType = templateRunResponseSchema,
  entityLookupRequest: z.ZodType = entityLookupRequestSchema,
  expandRequest: z.ZodType = expandRequestSchema,
  expandResponse: z.ZodType = expandResponseSchema,
  coverageRequest: z.ZodType = coverageRequestSchema,
  coverageResponse: z.ZodType = coverageResponseSchema,
  searchMoreRequest: z.ZodType = searchMoreRequestSchema,
  searchMoreResult: z.ZodType = searchMoreResultSchema,
  edgeDetail: z.ZodType = edgeDetailSchema,
): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: API_TITLE, version: API_VERSION },
    paths: {
      '/healthz': {
        get: {
          operationId: 'getHealth',
          summary: 'Liveness: the process is running',
          responses: { '200': { description: 'The process is alive', content: jsonBody('HealthResponse') } },
        },
      },
      '/readyz': {
        get: {
          operationId: 'getReady',
          summary: 'Readiness: the app can serve',
          description:
            'The status is 200 and status is ready exactly when Postgres is reachable and every migration is applied (the checks). The sources member holds counts of the configured sources by what the last ping found: reachable, unreachable or unknown. It names no source, and a source that is down does not change the status; GET /v1/sources has the state of each source.',
          responses: {
            '200': { description: 'Every check is ok', content: jsonBody('ReadyResponse') },
            '503': { description: 'A check is not ok', content: jsonBody('ReadyResponse') },
          },
        },
      },
      '/v1/me': {
        get: {
          operationId: 'getMe',
          summary: 'The calling principal, the edition and the permitted sources',
          responses: {
            '200': { description: 'The principal', content: jsonBody('MeResponse') },
            '500': { description: 'The identity could not be read', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/ai/status': {
        get: {
          operationId: 'getAiStatus',
          summary: 'Whether the AI preview is switched on',
          description: 'Present only when the deployment has switched the AI preview on (the environment variable NEBURYX_PROFILE=enterprise together with ai.preview: true in the mapping file); otherwise this path answers 404.',
          responses: {
            '200': { description: 'The preview is on', content: jsonBody('AiStatusResponse') },
            '403': { description: 'The route group was called while the preview is not switched on: ACCESS_DENIED with the reason ai-preview-off', content: jsonBody('ErrorResponse') },
            '404': { description: 'The AI preview is not switched on', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/sources/{id}/profile': {
        get: {
          operationId: 'getSourceProfile',
          summary: "A source's display model, built from its validated mapping",
          description:
            'Holds the entity and relationship types, icons, titles, key properties, searchable, filterable and personal-data properties, derived rules, pattern presets, the vocabulary and a read-only mapping excerpt. It never holds the address, the database, credentials, budgets or link templates. The ETag is the source\'s mapping hash: send it back in If-None-Match to get 304 until the mapping changes.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'If-None-Match', in: 'header', required: false, description: 'Entity tags from an earlier ETag, or *', schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'The profile',
              headers: { ETag: { description: "The source's mapping hash as a strong tag", schema: { type: 'string' } } },
              content: jsonBody('SourceProfile'),
            },
            '304': {
              description: 'The profile has not changed since the tag in If-None-Match',
              headers: { ETag: { description: "The source's mapping hash as a strong tag", schema: { type: 'string' } } },
            },
            '400': { description: 'A query parameter was sent, or the URL is malformed', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/sources/{id}/test': {
        post: {
          operationId: 'testSource',
          summary: 'Test a configured source and report what it answered',
          description:
            'Reads the capabilities of the server, the privileges of the login and the schema the mapping depends on (labels, relationship types, indexes, stable ids) and, for each entity type that has a mapped relationship, how the server answers a count of neighbors (the degree probe) through the gate as the calling principal, and returns the report. The request takes no body and no query parameters, so it cannot ask for the write probe, which only the command line runs. A source that does not answer is still a 200: the report says outcome fail and gives a fixed, plain reason that holds no address, credential or query text. A source that stops answering during the schema reads or the degree probes gives an error, not a report.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'The report of the run', content: jsonBody('SourceTestReport') },
            '400': { description: 'A body or a query parameter was sent', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id, or the person may not read it (one answer for both)', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The run could not be completed', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is busy, or stopped answering during the schema reads; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer a schema read in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/entities/{sourceId}/{entityType}/{stableId}': {
        get: {
          operationId: 'getEntity',
          summary: 'Load one entity of a source, without its neighbors',
          description:
            'Reads the node of one entity type with one stable ID through the gate, as the calling principal. The reference travels as three percent-encoded path segments. A browser removes a segment of dots, however it is written, so an entity type or a stable ID made only of dots and tildes is sent with a tilde in front, and the server takes one tilde off such a segment; every other value is sent as it is. A segment that is a lone tilde stands for no value and is refused with INVALID_REQUEST. The node, the audit record and the stored investigation all hold the real value, never the form on the wire. The stable ID is matched as text and, when the text is a canonical 64-bit integer, as that integer too, so a source whose IDs are integers is found. mask=true masks the personal-data fields of the node and any title built from them. The node carries the quality flag duplicate-stable-id when the source holds more than one node with the ID; the node shown is then the first by element ID. The answer says nothing about whether the entity exists in another source.',
          parameters: [
            { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'entityType', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'stableId', in: 'path', required: true, description: 'At most 200 characters', schema: { type: 'string', minLength: 1 } },
            { name: 'mask', in: 'query', required: false, description: 'true to mask the personal-data fields', schema: { type: 'string', enum: ['true', 'false'] } },
          ],
          responses: {
            '200': { description: 'The entity', content: jsonBody('GraphNode') },
            '400': { description: 'A query parameter other than mask was sent, the stable ID is too long, or the entity type is not in the mapping', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id, the person may not read it (one answer for these), or the source holds no such entity', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The read could not be completed', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/entities/lookup': {
        post: {
          operationId: 'lookupEntity',
          summary: 'One entity of a source by a reference in the request body',
          requestBody: { required: true, content: jsonBody('EntityLookupRequest') },
          description:
            'Answers the same node as the GET of an entity, for a reference that a path cannot carry (a reference or a value of any length up to the limit of a body, with any characters). ref is a reference as the API returned it: for an entity type whose stable ID is also personal data (a keyed type) a token that is valid only for the source and entity type it was made for, for any other type the ID as it is. value is a raw value to resolve: for a keyed type it is accepted only when the request is not masked (mask true is INVALID_REQUEST), and the node answered carries the token as its reference; for any other type it is the ID. A token of another source or entity type, a malformed token and a masked raw value of a keyed type are INVALID_REQUEST, one answer for all. No value or token is logged.',
          responses: {
            '200': { description: 'The entity, with its reference', content: jsonBody('GraphNode') },
            '400': { description: 'The body is not valid, or the reference or the masked value is refused (one answer for all)', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such entity, or the source is not configured or may not be read (one answer for all)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The entity could not be read', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations': {
        get: {
          operationId: 'listInvestigations',
          summary: 'The caller\'s investigations, a page at a time, across every source the caller may read',
          description:
            'Reads Postgres only; no source is read. Lists the caller\'s own undeleted investigations of one status (open when status is left out), the most recently edited first and, between equal times, the larger id first. Investigations of a configured source the policy does not let the caller read are left out without a record; investigations of a source no longer in the configuration are listed with sourceState removed. limit is a whole number from 1 to 100 (25 when left out); a larger one is QUERY_BUDGET_EXCEEDED with the maximum in details.maxPage, and 0 is INVALID_REQUEST. nextCursor is a signed, expiring string that is null on the last page; it is valid for the same caller, status, source and q, and anything else is CURSOR_INVALIDATED. A row edited or added between two calls is never repeated, and may be missing from the later pages. status, source (a source id) and q (2 to 200 characters, a fragment of the title or of the case reference, matched without regard to case) narrow the list; an unknown source or one the caller may not read gives an empty list. sort is lastEdited, the only order; any other query parameter is refused. sourceAlias is the alias the product stored for the source. save is saved, with the time of the named view, when the caller\'s draft equals the named view it was last saved as, and unsaved otherwise. nodeCount and edgeCount are the loaded-item counts of the caller\'s draft at its last save, null when they were made under another policy version. matching is the exact number of investigations the filters select. counts describes the library whatever the filters: the open investigations that could be listed, the sources they are on and the named views of the caller\'s investigations of any status with the newest time any of them was updated (null when there is none), all exact; the rows, matching and counts are read at one snapshot.',
          parameters: [
            { name: 'limit', in: 'query', required: false, description: 'A whole number; 25 when left out', schema: { type: 'integer', minimum: 1, maximum: MAX_INVESTIGATION_LIST_LIMIT, default: DEFAULT_INVESTIGATION_LIST_LIMIT } },
            { name: 'cursor', in: 'query', required: false, description: 'The nextCursor of the previous page, unchanged', schema: { type: 'string', minLength: 1, maxLength: 2048 } },
            { name: 'status', in: 'query', required: false, description: 'open when left out', schema: { type: 'string', enum: [...INVESTIGATION_STATUSES], default: 'open' } },
            { name: 'deleted', in: 'query', required: false, description: 'true lists the caller\'s deleted investigations of any status that can still be restored (the status parameter is then refused), newest deletion first, each with deletedAt and purgeAfter; false or left out lists the others', schema: { type: 'string', enum: ['true', 'false'], default: 'false' } },
            { name: 'source', in: 'query', required: false, description: 'A source id', schema: { type: 'string', minLength: 1 } },
            { name: 'q', in: 'query', required: false, description: 'A fragment of the title or of the case reference', schema: { type: 'string', minLength: MIN_LIST_TEXT_LENGTH, maxLength: MAX_LIST_TEXT_LENGTH } },
            { name: 'sort', in: 'query', required: false, description: 'lastEdited, the only order', schema: { type: 'string', enum: [...INVESTIGATION_LIST_SORTS] } },
          ],
          responses: {
            '200': { description: 'The investigations', content: jsonBody('InvestigationListResponse') },
            '400': { description: 'A query parameter is not one of those above, a value is not valid, or limit is 0 (INVALID_REQUEST)', content: jsonBody('ErrorResponse') },
            '409': { description: 'CURSOR_INVALIDATED: start the list again', content: jsonBody('ErrorResponse') },
            '422': { description: 'QUERY_BUDGET_EXCEEDED: the limit is above the maximum page', content: jsonBody('ErrorResponse') },
            '500': { description: 'The investigations could not be read', content: jsonBody('ErrorResponse') },
          },
        },
        post: {
          operationId: 'openInvestigation',
          summary: 'Open an entity as an investigation',
          requestBody: { required: true, content: jsonBody('OpenInvestigationRequest') },
          description:
            'Reads the starting entity through the gate, so an entity the source does not hold creates nothing, and creates an open investigation with its draft in one step. The body names the source twice, as sourceId and in the entity reference, and a reference to another source is refused before anything is read or written. The title is the display name of the entity type and the stable ID, never built from a personal-data property, and is cut at 200 characters with a final ellipsis when longer. With a caseRef, the caller\'s own open, undeleted investigation with the same source, case reference and starting entity is returned instead (200, created false); without one, every call creates an investigation. An investigation whose source now points at another database is returned without reading the source: sourceState is repointed and there is no entity. mask asks for the personal-data fields of the returned entity to be masked.',
          responses: {
            '200': { description: 'An existing investigation was resumed', headers: { ETag: { description: "The investigation's version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('OpenInvestigationResponse') },
            '201': { description: 'A new investigation and its draft', headers: { ETag: { description: "The investigation's version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('OpenInvestigationResponse') },
            '400': { description: 'The body or the query is not valid, the entity type is not in the mapping, or the entity names another source than the request', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id, the person may not read it (one answer for these), or the source holds no such entity', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The investigation could not be written', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations/{id}': {
        get: {
          operationId: 'getInvestigation',
          summary: 'An investigation of the caller and the caller\'s draft of it',
          description:
            'Reads Postgres only; no source is read. sourceState says whether the source is available as it was, is no longer in the configuration (removed) or now points at another database (repointed). An identifier that does not exist, is not a UUID, belongs to another user or is deleted gives the same 404.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'The investigation and its draft', headers: { ETag: { description: "The investigation's version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('InvestigationResponse') },
            '400': { description: 'A query parameter was sent', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such investigation of this caller', content: jsonBody('ErrorResponse') },
            '500': { description: 'The investigation could not be read', content: jsonBody('ErrorResponse') },
          },
        },
        put: {
          operationId: 'renameInvestigation',
          summary: 'Change the title of an investigation of the caller',
          description: `Writes Postgres only; no source is read. The body is { title, expectedVersion }: the title is stored as typed (not empty or only whitespace, at most ${MAX_TITLE_LENGTH} code points, no NUL and no unpaired surrogate) and expectedVersion is the investigation's version, which the answer's ETag carries. The version goes up by one and last_edited_at does not change; the title the investigation already has changes nothing and answers the same version. A closed or archived investigation is refused with CONFLICT and details.reason investigation-read-only (this check comes before the version check); a stale expectedVersion is CONFLICT without a reason. An identifier that does not exist, is not a UUID, belongs to another user or is deleted gives the same 404.`,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: jsonBody('RenameRequest') },
          responses: {
            '200': { description: 'The investigation with its new title', headers: { ETag: { description: "The investigation's version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('RenameResponse') },
            '400': { description: 'The title or expectedVersion is not valid, or a field is not known', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such investigation of this caller', content: jsonBody('ErrorResponse') },
            '409': { description: 'CONFLICT with details.reason investigation-read-only and details.status (closed or archived), or details.reason source-changed with details.sourceState (repointed or removed), or CONFLICT without a reason when expectedVersion is stale', content: jsonBody('ErrorResponse') },
            '500': { description: 'The title could not be written', content: jsonBody('ErrorResponse') },
          },
        },
        delete: {
          operationId: 'deleteInvestigation',
          summary: 'Delete an investigation of the caller, restorable until its purge date',
          description:
            "Writes Postgres only; no source is read. If-Match carries the investigation's version as a quoted whole number. The investigation leaves every ordinary list and every route except restore and the deleted list: deleted_at is the database time, purge_after is that time plus the configured number of days (retention.deleted_investigations_days, 30 by default) and the version goes up by one. The status, the draft, the named views and the last-edited time are not touched. It works whatever the status. An investigation that is already deleted, another user's or unknown is NOT_FOUND.",
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'If-Match', in: 'header', required: true, description: "The investigation's version as a quoted whole number", schema: { type: 'string', pattern: '^\"[1-9][0-9]{0,9}\"$' } },
          ],
          responses: {
            '200': { description: 'When it was deleted and the last moment it can be restored', headers: { ETag: { description: "The investigation's new version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('DeleteInvestigationResponse') },
            '400': { description: 'If-Match is missing or is not a quoted whole number of 1 or more, or a body or a query parameter was sent', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such investigation of this caller that is not already deleted', content: jsonBody('ErrorResponse') },
            '409': { description: 'CONFLICT: the version sent is stale', content: jsonBody('ErrorResponse') },
            '500': { description: 'The investigation could not be deleted', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations/{id}/status': {
        post: {
          operationId: 'changeInvestigationStatus',
          summary: 'Close, archive or reopen an investigation of the caller',
          description:
            'Writes Postgres only; no source is read. The body is { status, expectedVersion } with status open, closed or archived. Allowed changes: open to closed, open to archived, closed to open, closed to archived and archived to open; archived to closed is CONFLICT with details.reason status-change-not-allowed. Closing sets closedAt; archiving sets archivedAt and keeps an earlier closedAt; reopening clears both. The version goes up by one and last_edited_at does not change. A request for the status the investigation already has answers 200 with the same version and writes nothing, whatever expectedVersion it carries. A stale expectedVersion is CONFLICT without a reason. Closing, archiving and reopening are audited as investigation.close, investigation.archive and investigation.reopen, with a success event recorded after the change is committed (a failed write records a failed event instead); if the sink rejects the success event the change stays and the answer is INTERNAL_ERROR. An identifier that does not exist, is not a UUID, belongs to another user or is deleted gives the same 404.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: jsonBody('StatusChangeRequest') },
          responses: {
            '200': { description: 'The investigation with its status, closedAt and archivedAt', headers: { ETag: { description: "The investigation's version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('StatusChangeResponse') },
            '400': { description: 'The status or expectedVersion is not valid, or a field is not known', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such investigation of this caller', content: jsonBody('ErrorResponse') },
            '409': { description: 'CONFLICT with details.reason status-change-not-allowed, or details.reason source-changed with details.sourceState (repointed or removed), or CONFLICT without a reason when expectedVersion is stale', content: jsonBody('ErrorResponse') },
            '500': { description: 'The status could not be written', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations/{id}/exports': {
        post: {
          operationId: 'createExport',
          summary: 'Export what the person is showing as JSON or CSV',
          description:
            'Reads the referenced entities and relationships through the gate (never the browser\'s copy), builds one file and keeps it on the server\'s disk until it expires. JSON is one file; CSV is one zip holding entities.csv and relationships.csv. Every file begins with a header that states the source, the time, that the file is a partial view, how many items are shown and how many are not yet retrieved (with the count quality), and the masking state. Items the person may not export are left out without a count. `Idempotency-Key` is required (16 to 64 letters, digits, _ and -); a retry with the same key returns the first answer with `Idempotent-Replay: true`. A closed or archived investigation can be exported.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: IDEMPOTENCY_KEY_PATTERN.source } },
          ],
          requestBody: { required: true, content: jsonBody('ExportRequest') },
          responses: {
            '201': { description: 'The export is ready', headers: { 'Idempotent-Replay': { description: 'true when this is the first answer returned again', schema: { type: 'string' } } }, content: jsonBody('Export') },
            '400': { description: 'The body is not valid, the key is missing or malformed, a reference of a keyed type is not a token, or the view holds more than one export can (details.reason export-too-large with details.maxEntities, maxRelationships, maxAggregates and exceeded); SOURCE_MISMATCH when a reference names another source', content: jsonBody('ErrorResponse') },
            '403': { description: 'ACCESS_DENIED when a replayed key meets access that was revoked', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such investigation of this caller, or the source is not readable', content: jsonBody('ErrorResponse') },
            '409': { description: 'CONFLICT: the same key with another request or while the first call runs, or the policy changed; or the source changed (reason source-changed)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'EXPORT_FAILED: the file could not be written', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time (QUERY_TIMEOUT)', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/exports/{id}': {
        get: {
          operationId: 'getExport',
          summary: 'The state of an export the caller requested',
          description: 'Answers the export whatever its status (pending, ready, failed, expired), without its storage key or hash. Another person\'s export, an unknown ID and an export of a deleted investigation are one answer: NOT_FOUND.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'The export', content: jsonBody('Export') },
            '404': { description: 'No such export of this caller', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/exports/{id}/download': {
        get: {
          operationId: 'downloadExport',
          summary: 'The file of an export the caller requested',
          description: 'Re-checks, at this moment, that the caller still owns the investigation, may still read its source and is under the policy version the file was made under. If any of that changed the answer is ACCESS_DENIED with details.reason access-changed, the file is deleted and the export is expired. The same answer, with details.reason export-source-changed, is given when the source of the export is no longer configured or no longer has the identity it had when the export was made, and for every export made before the identity was recorded. An export at or after its expiry, or whose file is gone, is NOT_FOUND. The file is sent as an attachment with Cache-Control no-store.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'The file: application/json or application/zip', content: { 'application/json': { schema: { $ref: '#/components/schemas/ExportFile' } }, 'application/zip': { schema: { type: 'string', description: 'The bytes of a zip holding entities.csv and relationships.csv' } } } },
            '403': { description: 'ACCESS_DENIED with details.reason access-changed or export-source-changed', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such export of this caller, or it has expired', content: jsonBody('ErrorResponse') },
            '500': { description: 'INTERNAL_ERROR: the stored file no longer matches its hash', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations/{id}/restore': {
        post: {
          operationId: 'restoreInvestigation',
          summary: 'Restore a deleted investigation of the caller',
          description:
            'Writes Postgres only; no source is read. The body is { expectedVersion } with the investigation\'s version. In one statement deleted_at, purge_after and deleted_by are cleared and the version goes up by one; the status, the last-edited time, the draft and the named views are not touched. A view deleted before the investigation was deleted stays deleted. At or after purge_after the investigation can no longer be restored, whether or not the purge task has run, and the answer is NOT_FOUND, as it is for an investigation that is not deleted.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: jsonBody('RestoreInvestigationRequest') },
          responses: {
            '200': { description: 'The investigation as GET /v1/investigations/{id} answers it', headers: { ETag: { description: "The investigation's new version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('InvestigationResponse') },
            '400': { description: 'expectedVersion is missing or not valid, or a field is not known', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such deleted investigation of this caller that can still be restored', content: jsonBody('ErrorResponse') },
            '409': { description: 'CONFLICT: expectedVersion is stale', content: jsonBody('ErrorResponse') },
            '500': { description: 'The investigation could not be restored', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations/{id}/draft': {
        put: {
          operationId: 'saveDraft',
          summary: 'Replace the caller\'s draft of an investigation',
          description: `Writes Postgres only; no source is read. If-Match carries the draft's version as a quoted whole number (the version of the draft, which is not the ETag of the investigation); a write with another version is refused with CONFLICTED_VIEW_VERSION and changes nothing. Each document is at most ${MAX_DRAFT_DOCUMENT_BYTES} bytes of JSON. A reference of a keyed entity type must be a token of this deployment for this source and type. Filters on personal-data properties are not stored. notes is required (a string of at most 10,000 characters with no NUL and no unpaired surrogate, or null): a client writes back the note it last received. The note is part of the content, and every draft answer carries it. A write whose content equals the stored draft changes nothing and answers the same version. The investigation's last_edited_at moves only when the content changed. An identifier that does not exist, is not a UUID, belongs to another user or is deleted gives the same 404; an investigation whose source is not available as it was gives CONFLICT.`,
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'If-Match', in: 'header', required: true, description: 'The draft\'s version as a quoted whole number', schema: { type: 'string', pattern: '^"[1-9][0-9]{0,9}"$' } },
          ],
          requestBody: { required: true, content: jsonBody('DraftWriteRequest') },
          responses: {
            '200': { description: 'The draft was written, or the content was the one stored', headers: { ETag: { description: "The draft's version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('DraftWriteResponse') },
            '400': { description: 'If-Match is missing or not a quoted whole number, the body is not a draft, a document is over the limit, or a reference of a keyed type is not a token', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such investigation of this caller', content: jsonBody('ErrorResponse') },
            '409': { description: 'CONFLICTED_VIEW_VERSION: the draft changed since the version sent; CONFLICT: with details.reason investigation-read-only and details.status (closed or archived) when the investigation is closed or archived, or details.reason source-changed with details.sourceState (repointed or removed) when its source is re-pointed or no longer configured (checked after the closed or archived refusal and before the version)', content: jsonBody('ErrorResponse') },
            '500': { description: 'The draft could not be written', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/views': {
        get: {
          operationId: 'listOwnedViews',
          summary: 'The named views of every investigation of the caller, newest first',
          description: `Reads Postgres only; no source is read. Lists the named views of the caller's undeleted investigations of any status, on every source the caller may read, each with the investigation it belongs to and without its layout, query context or notes. Paged by keyset on the time the view was made and its id, 25 rows by default and at most ${MAX_VIEW_PAGE}; a limit above that is QUERY_BUDGET_EXCEEDED with details.maxPage, a limit below 1 is INVALID_REQUEST, and a cursor that was not made for this caller is CURSOR_INVALIDATED. count is the exact number of views the list holds, read with the page.`,
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: MAX_VIEW_PAGE } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'A page of named views', content: jsonBody('OwnedViewListResponse') },
            '400': { description: 'A limit that is not a whole number of at least 1, or an unknown query parameter', content: jsonBody('ErrorResponse') },
            '409': { description: 'CURSOR_INVALIDATED: start the list again', content: jsonBody('ErrorResponse') },
            '422': { description: 'QUERY_BUDGET_EXCEEDED: the limit is above the maximum page', content: jsonBody('ErrorResponse') },
            '500': { description: 'The views could not be read', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations/{id}/views': {
        get: {
          operationId: 'listViews',
          summary: 'The named views of an investigation of the caller, newest first',
          description: `Reads Postgres only; no source is read. Summaries only: the layout and query context of a view are not returned. Paged by keyset on the time the view was made and its id, 25 rows by default and at most ${MAX_VIEW_PAGE}; a limit above that is QUERY_BUDGET_EXCEEDED with details.maxPage, a limit below 1 is INVALID_REQUEST, and a cursor that is altered, expired or was made for another user, investigation or route is CURSOR_INVALIDATED. count is the exact number of named views and is the same on every page. draft names the view the draft is based on (null when none, or when that view is gone).`,
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: MAX_VIEW_PAGE } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'A page of named views', content: jsonBody('ViewListResponse') },
            '400': { description: 'A limit that is not a whole number of at least 1, or an unknown query parameter', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such investigation of this caller', content: jsonBody('ErrorResponse') },
            '409': { description: 'CURSOR_INVALIDATED: start the list again', content: jsonBody('ErrorResponse') },
            '422': { description: 'QUERY_BUDGET_EXCEEDED: the limit is above the maximum page', content: jsonBody('ErrorResponse') },
            '500': { description: 'The views could not be read', content: jsonBody('ErrorResponse') },
          },
        },
        post: {
          operationId: 'saveView',
          summary: 'Save the caller\'s draft of an investigation as a named view',
          description:
            'Writes Postgres only; no source is read. In one transaction it copies the draft (layout, query context, AI notes, mapping hash, counts) into a new named view with the name and the note given, sets the draft\'s note to that note, points the draft at the view, raises the draft\'s version by one and moves the investigation\'s last-edited time. If-Match carries the draft\'s version as a quoted whole number; another version is refused with CONFLICTED_VIEW_VERSION and nothing is stored. title and expectedInvestigationVersion come together: when the version matches the investigation\'s, the title changes in the same transaction, and when it does not, CONFLICT is answered and nothing is stored. Saving again with nothing changed creates another view. The answer is saved, with the time of the view.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'If-Match', in: 'header', required: true, description: 'The draft\'s version as a quoted whole number', schema: { type: 'string', pattern: '^"[1-9][0-9]{0,9}"$' } },
          ],
          requestBody: { required: true, content: jsonBody('SaveViewRequest') },
          responses: {
            '201': { description: 'The view was saved', headers: { ETag: { description: "The draft's new version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('SaveViewResponse') },
            '400': { description: 'If-Match is missing or not a quoted whole number, or the body is not a view save: a name or title of the wrong length, a note over the limit, text with a NUL or an unpaired surrogate, only one of title and expectedInvestigationVersion, or an unknown field', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such investigation of this caller', content: jsonBody('ErrorResponse') },
            '409': { description: 'CONFLICTED_VIEW_VERSION: the draft changed since the version sent; CONFLICT: the investigation changed since expectedInvestigationVersion, or it is closed or archived (details.reason investigation-read-only), or its source is re-pointed or no longer configured (details.reason source-changed, details.sourceState)', content: jsonBody('ErrorResponse') },
            '500': { description: 'The view could not be saved', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations/{id}/views/{viewId}': {
        put: {
          operationId: 'renameView',
          summary: 'Rename a named view',
          description: "Writes Postgres only. Only the name changes: the view's documents, note and time stay, and so does the investigation's last-edited time. If-Match carries the view's version as a quoted whole number; another version is refused with CONFLICTED_VIEW_VERSION and changes nothing.",
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'viewId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'If-Match', in: 'header', required: true, description: "The view's version as a quoted whole number", schema: { type: 'string', pattern: '^\"[1-9][0-9]{0,9}\"$' } },
          ],
          requestBody: { required: true, content: jsonBody('RenameViewRequest') },
          responses: {
            '200': { description: 'The view, renamed', headers: { ETag: { description: "The view's new version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('NamedView') },
            '400': { description: 'If-Match is missing or not a quoted whole number, or the name is not 1 to 120 characters without a NUL or an unpaired surrogate, or the body holds another field', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such view of an investigation of this caller', content: jsonBody('ErrorResponse') },
            '409': { description: 'CONFLICTED_VIEW_VERSION: the view changed since the version sent; CONFLICT: the investigation is closed or archived (details.reason investigation-read-only), or its source is re-pointed or no longer configured (details.reason source-changed, details.sourceState)', content: jsonBody('ErrorResponse') },
            '500': { description: 'The view could not be renamed', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations/{id}/views/{viewId}/restore': {
        post: {
          operationId: 'restoreView',
          summary: 'Copy a named view over the caller\'s draft',
          description:
            "Writes Postgres only; no source is read. In one transaction the view's documents, note, AI notes, mapping hash and counts replace the draft's, the draft is based on the view, and its version goes up by one; the draft then equals the view, so the answer's save is saved, with the view's time. The view itself is not changed. The investigation's last-edited time moves only when the draft's content changed. If-Match carries the draft's version as a quoted whole number; another version is refused with CONFLICTED_VIEW_VERSION and changes nothing. The body is empty.",
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'viewId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'If-Match', in: 'header', required: true, description: "The draft's version as a quoted whole number", schema: { type: 'string', pattern: '^\"[1-9][0-9]{0,9}\"$' } },
          ],
          responses: {
            '200': { description: 'The draft as it is now', headers: { ETag: { description: "The draft's new version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('RestoreViewResponse') },
            '400': { description: 'If-Match is missing or not a quoted whole number, or a body was sent', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such view of an investigation of this caller', content: jsonBody('ErrorResponse') },
            '409': { description: 'CONFLICTED_VIEW_VERSION: the draft changed since the version sent; CONFLICT: the investigation is closed or archived (details.reason investigation-read-only), or its source is re-pointed or no longer configured (details.reason source-changed, details.sourceState)', content: jsonBody('ErrorResponse') },
            '500': { description: 'The view could not be restored', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations/{id}/views/{viewId}/delete': {
        post: {
          operationId: 'deleteView',
          summary: 'Delete a named view, with an optional note',
          description:
            "Writes Postgres only; no source is read. The view is not removed: deleted_at, deleted_by and the optional note are set and the version goes up by one, and from then on every read leaves it out (it is not listed or counted, and rename and restore into the draft answer NOT_FOUND). It cannot be restored, and it is removed for good only with its investigation's purge. The note is stored and never returned or logged. The draft is not changed: if it was based on this view it now reads unsaved. This is a POST and not a DELETE because it carries a body. If-Match carries the view's version as a quoted whole number.",
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'viewId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'If-Match', in: 'header', required: true, description: "The view's version as a quoted whole number", schema: { type: 'string', pattern: '^\"[1-9][0-9]{0,9}\"$' } },
          ],
          requestBody: { required: false, content: jsonBody('DeleteViewRequest') },
          responses: {
            '200': { description: 'The deleted view, the draft, the save state and the number of views left', headers: { ETag: { description: "The view's new version as a strong tag", schema: { type: 'string' } } }, content: jsonBody('DeleteViewResponse') },
            '400': { description: 'If-Match is missing or not a quoted whole number, or the note is more than 10,000 characters, holds a NUL or an unpaired surrogate, or the body holds another field', content: jsonBody('ErrorResponse') },
            '404': { description: 'No such view of an investigation of this caller, or the view is already deleted', content: jsonBody('ErrorResponse') },
            '409': { description: 'CONFLICTED_VIEW_VERSION: the view changed since the version sent; CONFLICT: the investigation is closed or archived (details.reason investigation-read-only), or its source is re-pointed or no longer configured (details.reason source-changed, details.sourceState)', content: jsonBody('ErrorResponse') },
            '500': { description: 'The view could not be deleted', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/edges/{ref}': {
        get: {
          operationId: 'getEdge',
          summary: 'Read one stored relationship of a source with its evidence',
          description:
            'Reads one stored relationship by its reference through the gate, as the calling principal, in one fixed read of at most two rows. {ref} is one percent-encoded path segment of at most 2048 characters: the unpadded base64url text of the JSON of the stored relationship reference { sourceId, type, from, to, stableId } (the keys in that order, no whitespace; any key order is accepted). The source is the one the reference names. The answer holds the type, the two ends (their reference, title and entity type), the time the mapping\'s observed_at gives, the mapped properties the relationship holds other than its stable ID and observed time, which have their own fields, its quality flags and evidence. evidence is { status: available, records } with each record { sourceRecordId, linkable } or { property, unreadable: true }, or { status: not-available, code: EVIDENCE_NOT_AVAILABLE } when the source kept no record for the relationship; that is a state of an ordinary answer and never an error response. linkable is true only when the mapping gives the evidence a link; no URL is ever sent. mask asks for the personal-data fields to be masked, and the end titles with them. There is no confidence or score. For an aggregate reference { sourceId, aggregate: { type, from, to } } (all relationships of one type between two entities that have no usable stable ID; the keys in that order) the answer has semantics aggregate: the member count (exact over every member, or unknown with no number when the count could not be read in time, with a warning saying why), the earliest and latest observed time, and a sample of at most the smaller of 25 and the source max_page members, each as its observed time and mapped properties only, in order observed-newest (the row maps an observed time) or source-order (the first members the source returns, in its own order). more is the members not shown. There is no paging, and no element ID, member reference, record ID or URL is ever sent.',
          parameters: [
            { name: 'ref', in: 'path', required: true, description: 'At most 2048 characters', schema: { type: 'string', minLength: 1, maxLength: 2048 } },
            { name: 'mask', in: 'query', required: false, description: 'true to mask the personal-data fields', schema: { type: 'string', enum: ['true', 'false'] } },
          ],
          responses: {
            '200': { description: 'The relationship and its evidence', content: jsonBody('EdgeDetail') },
            '400': { description: 'A query parameter other than mask was sent, the segment is not the base64url text of a stored relationship reference, or is longer than the bound, the reference is of another form, or the mapping has no such relationship type between those entity types with a stable ID', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has the reference\'s id, the person may not read it (one answer for these), or the source holds no such relationship', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The read could not be completed', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/source-links/{ref}': {
        get: {
          operationId: 'openSourceLink',
          summary: 'Open the source record of an entity, or one record of a stored relationship, in the organization\'s own system',
          description:
            'Re-checks the person\'s access by reading the entity (or the stored relationship) through the gate, audits the click under the action source.link before it answers, and redirects to the mapping\'s link template with the ID percent-encoded. {ref} is one percent-encoded path segment of at most 2048 characters: the unpadded base64url text of the JSON of { sourceId, entityType, stableId } for an entity (a keyed type\'s stableId is its token), or of the stored relationship reference for a relationship, in which case record names the record to open. The address is never in a body: it is the Location of the redirect, which has an empty body, Cache-Control: no-store and Referrer-Policy: no-referrer. Every refusal after the segment parses is the same 404: a source that is not configured or not readable, a type or row with no link template, a keyed type while masked or without the opt-in, an entity or relationship the source does not have, a record the relationship does not carry in the property the template names, an address that cannot be built, and a request that another site started (Sec-Fetch-Site neither same-origin nor none) or that is a prefetch (Sec-Purpose or Purpose). An aggregate or derived reference is a 400. If the audit write fails no redirect is sent.',
          parameters: [
            { name: 'ref', in: 'path', required: true, description: 'At most 2048 characters', schema: { type: 'string', minLength: 1, maxLength: 2048 } },
            { name: 'mask', in: 'query', required: false, description: 'true for a masked request: a keyed type then has no link', schema: { type: 'string', enum: ['true', 'false'] } },
            { name: 'record', in: 'query', required: false, description: 'For a stored relationship only (and required then): the source record ID to open; at most 100000 characters', schema: { type: 'string', minLength: 1, maxLength: 100000 } },
          ],
          responses: {
            '302': { description: 'The address of the source record in Location; no body', headers: { Location: { description: 'The address, the only place it appears', schema: { type: 'string' } }, 'Cache-Control': { description: 'no-store', schema: { type: 'string' } }, 'Referrer-Policy': { description: 'no-referrer', schema: { type: 'string' } } } },
            '400': { description: 'A query parameter other than mask and record was sent, record is missing for a stored relationship or sent for an entity, record is empty or too long, or the segment is too long, is not base64url JSON, or is not an entity or stored relationship reference (an aggregate or derived reference included)', content: jsonBody('ErrorResponse') },
            '404': { description: 'One answer for every refusal: no link for this element, or no such element, source or record, or the person may not read it. A request that does not ask for JSON alone gets a short page (text/html, the same words for every reason, with the trace ID, a Content-Security-Policy that allows no script, Cache-Control: no-store); one with Accept: application/json and no text/html gets the JSON error', content: { ...jsonBody('ErrorResponse'), 'text/html': { schema: { type: 'string' } } } },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The read could not be completed, or the audit event could not be written', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/search/entities': {
        post: {
          operationId: 'searchEntities',
          summary: 'Search a source for the entities whose search properties equal a text',
          requestBody: { required: true, content: jsonBody('SearchRequest') },
          description:
            'Matches the whole text, as stored and case-sensitive, against every configured, indexed search property of the source in one read through the gate, and as the integer too when the text is a canonical 64-bit integer. The answer holds at most cap entities in exact (25, or the source\'s max_page when lower); counts.exact is exact when the group has no next page and a lowerBound of the hits held (cap, or fewer when normalization left rows out of a capped read) when the read found more, and exactNextCursor is then the cursor of the next page of the group (POST /v1/search/entities/more); each of related and evidence holds its own nextCursor the same way; searchable is false when no property was left to search. The text is 1 to 200 characters. entityTypes and matchModes (a non-empty list of different names each, absent when the search is not narrowed, refused with typeahead true) narrow the search to those entity types of the mapping of the source (the exact and the related group; the evidence group is not narrowed by entity type) and to the groups of those match modes (exact, related, evidence; a group that is not chosen is not read and is not searchable in the answer); a name the mapping does not know is INVALID_REQUEST. mask asks for the personal-data fields of the entities to be masked, and a personal-data property is then not searched. dropped and warnings are the normalize stage\'s: rows left out, by reason, and one sentence for each. disabledTypes names each search property that was not searched, with its entity type and why (index-unavailable: no online index; index-building: its index is populating; index-failed: its index failed), and typeSearched false when none of the properties of the type was searched; the other properties of the type are searched. related is the second group: the records whose reference properties (named by the mapping) hold the text, from one read of their own with its own limit, capped and counted like exact (counts in related.count, scope search:related); the related read adds nothing to exact or to its count: an entity is in exact only through its own exact match, and one that is both appears in both groups. related.searchable is false when no reference property was left to read (none configured, only personal-data ones while masked, or every type left out) and related.disabledTypes names each reference property left out the same way. evidence is the third group: the relationships whose evidence properties (named by the mapping) hold the text, from one read of their own with its own limit, capped and counted like exact (counts in evidence.count, scope search:evidence, in supporting relationships: a stored hit is one, an aggregate hit its members). A hit on a relationship row that has a stable_id is { supports, records, rules }: supports is the stored reference { sourceId, type, from, to, stableId } of the relationship. A hit on a row with no stable_id is { aggregate, members, memberCount, rules }: aggregate is { type, from, to } with the references of both ends, members are its relationships on this page, each { records, observedAt? } (a member has no ID: the element ID of the source never leaves the server, and the next page continues from a position the signed cursor holds), and memberCount is the members listed, a lowerBound when another page may hold more. records are the values of all the evidence properties of a relationship, each { sourceRecordId } or, for a value that is neither text nor a number, { property, unreadable: true }; rules are the configured rules of the mapping that use its relationship type. evidence.searchable is false when no relationship row was left to read, and evidence.disabledRelationshipTypes names each evidence property not searched with its row and the same reasons. With typeahead true the text is 2 to 200 characters and the answer also holds startsWith: the entities whose search property starts with the text, apart from the entities in exact, with its own count (exact up to and including cap, a lowerBound above it, never counted as exact matches), dropped and warnings; it is one more read, capped at cap and not paged (it has no nextCursor, so a common prefix never makes the source read every match), and shares the one schema read. A type-ahead request reads neither the related nor the evidence group: their searchable is false in its answer. A group whose read failed with a code of its own (QUERY_TIMEOUT with timeoutMs, SOURCE_BUSY, RATE_LIMITED or INTERNAL_ERROR) while another group answered is empty, has a count of quality unknown with no value, and is named in failures (always present, empty when every read answered); a retry repeats the whole search. When every group that was read fails, or an error means the same for every group, the search fails as a whole with the status and error of the read. facets (every answer that is not a type-ahead answer; a type-ahead answer holds neither facets nor filters) is the size of the whole match set, whatever is selected, from one read of its own: searchable is false when no target was left to count; otherwise entityType holds an entry for each entity type that has an eligible search or reference target (the entities of that type matched by either, each counted once), matchMode an entry for each match mode with an eligible target (exact, related, evidence; evidence in supporting relationships) and total the entities matched by any target; every count is exact up to and including the source\'s count cap (heavy_op_threshold, 500 by default) and a lowerBound of the cap above it, and an exact count is never lower than the hits its group holds (scopes search:facet:entityType, search:facet:matchMode, search:facet:total), and none is the sum of others. A facet counts the matches in the source, a group shows what the normalize stage can name, so a facet can be higher than its group by the records normalization dropped. The facet read is one more read and is not a result group: when it fails with a code of its own it is named in failures with the group facets, facets is then searchable with an unknown total and no entry, and every group is kept; it is never counted among the groups that failed. filters is the selection the answer was made for (entity types and match modes, each empty when the request did not narrow). The text is never logged and never part of an error.',
          responses: {
            '200': { description: 'The exact matches and their count', content: jsonBody('SearchResult') },
            '400': { description: 'The body or the query is not valid, or the text is not 1 to 200 characters (2 to 200 with typeahead)', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id, or the person may not read it (one answer for both)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The search could not run', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/search/entities/more': {
        post: {
          operationId: 'searchEntitiesMore',
          summary: 'The next page of one group of a search',
          requestBody: { required: true, content: jsonBody('SearchMoreRequest') },
          description:
            'Reads the page after cursor of one group (exact, related or evidence) of the search the cursor came from, and only that group, through the gate, with the same masking, the same searched properties and the same index plan as the first page (the schema is read again for this request). text, mask and entityTypes are those of that search; entityTypes narrow exact and related as there. The startsWith group of a type-ahead answer has no next page: a request for it is INVALID_REQUEST. Pages follow the element ID order of the source, so no hit is on two pages and none is skipped. The answer is the group\'s next hits in that group\'s shape (nodes for exact, hits for related and evidence), count (the hits of this page: a lowerBound when nextCursor is present, exact when this is the last page; the group\'s count is the hits held before plus these), nextCursor, dropped and warnings. A cursor of another group, text, selection, source or person, an expired cursor or one with a changed byte is CURSOR_INVALIDATED. A read that fails with a code of its group (QUERY_TIMEOUT with timeoutMs, SOURCE_BUSY, RATE_LIMITED or INTERNAL_ERROR) is answered with 200 and failure, no hit and an unknown count, and the cursor that was sent can be sent again; any other failure fails the request with its own status and error. The text is never logged and never part of an error.',
          responses: {
            '200': { description: 'The next page of the group, or the failure of its read', content: jsonBody('SearchMoreResult') },
            '400': { description: 'The body or the query is not valid', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id, or the person may not read it (one answer for both)', content: jsonBody('ErrorResponse') },
            '409': { description: 'The cursor is not valid for this request (CURSOR_INVALIDATED): search again', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The page could not be read', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
          },
        },
      },
      '/v1/graph/preview-expansion': {
        post: {
          operationId: 'previewExpansion',
          summary: 'The degree of a node by relationship type and direction, before anything is loaded',
          requestBody: { required: true, content: jsonBody('DegreePreviewRequest') },
          description:
            'Counts the mapped relationships of one node, one count for each (relationship type, direction) pair of its entity type, in one read through the gate. A count read from the degree of the node (an entity type whose checks showed the server to answer that way) is exact whatever its size; a count read by the bounded read is exact up to and including the source\'s heavy_op_threshold and a lowerBound of that value above it, with one counts-capped warning for each pair read that way; byNeighborType gives the count by the entity type at the other end only where the pair has one mapped neighbor type, and unknown where it has several. total is the sum with the weakest quality of its parts, counted over the mapped relationship ends at the node, and is unknown when a sum would pass the largest safe integer. A pair whose count stopped at the cap (a lowerBound) takes the number of a degree property the mapping declares for that entity type and pair, as an estimated count, when the property holds a whole number above the cap; the count then carries observedAt when the mapping names a date property for it and the date can be read (the time the customer computed the number, never the time of the read). An exact count is never replaced, the cheap read never reads the property, and a value that cannot be taken leaves the lowerBound. A sum with a lowerBound part stays a lowerBound that adds the cap, not the estimate, for an estimated part; a count made from a single pair is the count of that pair with its observedAt, and a sum of two or more parts carries no observedAt. warnings name a capped count (counts-capped), a degree property whose value was not used (degree-property-ignored, once for a relationship type, with a fixed reason that names neither the value nor the property) and a second node with the same stable ID (duplicate-stable-id). A node that is not in the source, is of another entity type, or is in a source that is not configured or that the person may not read is NOT_FOUND, one answer for all. mask is part of the request because the answer is cached per mask setting; no property value is in it. heavyOpThreshold is the source\'s heavy_op_threshold, which the client judges an expansion by; it is a setting and not a count. No stable ID or count is logged.',
          responses: {
            '200': { description: 'The degree of the node', content: jsonBody('DegreePreview') },
            '400': { description: 'The body is not valid', content: jsonBody('ErrorResponse') },
            '404': { description: 'The node is not in the source, or the source is not configured or may not be read (one answer for all)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The preview could not run, or the source answered with something unreadable', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/graph/derived-neighbors': {
        post: {
          operationId: 'derivedNeighbors',
          summary: 'The rule-derived neighbors of an entity, counted and returned in one bounded read',
          requestBody: { required: true, content: jsonBody('DerivedNeighborsRequest') },
          description:
            'Runs each derived rule of the mapping whose from type is the entity type of the node, in mapping order, in one read through the gate (one read for each rule, under one read slot): the other ends the rule finds, at most 25 (fewer when the source lowered max_page below 25), each with the first chain of nodes and relationships that supports it. The answer holds one result for each rule: the rule ID and version from the mapping, the count, and the other ends, the middle entities, the derived relationships and the supporting relationships of the derived relationships that were counted. The count is exact when the run read every other end the rule gives, and a lowerBound (the number that remained) when it stopped at the cap (25, or the lower max_page of the source); a derived relationship whose end or whose supporting relationship the person may not see is neither counted nor returned, and a count that stopped at the cap is never exact after such a relationship was dropped. A relationship type of the chain with no stable ID supports as an aggregate relationship whose member count is a lowerBound. An entity type with no rule gives an empty list of results and reads nothing. When no rule finds anything, the answer is confirmed by one entity read through the gate (with its own audit event, and under its own read slot after the first is released), so that an exact zero for an entity that exists is told apart from a node that is not there. A node that is not in the source, is of another entity type, or is in a source that is not configured or that the person may not read is NOT_FOUND, one answer for all. mask is part of the request because the nodes follow it; while it is true a rule whose stop-list property is personal data is INVALID_REQUEST. No stable ID or count is logged.',
          responses: {
            '200': { description: 'The results of the rules', content: jsonBody('DerivedNeighborsResponse') },
            '400': { description: 'The body is not valid, or a rule uses a personal property while masking is asked', content: jsonBody('ErrorResponse') },
            '404': { description: 'The node is not in the source, or the source is not configured or may not be read (one answer for all)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse') },
            '500': { description: 'The read could not run, or the source answered with something unreadable', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse') },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/patterns/validate': {
        post: {
          operationId: 'validatePattern',
          summary: 'Whether a pattern is acceptable for a source',
          requestBody: { required: true, content: jsonBody('PatternValidateRequest') },
          description:
            'Checks a pattern definition (a start type and one to four steps, each over one or several relationship types in a direction, with conditions and a window) against the source\'s mapping and the limits of a pattern. It answers `ok`, or `invalid` with a list of problems, each a `code` and a `path` to the element at fault; a problem holds no name and no value of the definition. A definition that is not well formed is answered with the problems of its shape alone. It reads nothing from the source: the answer comes from the mapping and the definition. `mask` makes a condition on a personal-data property a problem, as in Expand.',
          responses: {
            '200': { description: 'The pattern is acceptable, or the problems with it', content: jsonBody('PatternValidateResponse') },
            '400': { description: 'The body is not an envelope of `sourceId`, a `definition` object and an optional `mask`', content: jsonBody('ErrorResponse') },
            '404': { description: 'The source is not configured or may not be read (one answer for both)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse') },
            '500': { description: 'The answer could not be built', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/patterns/preview': {
        post: {
          operationId: 'previewPattern',
          summary: 'What a pattern will read, in plain words',
          requestBody: { required: true, content: jsonBody('PatternPreviewRequest') },
          description:
            'Answers, for a pattern definition that is acceptable for the source, what it will read: the display names of the types it starts from and arrives at, the relationship types and the direction of each step, each condition with its operator and typed values, each window (the relationship types that carry no date are named apart, as the window does not filter them), and the limits of the source a run holds to (`max_hops`, `max_page` and the count the source stops at), each as a number and as words the client joins. While masking is asked, a condition on personal data answers `personal-data-masked` and no preview, so no such value is shown. A definition that is not acceptable answers the problems of `POST /v1/patterns/validate`, and no preview. It answers from the mapping and the definition alone and reads nothing from the source; like the validation it counts against the source\'s request rate and is audited as `pattern.preview`.',
          responses: {
            '200': { description: 'The preview of the pattern as typed parts with their words and the source\'s own limits, or the problems with it (the same problems as the validation, and no preview)', content: jsonBody('PatternPreviewResponse') },
            '400': { description: 'The body is not an envelope of `sourceId`, a `definition` object and an optional `mask`', content: jsonBody('ErrorResponse') },
            '404': { description: 'The source is not configured or may not be read (one answer for both)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse') },
            '500': { description: 'The answer could not be built', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/patterns/run': {
        post: {
          operationId: 'runPattern',
          summary: 'Run a pattern definition from one starting entity, in one bounded read',
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: IDEMPOTENCY_KEY_PATTERN.source } }],
          requestBody: { required: true, content: jsonBody('PatternRunRequest') },
          description:
            'Validates the definition against the source (as the validation route does), then runs it through the gate from the entity in `anchor`, whose type is the definition\'s anchor type: one bounded read that follows each step over the listed relationship types, each step cut at the source\'s count cap, an entity with more relationships than the cap or on a stop-list not traversed. Answers the matches (the entity the last step reaches, with one path to it: the entities between and the relationship of each hop), the nodes and relationships that are shown, the notices and the count with its quality: exact only when nothing cut or skipped the read, a lower bound otherwise. A definition with a problem is refused (the validation route says which); more steps than the source\'s `max_hops` is refused with `details.maxHops`. `continue` continues a run that stopped as heavy: it skips the estimate and returns a first page of at most 25. A run is idempotent by its key, as a template run is.',
          responses: {
            '200': { description: 'The matches with a path for each, the nodes, the relationships, the notices and the count', content: jsonBody('PatternRunResponse') },
            '400': { description: 'The body is not valid, the anchor is not of the definition\'s anchor type, the definition has a problem for the source, or the idempotency key is missing or malformed', content: jsonBody('ErrorResponse') },
            '404': { description: 'The starting entity, or the source (not configured or may not be read: one answer for both), is not found', content: jsonBody('ErrorResponse') },
            '403': { description: 'A replay of a call whose key was used before, after the access of the person to the source was withdrawn', content: jsonBody('ErrorResponse') },
            '409': { description: 'The idempotency key was used with another request, the first call is still running, or the policy changed since the first call', content: jsonBody('ErrorResponse') },
            '422': { description: 'The definition has more steps than the max_hops of the source (details.maxHops names it), or the limit is above the max_page of the source (details.maxPage names it)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '500': { description: 'The read could not run, or the source answered with something unreadable', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/templates': {
        get: {
          operationId: 'listTemplates',
          summary: 'The built-in templates and the presets of a source',
          parameters: [{ name: 'sourceId', in: 'query', required: true, schema: { type: 'string', minLength: 1 } }],
          description:
            'Lists the built-in templates a pattern can bind, in a fixed order, each enabled for the source: its id, version, a generic name, the description the Ask planner reads, and `paramsSchema`, a JSON Schema generated from the contract schema of the parameters a caller sends. The schema states the shape: every input the run route accepts passes it, and the route also refuses inputs it accepts (a date that is not on the calendar, a range in the wrong order or too wide, a stable ID longer than the bound counted in UTF-16 units, the members a preset fixes, a name the mapping does not have, a limit or a hop count above the source budget). Lists the presets of the source as its profile gives them, in mapping order, and nothing else; a source with no presets lists none. Reads no source and no database. An unknown source is NOT_FOUND; a missing, empty or repeated sourceId, or another query member, is INVALID_REQUEST.',
          responses: {
            '200': { description: 'The templates and the presets of the source', content: jsonBody('TemplateListResponse') },
            '400': { description: 'The query is not valid', content: jsonBody('ErrorResponse') },
            '404': { description: 'The source is not configured', content: jsonBody('ErrorResponse') },
            '500': { description: 'The list could not be built', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/templates/{id}/run': {
        post: {
          operationId: 'runTemplate',
          summary: 'Run a built-in template or one preset of a source, from one starting entity, in one bounded read',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: IDEMPOTENCY_KEY_PATTERN.source } },
          ],
          requestBody: { required: true, content: jsonBody('TemplateRunRequest') },
          description:
            'Runs the template named by the path, or the preset of the source that the path names, through the gate. `params` is checked by the template\'s own schema; for the shared-attribute template it holds `ref` (the entity type and stable ID of the starting entity), `attributeType` and `via` (given by a preset, and refused when a preset also receives them), an optional `window` (`{days}` or `{from, to}`), `minShared` and `limit`. The answer holds the other entities that share an attribute node with the starting entity (`matchIds`, never the starting entity), the starting entity, the shared attribute nodes and the evidence relationships, in the nodes and in the relationships of the answer, a `count` of the matches that is exact when the run was not cut and a lowerBound when it was cut or a bound of the read was hit, and `notices` (stopListSkipped, noStopList, undatedExcluded, readBounded, evidenceCut). For the linked-entities template `params` holds `ref`, `targetType` and `via` (a list of relationship types; given by a preset, which names one, and refused when a preset also receives them), an optional `direction` (out, in or both; omitted, the stored direction read from the starting entity), `maxHops` (1 by default; a number above the lower of 2 and the source\'s `max_hops` is QUERY_BUDGET_EXCEEDED with the cap in `details.maxHops`), `window` and `limit`; the answer holds the entities of the target type reached in one or two hops (`matchIds`, never the starting entity), `links` (how each match was reached: its hop count and, at two hops, the entity in between), the nodes and the relationships, a `count` exact when the run was not cut and a lowerBound when it was cut, a bound was hit or a supernode or a stop-listed entity was not traversed, and `notices` that also include windowNotApplied (the relationship types a window could not apply to) and supernodesSkipped (the entities that were not traversed). `Idempotency-Key` is required (16 to 64 letters, digits, _ and -); a retry with the same key returns the first answer with `Idempotent-Replay: true`. An id that is neither a preset of the source nor a built-in template, an entity type the source does not map, or a source that is not configured or that the person may not read is NOT_FOUND. `mask` is part of the request because the nodes follow it.',
          responses: {
            '200': { description: 'The matches, their evidence and the count', content: jsonBody('TemplateRunResponse') },
            '400': { description: 'The body or the parameters are not valid, the idempotency key is missing or malformed, or the request names an attribute or relationship type the mapping does not join', content: jsonBody('ErrorResponse') },
            '404': { description: 'The id, the entity type, the node or the source is not found (one answer for all)', content: jsonBody('ErrorResponse') },
            '403': { description: 'A replay of a call whose key was used before, after the access of the person to the source was withdrawn', content: jsonBody('ErrorResponse') },
            '409': { description: 'The idempotency key was used with another request, the first call is still running, or the policy changed since the first call', content: jsonBody('ErrorResponse') },
            '422': { description: 'The limit is above the max_page of the source; details.maxPage names it', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '500': { description: 'The read could not run, or the source answered with something unreadable', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/graph/coverage': {
        post: {
          operationId: 'graphCoverage',
          summary: 'How many relationships of the loaded entities are not yet retrieved, from the degree previews already fetched',
          requestBody: { required: true, content: jsonBody('CoverageRequest') },
          description:
            'Reads only the degree previews the server holds for the named entities (under the same person, source, mapping, mask setting and degree verdicts) and never reads the source. The count is of relationships, not entities, and is never better than the weakest quality of its parts; when some named entity has no cached preview the answer is a lower bound from the others, and unknown, with no value, when they give none.',
          responses: {
            '200': { description: 'The count of relationships not yet retrieved', content: jsonBody('CoverageResponse') },
            '400': { description: 'The body is not valid, or names an entity of another source', content: jsonBody('ErrorResponse') },
            '404': { description: 'An entity type is not in the mapping, or the source is not configured or may not be read (one answer for all)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
          },
        },
      },
      '/v1/graph/read-refs': {
        post: {
          operationId: 'readRefs',
          summary: 'Read again the entities and relationships a stored draft names, by reference',
          requestBody: { required: true, content: jsonBody('ReadRefsRequest') },
          description: `Reads through the gate, as the calling principal, the items of one source that a stored draft names: entities, stored relationships, aggregate relationships and derived relationships, each list at most ${MAX_READ_REFS} references. A draft holds references and never property values, so a reopened investigation gets its items back here. The call counts as one request; every item is read by the template the matching single read uses, so the masking, the count labels and the limits are those of the single reads. An item that no longer resolves is listed under missing, once, whatever the cause (gone from the source, a type or rule no longer mapped, or not readable by the person); nothing says which. The relationships come without their ends: the entities are asked for in the same or an earlier call. A derived relationship is returned only when its rule still finds it and every one of its ends and supports is readable. A reference of another source is SOURCE_MISMATCH; a reference of a keyed entity type that is not a token of this deployment for this source and type is INVALID_REQUEST. If a read fails, nothing is returned.`,
          responses: {
            '200': { description: 'The items that resolved, and the references that did not', content: jsonBody('ReadRefsResponse') },
            '400': { description: 'The body is not valid, a list is over the limit, a reference of a keyed type is not a token (INVALID_REQUEST), or a reference names another source (SOURCE_MISMATCH)', content: jsonBody('ErrorResponse') },
            '404': { description: 'The source is not configured or the person may not read it (one answer for both)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The read could not be completed', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/graph/expand': {
        post: {
          operationId: 'expandNeighbors',
          summary: 'One page of the neighbors of a node for each asked neighbor type',
          requestBody: { required: true, content: jsonBody('ExpandRequest') },
          description:
            'Reads one page of at most `limit` relationships (the source default page when absent; above the source maximum the answer is QUERY_BUDGET_EXCEEDED) for each asked neighbor type, newest first by the observed time of the mapping row and undated last, with the neighbor nodes. The types are read one after another under one read lease and the answer holds a page and a cursor for each; a failure in any of them answers the failure and no page. A cursor continues one type and is refused with CURSOR_INVALIDATED when altered, expired or minted for another source, person, policy version, sort, neighbor type, relationship types, direction or node. Relationships of a type with no stable ID are returned as aggregate relationships with their member count. A `window` (`{days}` or `{from, to}`; absent, all time) keeps only the relationships whose own observed time is in it: each relationship type is windowed by its own `observed_at`, a relationship with no usable time is not in it and a type with no `observed_at` is not filtered. `{days: n}` is read as whole UTC days (from 00:00 UTC of the day n days before today up to 00:00 UTC of tomorrow), so a cursor lives until the UTC day changes. The answer then holds `window` (the two instants) and, for each page, `window` (`applied` full, partial or none, `notAppliedTo`, and `undatedLeftOut` when counted); counts from a windowed read have the scope `expand:window` and are not the degree of the entity.',
          responses: {
            '200': { description: 'The pages of the neighbor types', content: jsonBody('ExpandResponse') },
            '400': { description: 'The body is not valid, or names a neighbor type or relationship type that is not mapped for the node, or a page size below 1', content: jsonBody('ErrorResponse') },
            '404': { description: 'The node is not in the source, or the source is not configured or may not be read (one answer for all)', content: jsonBody('ErrorResponse') },
            '409': { description: 'A cursor is altered, expired or for another request (CURSOR_INVALIDATED)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '422': { description: 'The page size is over the source maximum (QUERY_BUDGET_EXCEEDED)', content: jsonBody('ErrorResponse') },
            '429': { description: 'Too many requests from this person to this source in the last minute: nothing was read; details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', headers: RETRY_AFTER_HEADER, content: jsonBody('ErrorResponse') },
            '500': { description: 'The expansion could not run, or the source answered with something unreadable', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy; after repeated timeouts details.retryAfterMs and the Retry-After header (whole seconds) say how long to wait', content: jsonBody('ErrorResponse'), headers: RETRY_AFTER_HEADER },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/sources': {
        get: {
          operationId: 'listSources',
          summary: 'The configured sources, with their state and a summary of their mapping',
          description:
            'Returns every configured source in one response, ordered by id, with nextCursor always null: the configuration file defines the list and it is small, so it is not paged (an exception to the pagination convention). mappingSummary holds exact counts of configured definitions, not of graph data. lastTest summarizes the newest stored test made for the current connection and mapping of the source (null when there is none): when it ran, its outcome, the server product and version, the read-only check, and the degree status and warnings; it holds no address, credential or query text. It is read from the stored record of the product, not from the source. timeoutMs, when present, is the server-side transaction timeout in milliseconds, which the app shows a running request against. The list takes no query parameters.',
          responses: {
            '200': { description: 'The configured sources', content: jsonBody('SourcesResponse') },
            '400': { description: 'A query parameter was sent', content: jsonBody('ErrorResponse') },
            '500': { description: 'The sources could not be read', content: jsonBody('ErrorResponse') },
          },
        },
      },
    },
    components: {
      schemas: { AiStatusResponse: schemaJson(aiStatusResponseSchema), PatternRunRequest: schemaJson(patternRunRequestSchema), PatternRunResponse: schemaJson(patternRunResponseSchema), PatternValidateRequest: schemaJson(patternValidateRequestSchema), PatternValidateResponse: schemaJson(patternValidateResponseSchema), PatternPreviewRequest: schemaJson(patternPreviewRequestSchema), PatternPreviewResponse: schemaJson(patternPreviewResponseSchema), CoverageRequest: schemaJson(coverageRequest), CoverageResponse: schemaJson(coverageResponse), DegreePreview: schemaJson(degreePreview), DegreePreviewRequest: schemaJson(degreePreviewRequest), DerivedNeighborsRequest: schemaJson(derivedNeighborsRequest), DerivedNeighborsResponse: schemaJson(derivedNeighborsResponse), TemplateListResponse: schemaJson(templateListResponse), TemplateRunRequest: schemaJson(templateRunRequest), TemplateRunResponse: schemaJson(templateRunResponse), DraftWriteRequest: schemaJson(draftWriteRequestSchema), DraftWriteResponse: schemaJson(draftWriteResponseSchema), EdgeDetail: schemaJson(edgeDetail), EntityLookupRequest: schemaJson(entityLookupRequest), ErrorResponse: schemaJson(errorResponse), Export: schemaJson(exportSchema), ExportFile: schemaJson(exportFileSchema), ExportRequest: schemaJson(exportRequestSchema), ExpandRequest: schemaJson(expandRequest), ExpandResponse: schemaJson(expandResponse), GraphNode: schemaJson(graphNode), HealthResponse: schemaJson(healthResponse), InvestigationListResponse: schemaJson(investigationList), InvestigationResponse: schemaJson(investigationResponse), MeResponse: schemaJson(meResponse), NamedView: schemaJson(namedViewSchema), OpenInvestigationRequest: schemaJson(openInvestigationRequest), OpenInvestigationResponse: schemaJson(openInvestigationResponse), ReadRefsRequest: schemaJson(readRefsRequestSchema), ReadRefsResponse: schemaJson(readRefsResponseSchema), ReadyResponse: schemaJson(readyResponse), RenameRequest: schemaJson(renameRequestSchema), RenameResponse: schemaJson(renameResponseSchema), RenameViewRequest: schemaJson(renameViewRequestSchema), RestoreViewResponse: schemaJson(restoreViewResponseSchema), SaveViewRequest: schemaJson(saveViewRequestSchema), SaveViewResponse: schemaJson(saveViewResponseSchema), SearchMoreRequest: schemaJson(searchMoreRequest), SearchMoreResult: schemaJson(searchMoreResult), SearchRequest: schemaJson(searchRequest), SearchResult: schemaJson(searchResult), SourceProfile: schemaJson(sourceProfile), SourceTestReport: schemaJson(sourceTestReport), SourcesResponse: schemaJson(sourcesResponse), DeleteInvestigationResponse: schemaJson(deleteInvestigationResponseSchema), DeleteViewRequest: schemaJson(deleteViewRequestSchema), DeleteViewResponse: schemaJson(deleteViewResponseSchema), RestoreInvestigationRequest: schemaJson(restoreInvestigationRequestSchema), StatusChangeRequest: schemaJson(statusChangeRequestSchema), StatusChangeResponse: schemaJson(statusChangeResponseSchema), OwnedViewListResponse: schemaJson(ownedViewListResponseSchema), ViewListResponse: schemaJson(viewListResponseSchema) },
    },
  };
}
