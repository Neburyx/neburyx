import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';

describe('buildOpenApiDocument', () => {
  it('has info, the probes, the identity, source and source test paths and their components', () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Neburyx API');
    expect(Object.keys(document.paths)).toEqual(['/healthz', '/readyz', '/v1/me', '/v1/sources/{id}/profile', '/v1/sources/{id}/test', '/v1/entities/{sourceId}/{entityType}/{stableId}', '/v1/investigations', '/v1/investigations/{id}', '/v1/sources']);
    expect(Object.keys(document.components.schemas)).toEqual(['ErrorResponse', 'GraphNode', 'HealthResponse', 'InvestigationResponse', 'MeResponse', 'OpenInvestigationRequest', 'OpenInvestigationResponse', 'ReadyResponse', 'SourceProfile', 'SourceTestReport', 'SourcesResponse']);
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
});
