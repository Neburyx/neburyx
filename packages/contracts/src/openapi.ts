import { z } from 'zod';
import { errorResponseSchema } from './error-response.js';
import { healthResponseSchema } from './health.js';
import { meResponseSchema } from './me.js';
import { readyResponseSchema } from './ready.js';
import { sourceProfileSchema } from './profile.js';
import { sourcesResponseSchema } from './sources.js';

const API_TITLE = 'Neburyx API';
const API_VERSION = '0.0.0';

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: { readonly schemas: { readonly ErrorResponse: Record<string, unknown>; readonly HealthResponse: Record<string, unknown>; readonly MeResponse: Record<string, unknown>; readonly ReadyResponse: Record<string, unknown>; readonly SourceProfile: Record<string, unknown>; readonly SourcesResponse: Record<string, unknown> } };
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
      '/v1/sources': {
        get: {
          operationId: 'listSources',
          summary: 'The configured sources, with their state and a summary of their mapping',
          description:
            'Returns every configured source in one response, ordered by id, with nextCursor always null: the configuration file defines the list and it is small, so it is not paged (an exception to the pagination convention). mappingSummary holds exact counts of configured definitions, not of graph data. The list takes no query parameters.',
          responses: {
            '200': { description: 'The configured sources', content: jsonBody('SourcesResponse') },
            '400': { description: 'A query parameter was sent', content: jsonBody('ErrorResponse') },
            '500': { description: 'The sources could not be read', content: jsonBody('ErrorResponse') },
          },
        },
      },
    },
    components: {
      schemas: { ErrorResponse: schemaJson(errorResponse), HealthResponse: schemaJson(healthResponse), MeResponse: schemaJson(meResponse), ReadyResponse: schemaJson(readyResponse), SourceProfile: schemaJson(sourceProfile), SourcesResponse: schemaJson(sourcesResponse) },
    },
  };
}
