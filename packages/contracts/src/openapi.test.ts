import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { investigationListQuerySchema } from './investigations.js';
import { buildOpenApiDocument } from './openapi.js';

describe('buildOpenApiDocument', () => {
  it('has info, the probes, the identity, source and source test paths and their components', () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Neburyx API');
    expect(Object.keys(document.paths)).toEqual(['/healthz', '/readyz', '/v1/me', '/v1/sources/{id}/profile', '/v1/sources/{id}/test', '/v1/entities/{sourceId}/{entityType}/{stableId}', '/v1/investigations', '/v1/investigations/{id}', '/v1/search/entities', '/v1/sources']);
    expect(Object.keys(document.components.schemas)).toEqual(['ErrorResponse', 'GraphNode', 'HealthResponse', 'InvestigationListResponse', 'InvestigationResponse', 'MeResponse', 'OpenInvestigationRequest', 'OpenInvestigationResponse', 'ReadyResponse', 'SearchRequest', 'SearchResult', 'SourceProfile', 'SourceTestReport', 'SourcesResponse']);
    expect(document.components.schemas.ErrorResponse).not.toHaveProperty('$schema');
    expect(document.components.schemas.MeResponse).not.toHaveProperty('$schema');
  });

  it('describes the body of the open request from its schema, with the limits it enforces', () => {
    const document = buildOpenApiDocument();
    expect(document.paths['/v1/investigations']).toMatchObject({ post: { requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenInvestigationRequest' } } } } } });
    const request = document.components.schemas.OpenInvestigationRequest;
    expect(request).toMatchObject({
      required: ['sourceId', 'entity'],
      additionalProperties: false,
      properties: {
        caseRef: { type: 'string', minLength: 1, maxLength: 100 },
        entity: { properties: { stableId: { minLength: 1, maxLength: 200 } } },
        mask: { type: 'boolean' },
      },
    });
    expect(request).not.toHaveProperty('properties.title');
  });

  it('gives byte-identical output on every run', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });

  it('describes the body of the search request and its answer from their schemas, with the limits they enforce', () => {
    const document = buildOpenApiDocument();
    expect(document.paths['/v1/search/entities']).toMatchObject({ post: { operationId: 'searchEntities', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchRequest' } } } } } });
    expect(document.components.schemas.SearchRequest).toMatchObject({
      anyOf: [
        { required: ['sourceId', 'text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 200 }, mask: { type: 'boolean' }, typeahead: { const: false } } },
        { required: ['sourceId', 'text', 'typeahead'], additionalProperties: false, properties: { text: { type: 'string', minLength: 2, maxLength: 200 }, typeahead: { const: true } } },
      ],
    });
    expect(document.components.schemas.SearchResult).toMatchObject({
      additionalProperties: false,
      properties: {
        exact: { type: 'array' },
        failures: { type: 'array', items: { properties: { group: { enum: ['exact', 'related', 'startsWith'] } } } },
        related: { type: 'object', additionalProperties: false, properties: { hits: { type: 'array' }, searchable: { type: 'boolean' }, disabledTypes: { type: 'array' } } },
        startsWith: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nodes: { type: 'array' },
            warnings: { type: 'array' },
            count: {
              anyOf: [
                { required: ['value', 'quality', 'scope'], properties: { quality: { enum: ['exact', 'lowerBound'] } } },
                { required: ['quality', 'scope'], properties: { quality: { const: 'unknown' } }, additionalProperties: false },
              ],
            },
          },
        },
      },
    });
  });

  it('describes the list of investigations with its query, its answers and no 403', () => {
    const document = buildOpenApiDocument();
    const { get: list } = z.object({ get: z.object({ parameters: z.array(z.object({ name: z.string(), schema: z.record(z.string(), z.unknown()) })), responses: z.record(z.string(), z.unknown()) }) }).parse(document.paths['/v1/investigations']);
    expect(list.parameters.map((parameter) => parameter.name)).toEqual(['limit', 'sort']);
    expect(Object.keys(list.responses)).toEqual(['200', '400', '500']);
    const { minimum, maximum } = z.object({ minimum: z.number(), maximum: z.number() }).parse(list.parameters[0]?.schema);
    const accepted = (limit: number): boolean => investigationListQuerySchema.safeParse({ limit: String(limit) }).success;
    expect([accepted(minimum - 1), accepted(minimum), accepted(maximum), accepted(maximum + 1)], 'the documented bounds are the ones the route accepts').toEqual([false, true, true, false]);
    expect(document.components.schemas.InvestigationListResponse).toMatchObject({ required: ['items', 'hasMore'], additionalProperties: false });
  });
});
