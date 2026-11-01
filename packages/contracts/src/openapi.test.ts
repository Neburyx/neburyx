import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';

describe('buildOpenApiDocument', () => {
  it('has info, the GET /v1/me path and the ErrorResponse and MeResponse components', () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Neburyx API');
    expect(Object.keys(document.paths)).toEqual(['/v1/me']);
    expect(Object.keys(document.components.schemas)).toEqual(['ErrorResponse', 'MeResponse']);
    expect(document.components.schemas.ErrorResponse).not.toHaveProperty('$schema');
    expect(document.components.schemas.MeResponse).not.toHaveProperty('$schema');
  });

  it('gives byte-identical output on every run', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });
});
