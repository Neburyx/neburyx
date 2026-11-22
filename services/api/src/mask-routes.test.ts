import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp, registeredRoutesOf } from './app.js';
import { createLogger } from './logger.js';
import { parseMapping } from './mapping/load.js';
import { memoryAppStore } from './testing/app-store.js';
import { loadCommittedDocument, type OpenApiDocument } from './testing/document.js';
import { entityRows, plainNode } from './testing/entity-fixtures.js';
import { TestExecutor } from './testing/gate.js';
import { baseSource, fileOf } from './testing/mapping.js';
import { fakeSourceTester } from './testing/source-tester.js';
import { testSourceGate } from './testing/source-gate.js';
import { makeWebRoot } from './testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

/** Routes that return properties and take no `mask`, each with why nothing in a request can change what it returns. */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  'GET /v1/exports/{id}/download': 'serves the file the export already built; the masking of the file was fixed when it was made',
};

/** Routes of the application that the document does not describe, each with why; none today. */
const UNDOCUMENTED: Readonly<Record<string, string>> = {};

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;

const contentSchema = z.record(z.string(), z.looseObject({ schema: z.unknown() }));
const operationSchema = z.looseObject({
  parameters: z.array(z.looseObject({ name: z.string(), in: z.string() })).default([]),
  requestBody: z.looseObject({ content: contentSchema }).optional(),
  responses: z.record(z.string(), z.looseObject({ content: contentSchema.optional() })).default({}),
});
type Operation = z.infer<typeof operationSchema>;

const objectSchema = z.record(z.string(), z.unknown());
const refSchema = z.looseObject({ $ref: z.string() });

interface Finding {
  readonly route: string;
  readonly problem: string;
}

interface Reach {
  readonly properties: boolean;
  readonly unresolved: boolean;
}

/** A schema, followed through references, holds a list of properties when an object with the key, the data class and the masked flag of a property is reachable; every branch is read, so an unresolved reference is found beside a property list. */
function reaches(schema: unknown, schemas: OpenApiDocument['components']['schemas'], seen: Set<string>): Reach {
  const reference = refSchema.safeParse(schema);
  if (reference.success) {
    const name = reference.data.$ref.split('/').pop() ?? '';
    const target = schemas[name];
    if (target === undefined) return { properties: false, unresolved: true };
    if (seen.has(name)) return { properties: false, unresolved: false };
    seen.add(name);
    return reaches(target, schemas, seen);
  }
  const object = objectSchema.safeParse(schema);
  if (!object.success) return Array.isArray(schema) ? reachesAny(schema, schemas, seen) : { properties: false, unresolved: false };
  const properties = objectSchema.safeParse(object.data['properties']);
  const own = properties.success && 'key' in properties.data && 'dataClass' in properties.data && 'masked' in properties.data;
  const below = reachesAny(Object.values(object.data), schemas, seen);
  return { properties: own || below.properties, unresolved: below.unresolved };
}

function reachesAny(parts: readonly unknown[], schemas: OpenApiDocument['components']['schemas'], seen: Set<string>): Reach {
  const found = parts.map((part) => reaches(part, schemas, seen));
  return { properties: found.some((entry) => entry.properties), unresolved: found.some((entry) => entry.unresolved) };
}

function declaresMask(schema: unknown, schemas: OpenApiDocument['components']['schemas']): boolean {
  const reference = refSchema.safeParse(schema);
  if (reference.success) {
    const target = schemas[reference.data.$ref.split('/').pop() ?? ''];
    return target !== undefined && declaresMask(target, schemas);
  }
  const object = objectSchema.safeParse(schema);
  if (!object.success) return false;
  const properties = objectSchema.safeParse(object.data['properties']);
  if (properties.success && 'mask' in properties.data) return true;
  return ['anyOf', 'oneOf', 'allOf'].some((key) => {
    const variants = object.data[key];
    return Array.isArray(variants) && variants.some((variant) => declaresMask(variant, schemas));
  });
}

