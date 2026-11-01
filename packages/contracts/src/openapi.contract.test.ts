import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorResponseSchema } from './error-response.js';
import { healthResponseSchema } from './health.js';
import { meResponseSchema } from './me.js';
import { readyResponseSchema } from './ready.js';
import { buildOpenApiDocument } from './openapi.js';

const committed: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../openapi.json', import.meta.url)), 'utf8'));

describe('the committed packages/contracts/openapi.json', () => {
  it('differs from a document built from a changed schema', () => {
    const changed = errorResponseSchema.extend({ extra: z.string() });
    expect(buildOpenApiDocument(changed)).not.toEqual(committed);
  });

  it('differs from a document built from a changed GET /v1/me schema', () => {
    expect(buildOpenApiDocument(undefined, meResponseSchema.extend({ extra: z.string() }))).not.toEqual(committed);
  });

  it('differs from a document built from a changed GET /healthz schema', () => {
    expect(buildOpenApiDocument(undefined, undefined, healthResponseSchema.extend({ extra: z.string() }))).not.toEqual(committed);
  });

  it('lists GET /healthz with the HealthResponse schema', () => {
    expect(buildOpenApiDocument().paths['/healthz']).toMatchObject({
      get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } } } } },
    });
  });

  it('differs from a document built from a changed GET /readyz schema', () => {
    expect(buildOpenApiDocument(undefined, undefined, undefined, readyResponseSchema.extend({ extra: z.string() }))).not.toEqual(committed);
  });

  it('lists GET /readyz with the ReadyResponse schema for 200 and 503', () => {
    const responses = {
      '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ReadyResponse' } } } },
      '503': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ReadyResponse' } } } },
    };
    expect(buildOpenApiDocument().paths['/readyz']).toMatchObject({ get: { responses } });
  });

  it('lists GET /v1/me with the MeResponse schema', () => {
    expect(buildOpenApiDocument().paths['/v1/me']).toMatchObject({
      get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/MeResponse' } } } } } },
    });
  });

  it('equals the generated document', () => {
    expect(buildOpenApiDocument()).toEqual(committed);
  });
});
