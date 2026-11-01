import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';

describe('buildOpenApiDocument', () => {
  it('has info, the probe, GET /v1/me and GET /v1/sources paths and their components', () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Neburyx API');
    expect(Object.keys(document.paths)).toEqual(['/healthz', '/readyz', '/v1/me', '/v1/sources']);
    expect(Object.keys(document.components.schemas)).toEqual(['ErrorResponse', 'HealthResponse', 'MeResponse', 'ReadyResponse', 'SourcesResponse']);
    expect(document.components.schemas.ErrorResponse).not.toHaveProperty('$schema');
    expect(document.components.schemas.MeResponse).not.toHaveProperty('$schema');
  });

  it('gives byte-identical output on every run', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });
});
