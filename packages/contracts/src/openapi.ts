import { z } from 'zod';
import { errorResponseSchema } from './error-response.js';
import { healthResponseSchema } from './health.js';
import { nodeSchema } from './graph.js';
import { DEFAULT_INVESTIGATION_LIST_LIMIT, INVESTIGATION_LIST_SORTS, investigationListResponseSchema, investigationResponseSchema, MAX_INVESTIGATION_LIST_LIMIT, openInvestigationRequestSchema, openInvestigationResponseSchema } from './investigations.js';
import { meResponseSchema } from './me.js';
import { readyResponseSchema } from './ready.js';
import { sourceProfileSchema } from './profile.js';
import { degreePreviewRequestSchema, degreePreviewSchema } from './degree-preview.js';
import { entityLookupRequestSchema } from './entities.js';
import { expandRequestSchema, expandResponseSchema } from './expand.js';
import { searchRequestSchema, searchResultSchema } from './search.js';
import { sourceTestReportSchema } from './source-test.js';
import { sourcesResponseSchema } from './sources.js';

const API_TITLE = 'Neburyx API';
const API_VERSION = '0.0.0';

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: { readonly schemas: { readonly DegreePreview: Record<string, unknown>; readonly DegreePreviewRequest: Record<string, unknown>; readonly EntityLookupRequest: Record<string, unknown>; readonly ErrorResponse: Record<string, unknown>; readonly ExpandRequest: Record<string, unknown>; readonly ExpandResponse: Record<string, unknown>; readonly GraphNode: Record<string, unknown>; readonly HealthResponse: Record<string, unknown>; readonly InvestigationListResponse: Record<string, unknown>; readonly InvestigationResponse: Record<string, unknown>; readonly MeResponse: Record<string, unknown>; readonly OpenInvestigationRequest: Record<string, unknown>; readonly OpenInvestigationResponse: Record<string, unknown>; readonly ReadyResponse: Record<string, unknown>; readonly SearchRequest: Record<string, unknown>; readonly SearchResult: Record<string, unknown>; readonly SourceProfile: Record<string, unknown>; readonly SourceTestReport: Record<string, unknown>; readonly SourcesResponse: Record<string, unknown> } };
}

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
  entityLookupRequest: z.ZodType = entityLookupRequestSchema,
  expandRequest: z.ZodType = expandRequestSchema,
  expandResponse: z.ZodType = expandResponseSchema,
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
            '403': { description: 'The policy does not allow this principal to read the source', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id', content: jsonBody('ErrorResponse') },
            '500': { description: 'The run could not be completed', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is busy, or stopped answering during the schema reads', content: jsonBody('ErrorResponse') },
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
            '500': { description: 'The read could not be completed', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy', content: jsonBody('ErrorResponse') },
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
            '500': { description: 'The entity could not be read', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy', content: jsonBody('ErrorResponse') },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations': {
        get: {
          operationId: 'listInvestigations',
          summary: 'The caller\'s recent investigations, across every source the caller may read',
          description:
            'Reads Postgres only; no source is read. Lists the caller\'s own open, undeleted investigations, the most recently edited first and, between equal times, the larger id first. Investigations of a configured source the policy does not let the caller read are left out without a record, and the order, limit and hasMore are those of the investigations that remain; investigations of a source no longer in the configuration are listed with sourceState removed. limit is a whole number from 1 to 25 (5 when left out) and sort is lastEdited, the only order; any other query parameter is refused. sourceAlias is the alias the product stored for the source. save is saved, with the time of the named view, when the caller\'s draft equals the named view it was last saved as, and unsaved otherwise. hasMore is true when more investigations than limit could be listed. counts holds the number of investigations that could be listed, the number of sources they are on (a source no longer in the configuration included) and the number of named views they hold with the newest time any of them was updated (null when there is none), all exact, whatever the limit; the rows, hasMore and counts are read at one snapshot. There is no cursor and no filter.',
          parameters: [
            { name: 'limit', in: 'query', required: false, description: 'A whole number; 5 when left out', schema: { type: 'integer', minimum: 1, maximum: MAX_INVESTIGATION_LIST_LIMIT, default: DEFAULT_INVESTIGATION_LIST_LIMIT } },
            { name: 'sort', in: 'query', required: false, description: 'lastEdited, the only order', schema: { type: 'string', enum: [...INVESTIGATION_LIST_SORTS] } },
          ],
          responses: {
            '200': { description: 'The investigations', content: jsonBody('InvestigationListResponse') },
            '400': { description: 'A query parameter other than limit and sort was sent, limit is not a whole number from 1 to 25, or sort is not lastEdited', content: jsonBody('ErrorResponse') },
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
            '500': { description: 'The investigation could not be written', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy', content: jsonBody('ErrorResponse') },
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
      },
      '/v1/search/entities': {
        post: {
          operationId: 'searchEntities',
          summary: 'Search a source for the entities whose search properties equal a text',
          requestBody: { required: true, content: jsonBody('SearchRequest') },
          description:
            'Matches the whole text, as stored and case-sensitive, against every configured, indexed search property of the source in one read through the gate, and as the integer too when the text is a canonical 64-bit integer. The answer holds at most cap entities in exact (25, or the source\'s max_page when lower); counts.exact is exact up to and including cap and a lowerBound of the hits held (cap, or fewer when normalization left rows out of a capped read) when the read found more; searchable is false when no property was left to search. The text is 1 to 200 characters. entityTypes and matchModes (a non-empty list of different names each, absent when the search is not narrowed, refused with typeahead true) narrow the search to those entity types of the mapping of the source (the exact and the related group; the evidence group is not narrowed by entity type) and to the groups of those match modes (exact, related, evidence; a group that is not chosen is not read and is not searchable in the answer); a name the mapping does not know is INVALID_REQUEST. mask asks for the personal-data fields of the entities to be masked, and a personal-data property is then not searched. dropped and warnings are the normalize stage\'s: rows left out, by reason, and one sentence for each. disabledTypes names entity types that were not searched because their search index is not usable. related is the second group: the records whose reference properties (named by the mapping) hold the text, from one read of their own with its own limit, capped and counted like exact (counts in related.count, scope search:related); the related read adds nothing to exact or to its count: an entity is in exact only through its own exact match, and one that is both appears in both groups. related.searchable is false when no reference property was left to read (none configured, only personal-data ones while masked, or every type left out) and related.disabledTypes names types left out because their reference index is not usable. evidence is the third group: the relationships whose evidence properties (named by the mapping, on a relationship row that has a stable_id) hold the text, from one read of their own with its own limit, capped and counted like exact (counts in evidence.count, scope search:evidence, in supporting relationships). A hit is { supports, records, rules }: supports is the stored reference { sourceId, type, from, to, stableId } of the relationship, records are the values of all its evidence properties, rules are the configured rules of the mapping that use its relationship type. evidence.searchable is false when no relationship row was left to read, and evidence.disabledRelationshipTypes names the rows left out (index-unavailable, or no-stable-id for a row with no stable_id). With typeahead true the text is 2 to 200 characters and the answer also holds startsWith: the entities whose search property starts with the text, apart from the entities in exact, with its own count (exact up to and including cap, a lowerBound above it, never counted as exact matches), dropped and warnings; it is one more read and shares the one schema read. A type-ahead request reads neither the related nor the evidence group: their searchable is false in its answer. A group whose read failed with a code of its own (QUERY_TIMEOUT with timeoutMs, SOURCE_BUSY, RATE_LIMITED or INTERNAL_ERROR) while another group answered is empty, has a count of quality unknown with no value, and is named in failures (always present, empty when every read answered); a retry repeats the whole search. When every group that was read fails, or an error means the same for every group, the search fails as a whole with the status and error of the read. facets (every answer that is not a type-ahead answer; a type-ahead answer holds neither facets nor filters) is the size of the whole match set, whatever is selected, from one read of its own: searchable is false when no target was left to count; otherwise entityType holds an entry for each entity type that has an eligible search or reference target (the entities of that type matched by either, each counted once), matchMode an entry for each match mode with an eligible target (exact, related, evidence; evidence in supporting relationships) and total the entities matched by any target; every count is exact up to and including cap and a lowerBound above it (scopes search:facet:entityType, search:facet:matchMode, search:facet:total), and none is the sum of others. A facet counts the matches in the source, a group shows what the normalize stage can name, so a facet can be higher than its group by the records normalization dropped. The facet read is one more read and is not a result group: when it fails with a code of its own it is named in failures with the group facets, facets is then searchable with an unknown total and no entry, and every group is kept; it is never counted among the groups that failed. filters is the selection the answer was made for (entity types and match modes, each empty when the request did not narrow). The text is never logged and never part of an error.',
          responses: {
            '200': { description: 'The exact matches and their count', content: jsonBody('SearchResult') },
            '400': { description: 'The body or the query is not valid, or the text is not 1 to 200 characters (2 to 200 with typeahead)', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id, or the person may not read it (one answer for both)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '500': { description: 'The search could not run', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy', content: jsonBody('ErrorResponse') },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/graph/preview-expansion': {
        post: {
          operationId: 'previewExpansion',
          summary: 'The degree of a node by relationship type and direction, before anything is loaded',
          requestBody: { required: true, content: jsonBody('DegreePreviewRequest') },
          description:
            'Counts the mapped relationships of one node, one count for each (relationship type, direction) pair of its entity type, in one read through the gate. A count read from the degree of the node (an entity type whose checks showed the server to answer that way) is exact whatever its size; a count read by the bounded read is exact up to and including the source\'s heavy_op_threshold and a lowerBound of that value above it, with one counts-capped warning for each pair read that way; byNeighborType gives the count by the entity type at the other end only where the pair has one mapped neighbor type, and unknown where it has several. total is the sum with the weakest quality of its parts, counted over the mapped relationship ends at the node, and is unknown when a sum would pass the largest safe integer. warnings name a capped count (counts-capped) and a second node with the same stable ID (duplicate-stable-id). A node that is not in the source, is of another entity type, or is in a source that is not configured or that the person may not read is NOT_FOUND, one answer for all. mask is part of the request because the answer is cached per mask setting; no property value is in it. No stable ID or count is logged.',
          responses: {
            '200': { description: 'The degree of the node', content: jsonBody('DegreePreview') },
            '400': { description: 'The body is not valid', content: jsonBody('ErrorResponse') },
            '404': { description: 'The node is not in the source, or the source is not configured or may not be read (one answer for all)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '500': { description: 'The preview could not run, or the source answered with something unreadable', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy', content: jsonBody('ErrorResponse') },
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
            'Reads one page of at most `limit` relationships (the source default page when absent; above the source maximum the answer is QUERY_BUDGET_EXCEEDED) for each asked neighbor type, newest first by the observed time of the mapping row and undated last, with the neighbor nodes. The types are read one after another under one read lease and the answer holds a page and a cursor for each; a failure in any of them answers the failure and no page. A cursor continues one type and is refused with CURSOR_INVALIDATED when altered, expired or minted for another source, person, policy version, sort, neighbor type, relationship types, direction or node. Relationships of a type with no stable ID are returned as aggregate edges with their member count.',
          responses: {
            '200': { description: 'The pages of the neighbor types', content: jsonBody('ExpandResponse') },
            '400': { description: 'The body is not valid, or names a neighbor type or relationship type that is not mapped for the node, or a page size below 1', content: jsonBody('ErrorResponse') },
            '404': { description: 'The node is not in the source, or the source is not configured or may not be read (one answer for all)', content: jsonBody('ErrorResponse') },
            '409': { description: 'A cursor is altered, expired or for another request (CURSOR_INVALIDATED)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '422': { description: 'The page size is over the source maximum (QUERY_BUDGET_EXCEEDED)', content: jsonBody('ErrorResponse') },
            '500': { description: 'The expansion could not run, or the source answered with something unreadable', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy', content: jsonBody('ErrorResponse') },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/sources': {
        get: {
          operationId: 'listSources',
          summary: 'The configured sources, with their state and a summary of their mapping',
          description:
            'Returns every configured source in one response, ordered by id, with nextCursor always null: the configuration file defines the list and it is small, so it is not paged (an exception to the pagination convention). mappingSummary holds exact counts of configured definitions, not of graph data. lastTest summarizes the newest stored test made for the current connection and mapping of the source (null when there is none): when it ran, its outcome, the server product and version, the read-only check, and the degree status and warnings; it holds no address, credential or query text. It is read from the stored record of the product, not from the source. The list takes no query parameters.',
          responses: {
            '200': { description: 'The configured sources', content: jsonBody('SourcesResponse') },
            '400': { description: 'A query parameter was sent', content: jsonBody('ErrorResponse') },
            '500': { description: 'The sources could not be read', content: jsonBody('ErrorResponse') },
          },
        },
      },
    },
    components: {
      schemas: { DegreePreview: schemaJson(degreePreview), DegreePreviewRequest: schemaJson(degreePreviewRequest), EntityLookupRequest: schemaJson(entityLookupRequest), ErrorResponse: schemaJson(errorResponse), ExpandRequest: schemaJson(expandRequest), ExpandResponse: schemaJson(expandResponse), GraphNode: schemaJson(graphNode), HealthResponse: schemaJson(healthResponse), InvestigationListResponse: schemaJson(investigationList), InvestigationResponse: schemaJson(investigationResponse), MeResponse: schemaJson(meResponse), OpenInvestigationRequest: schemaJson(openInvestigationRequest), OpenInvestigationResponse: schemaJson(openInvestigationResponse), ReadyResponse: schemaJson(readyResponse), SearchRequest: schemaJson(searchRequest), SearchResult: schemaJson(searchResult), SourceProfile: schemaJson(sourceProfile), SourceTestReport: schemaJson(sourceTestReport), SourcesResponse: schemaJson(sourcesResponse) },
    },
  };
}