function takesMask(operation: Operation, schemas: OpenApiDocument['components']['schemas']): boolean {
  if (operation.parameters.some((parameter) => parameter.name === 'mask' && parameter.in === 'query')) return true;
  return Object.values(operation.requestBody?.content ?? {}).some((body) => declaresMask(body.schema, schemas));
}

/** Every operation of the document whose success response holds properties must take `mask` or be named in the exceptions; every entry of the exceptions and of the routes the document does not describe must still be true. */
function findings(document: OpenApiDocument, registered: readonly string[], exceptions: Readonly<Record<string, string>>, undocumented: Readonly<Record<string, string>>): readonly Finding[] {
  const problems: Finding[] = [];
  const described = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const raw = item[method];
      if (raw === undefined) continue;
      const route = `${method.toUpperCase()} ${path}`;
      described.add(route);
      const operation = operationSchema.parse(raw);
      const successes = Object.entries(operation.responses).filter(([code]) => code.startsWith('2'));
      let returnsProperties = false;
      for (const [, response] of successes) {
        for (const body of Object.values(response.content ?? {})) {
          const found = reaches(body.schema, document.components.schemas, new Set());
          if (found.unresolved) problems.push({ route, problem: 'a response schema cannot be resolved, so the route cannot be checked' });
          if (found.properties) returnsProperties = true;
        }
      }
      const masked = takesMask(operation, document.components.schemas);
      const excepted = route in exceptions;
      if (returnsProperties && !masked && !excepted) problems.push({ route, problem: 'returns properties, takes no mask and is not a named exception' });
      if (excepted && !returnsProperties) problems.push({ route, problem: 'is a named exception but returns no properties' });
      if (excepted && masked) problems.push({ route, problem: 'is a named exception but takes mask' });
    }
  }
  for (const route of Object.keys(exceptions)) if (!described.has(route)) problems.push({ route, problem: 'is a named exception but is not a route of the document' });
  for (const route of registered) if (!described.has(route) && !(route in undocumented)) problems.push({ route, problem: 'is registered but the document does not describe it' });
  for (const route of Object.keys(undocumented)) if (!registered.includes(route) || described.has(route)) problems.push({ route, problem: 'is classified as undocumented but is not an undocumented route' });
  return problems;
}

async function registeredRoutes(extra?: (app: Awaited<ReturnType<typeof buildApp>>) => void): Promise<readonly string[]> {
  const mapping = parseMapping(fileOf(baseSource({ id: 'demo' })), 'neburyx.yaml');
  const executor = new TestExecutor(() => Promise.resolve(entityRows(plainNode(['NodeA'], { id: 'A-1' }))));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, sourceTester: fakeSourceTester(mapping).tester, gate: testSourceGate(mapping, { executor }).gate });
  extra?.(app);
  // a route that answers GET also answers HEAD, and the document lists the GET
  const routes = registeredRoutesOf(app).filter((route) => route.method !== 'HEAD').map((route) => `${route.method} ${route.url.replace(/:([A-Za-z]+)/g, '{$1}')}`);
  await app.close();
  return routes;
}

const committed = loadCommittedDocument();
const propertySchema = { type: 'object', properties: { key: {}, value: {}, dataClass: {}, masked: {} } };
const documentWith = (extra: Record<string, unknown>): OpenApiDocument => ({
  paths: {
    '/v1/a': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Holder' } } } } } } },
    ...extra,
  },
  components: { schemas: { Holder: { type: 'object', properties: { properties: { type: 'array', items: propertySchema } } }, Plain: { type: 'object', properties: { name: {} } } } },
});
const returns = (schema: unknown, extra: Record<string, unknown> = {}) => ({ responses: { '200': { content: { 'application/json': { schema } } } }, ...extra });

