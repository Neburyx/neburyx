import { z } from 'zod';
import { errorResponseSchema } from './error-response.js';
import { healthResponseSchema } from './health.js';
import { nodeSchema } from './graph.js';
import { investigationResponseSchema, openInvestigationRequestSchema, openInvestigationResponseSchema } from './investigations.js';
import { meResponseSchema } from './me.js';
import { readyResponseSchema } from './ready.js';
import { sourceProfileSchema } from './profile.js';
import { searchRequestSchema, searchResultSchema } from './search.js';
import { sourceTestReportSchema } from './source-test.js';
import { sourcesResponseSchema } from './sources.js';

const API_TITLE = 'Neburyx API';
const API_VERSION = '0.0.0';

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: { readonly schemas: { readonly ErrorResponse: Record<string, unknown>; readonly GraphNode: Record<string, unknown>; readonly HealthResponse: Record<string, unknown>; readonly InvestigationResponse: Record<string, unknown>; readonly MeResponse: Record<string, unknown>; readonly OpenInvestigationRequest: Record<string, unknown>; readonly OpenInvestigationResponse: Record<string, unknown>; readonly ReadyResponse: Record<string, unknown>; readonly SearchRequest: Record<string, unknown>; readonly SearchResult: Record<string, unknown>; readonly SourceProfile: Record<string, unknown>; readonly SourceTestReport: Record<string, unknown>; readonly SourcesResponse: Record<string, unknown> } };
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
            '403': { description: 'The policy does not allow this principal to read the source', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id, or the source holds no such entity', content: jsonBody('ErrorResponse') },
            '500': { description: 'The read could not be completed', content: jsonBody('ErrorResponse') },
            '503': { description: 'The source is not available, or is busy', content: jsonBody('ErrorResponse') },
            '504': { description: 'The source did not answer in time', content: jsonBody('ErrorResponse') },
          },
        },
      },
      '/v1/investigations': {
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
            '403': { description: 'The policy does not allow this principal to read the source', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id, or the source holds no such entity', content: jsonBody('ErrorResponse') },
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
            'Matches the whole text, as stored and case-sensitive, against every configured, indexed search property of the source in one read through the gate, and as the integer too when the text is a canonical 64-bit integer. The answer holds at most cap entities in exact (25, or the source\'s max_page when lower); counts.exact is exact up to and including cap and a lowerBound of the hits held (cap, or fewer when normalization left rows out of a capped read) when the read found more; searchable is false when no property was left to search. The text is 1 to 200 characters. mask asks for the personal-data fields of the entities to be masked, and a personal-data property is then not searched. dropped and warnings are the normalize stage\'s: rows left out, by reason, and one sentence for each. disabledTypes names entity types that were not searched because their search index is not usable. The text is never logged and never part of an error.',
          responses: {
            '200': { description: 'The exact matches and their count', content: jsonBody('SearchResult') },
            '400': { description: 'The body or the query is not valid, or the text is not 1 to 200 characters', content: jsonBody('ErrorResponse') },
            '404': { description: 'No configured source has this id, or the person may not read it (one answer for both)', content: jsonBody('ErrorResponse') },
            '415': { description: 'The body is not JSON', content: jsonBody('ErrorResponse') },
            '500': { description: 'The search could not run', content: jsonBody('ErrorResponse') },
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
      schemas: { ErrorResponse: schemaJson(errorResponse), GraphNode: schemaJson(graphNode), HealthResponse: schemaJson(healthResponse), InvestigationResponse: schemaJson(investigationResponse), MeResponse: schemaJson(meResponse), OpenInvestigationRequest: schemaJson(openInvestigationRequest), OpenInvestigationResponse: schemaJson(openInvestigationResponse), ReadyResponse: schemaJson(readyResponse), SearchRequest: schemaJson(searchRequest), SearchResult: schemaJson(searchResult), SourceProfile: schemaJson(sourceProfile), SourceTestReport: schemaJson(sourceTestReport), SourcesResponse: schemaJson(sourcesResponse) },
    },
  };
}
