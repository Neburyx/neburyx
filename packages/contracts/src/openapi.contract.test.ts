import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { askAnswerSchema } from './ask-question.js';
import { edgeDetailSchema } from './edge-detail.js';
import { savedPatternRunResponseSchema } from './saved-pattern-run.js';
import { errorResponseSchema } from './error-response.js';
import { healthResponseSchema } from './health.js';
import { meResponseSchema } from './me.js';
import { readyResponseSchema } from './ready.js';
import { buildOpenApiDocument, shareSchemas } from './openapi.js';
import { sourceProfileSchema } from './profile.js';
import { sourcesResponseSchema } from './sources.js';

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

  it('differs from a document built from a changed GET /v1/sources schema', () => {
    expect(buildOpenApiDocument(undefined, undefined, undefined, undefined, sourcesResponseSchema.extend({ extra: z.string() }))).not.toEqual(committed);
  });

  it('lists GET /v1/sources with the SourcesResponse schema, the error responses and the unpaged exception', () => {
    const operation = buildOpenApiDocument().paths['/v1/sources'];
    expect(operation).toMatchObject({
      get: {
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/SourcesResponse' } } } },
          '400': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '500': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        },
      },
    });
    expect(JSON.stringify(operation)).toContain('not paged');
    expect(JSON.stringify(operation)).toContain('exact counts of configured definitions');
  });

  it('differs from a document built from a changed GET /v1/sources/{id}/profile schema', () => {
    expect(buildOpenApiDocument(undefined, undefined, undefined, undefined, undefined, sourceProfileSchema.extend({ extra: z.string() }))).not.toEqual(committed);
  });

  it('lists GET /v1/sources/{id}/profile with the id parameter, the ETag header, 200, 304, 400 and 404', () => {
    const operation = buildOpenApiDocument().paths['/v1/sources/{id}/profile'];
    expect(operation).toMatchObject({
      get: {
        parameters: [{ name: 'id', in: 'path', required: true }, { name: 'If-None-Match', in: 'header', required: false }],
        responses: {
          '200': { headers: { ETag: {} }, content: { 'application/json': { schema: { $ref: '#/components/schemas/SourceProfile' } } } },
          '304': { headers: { ETag: {} } },
          '400': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '404': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        },
      },
    });
    expect(JSON.stringify(operation)).not.toContain('"500"');
  });

  it('equals the generated document', () => {
    expect(buildOpenApiDocument()).toEqual(committed);
  });
});

describe('the components of the committed openapi.json', () => {
  const schemas = (committed as { components: { schemas: Record<string, Record<string, unknown>> } }).components.schemas;
  const MIN_LENGTH = 200;

  const resolved = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    if (Array.isArray(value)) return value.map(resolved);
    const ref = (value as { $ref?: unknown }).$ref;
    if (typeof ref === 'string') return resolved(schemas[ref.replace('#/components/schemas/', '')]);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolved(item)]));
  };
  const converted = (schema: z.ZodType): unknown => {
    const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { target: 'draft-2020-12' });
    return json;
  };
  it.each([
    ['AskAnswer', askAnswerSchema],
    ['SavedPatternRunResponse', savedPatternRunResponseSchema],
    ['EdgeDetail', edgeDetailSchema],
  ])('%s resolves, reference by reference, to the schema it was converted from', (name, schema) => {
    expect(resolved(schemas[name])).toEqual(converted(schema));
  });

  it('holds no part that is a copy of another component', () => {
    const textOf = new Map<string, string>();
    for (const [name, schema] of Object.entries(schemas)) textOf.set(JSON.stringify(schema), name);
    const copies: string[] = [];
    const walk = (value: unknown, own: string, path: string, root: boolean): void => {
      if (typeof value !== 'object' || value === null) return;
      const text = JSON.stringify(value);
      const other = textOf.get(text);
      if (!root && text.length >= MIN_LENGTH && other !== undefined && other !== own) copies.push(`${own}${path} is ${other}`);
      for (const [key, item] of Object.entries(value)) walk(item, own, `${path}/${key}`, false);
    };
    for (const [name, schema] of Object.entries(schemas)) walk(schema, name, '', true);
    expect(copies).toEqual([]);
  });

  it('keeps the answer of Ask and the saved pattern run small', () => {
    expect(JSON.stringify(schemas['AskAnswer']).length).toBeLessThan(10_000);
    expect(JSON.stringify(schemas['SavedPatternRunResponse']).length).toBeLessThan(10_000);
  });
});

describe('sharing the components of the document', () => {
  const big = (kind: string) => ({ type: 'object', properties: { kind: { type: 'string', const: kind }, text: { type: 'string', description: 'x'.repeat(200) } }, required: ['kind'] });

  it('replaces a part that is another component by a reference, and never the component itself', () => {
    const shared = shareSchemas({ Inner: big('a'), Outer: { type: 'object', properties: { inner: big('a'), other: big('b') } } });
    expect(shared['Inner']).toEqual(big('a'));
    expect(shared['Outer']).toEqual({ type: 'object', properties: { inner: { $ref: '#/components/schemas/Inner' }, other: big('b') } });
  });

  it('does not make a reference to a schema that two components have, whichever the part is', () => {
    const shared = shareSchemas({ One: big('a'), Two: big('a'), Holder: { type: 'array', items: big('a') } });
    expect(shared['Holder']).toEqual({ type: 'array', items: big('a') });
  });

  it('does not replace a value under const, enum, default or examples, nor a part that is short', () => {
    const shared = shareSchemas({ Inner: big('a'), Short: { type: 'string' }, Holder: { type: 'object', properties: { s: { type: 'string' } }, default: big('a'), examples: [big('a')], x: { const: big('a') } } });
    expect(JSON.stringify(shared['Holder'])).not.toContain('$ref');
  });

  it('gives back, from the resolved components, the document that is committed', () => {
    const schemas = (committed as { components: { schemas: Record<string, Record<string, unknown>> } }).components.schemas;
    const resolve = (value: unknown): unknown => {
      if (typeof value !== 'object' || value === null) return value;
      if (Array.isArray(value)) return value.map(resolve);
      const ref = (value as { $ref?: unknown }).$ref;
      if (typeof ref === 'string') return resolve(schemas[ref.replace('#/components/schemas/', '')]);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
    };
    const whole = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, resolve(schema) as Record<string, unknown>]));
    expect(shareSchemas(whole)).toEqual(schemas);
  });
});