describe('the routes that return properties', () => {
  it('each take mask or are named exceptions, and every route of the application is described', async () => {
    expect(findings(committed, await registeredRoutes(), EXCEPTIONS, UNDOCUMENTED)).toEqual([]);
  });

  it('finds a route registered outside /v1 that the document does not describe', async () => {
    const routes = await registeredRoutes((app) => {
      app.get('/elsewhere/things', { config: { permission: 'principal' } }, () => ({}));
    });
    expect(findings(committed, routes, EXCEPTIONS, UNDOCUMENTED)).toEqual([{ route: 'GET /elsewhere/things', problem: expect.stringContaining('does not describe') }]);
  });

  it('fails for a response that holds both a property list and an unresolved reference', () => {
    const document = documentWith({ '/v1/b': { get: returns({ anyOf: [{ $ref: '#/components/schemas/Holder' }, { $ref: '#/components/schemas/Gone' }] }, { parameters: [{ name: 'mask', in: 'query' }] }) } });
    expect(findings(document, [], { 'GET /v1/a': 'x' }, {})).toEqual([{ route: 'GET /v1/b', problem: expect.stringContaining('cannot be resolved') }]);
  });

  it('reads a route that returns properties through references, in a list and in a variant', () => {
    const document = documentWith({ '/v1/b': { get: returns({ type: 'array', items: { anyOf: [{ $ref: '#/components/schemas/Plain' }, { $ref: '#/components/schemas/Holder' }] } }) } });
    expect(findings(document, [], {}, {}).map((finding) => finding.route)).toEqual(['GET /v1/a', 'GET /v1/b']);
  });

  it('takes a mask in a query parameter or in a variant of the body', () => {
    const document = documentWith({
      '/v1/a': { get: returns({ $ref: '#/components/schemas/Holder' }, { parameters: [{ name: 'mask', in: 'query' }] }) },
      '/v1/b': { post: returns({ $ref: '#/components/schemas/Holder' }, { requestBody: { content: { 'application/json': { schema: { anyOf: [{ type: 'object', properties: { mask: {} } }] } } } } }) },
    });
    expect(findings(document, [], {}, {})).toEqual([]);
  });

  it('fails for a route that returns properties and takes no mask and is not named', () => {
    expect(findings(documentWith({}), [], {}, {})).toEqual([{ route: 'GET /v1/a', problem: expect.stringContaining('takes no mask') }]);
  });

  it('fails for a response schema that cannot be resolved', () => {
    const document = documentWith({ '/v1/b': { get: returns({ $ref: '#/components/schemas/Gone' }) } });
    expect(findings(document, [], { 'GET /v1/a': 'x' }, {})).toContainEqual({ route: 'GET /v1/b', problem: expect.stringContaining('cannot be resolved') });
  });

  it('fails for a route the document does not describe, unless it is classified', () => {
    const document = documentWith({});
    expect(findings(document, ['GET /v1/c', 'GET /v1/a'], { 'GET /v1/a': 'x' }, {})).toEqual([{ route: 'GET /v1/c', problem: expect.stringContaining('does not describe') }]);
    expect(findings(document, ['GET /v1/c', 'GET /v1/a'], { 'GET /v1/a': 'x' }, { 'GET /v1/c': 'y' })).toEqual([]);
  });

  it('fails for an exception that names no route, a route without properties, or a route that takes mask', () => {
    const document = documentWith({
      '/v1/plain': { get: returns({ $ref: '#/components/schemas/Plain' }) },
      '/v1/masked': { get: returns({ $ref: '#/components/schemas/Holder' }, { parameters: [{ name: 'mask', in: 'query' }] }) },
    });
    const named = { 'GET /v1/a': 'x', 'GET /v1/gone': 'x', 'GET /v1/plain': 'x', 'GET /v1/masked': 'x' };
    expect(findings(document, [], named, {}).map((finding) => `${finding.route}: ${finding.problem}`)).toEqual([
      'GET /v1/plain: is a named exception but returns no properties',
      'GET /v1/masked: is a named exception but takes mask',
      'GET /v1/gone: is a named exception but is not a route of the document',
    ]);
  });
});
