import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';

describe('buildOpenApiDocument', () => {
  it('has info, an empty paths object and the ErrorResponse component', () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Neburyx API');
    expect(document.paths).toEqual({});
    expect(Object.keys(document.components.schemas)).toEqual(['ErrorResponse']);
    expect(document.components.schemas.ErrorResponse).not.toHaveProperty('$schema');
  });

  it('gives byte-identical output on every run', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });
});
