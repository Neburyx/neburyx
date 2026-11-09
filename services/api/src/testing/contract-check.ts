import { ERROR_TABLE, errorBodySchema } from '@neburyx/contracts';
import type { FastifyInstance } from 'fastify';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { apiRoutesOf } from '../app.js';
import type { OpenApiDocument } from './document.js';
import { sendRaw } from './raw-request.js';

export interface ContractFailure {
  readonly route: string;
  readonly problem: string;
}

export type ErrorCase =
  | {
      readonly method: 'GET' | 'POST' | 'HEAD';
      readonly url: string;
      readonly payload?: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly raw: string };

export interface OperationExample {
  readonly url: string;
  readonly payload?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const METHODS = [
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['patch', 'PATCH'],
  ['delete', 'DELETE'],
  ['head', 'HEAD'],
  ['options', 'OPTIONS'],
  ['trace', 'TRACE'],
] as const;

const PRODUCT_EXAMPLES: Readonly<Record<string, OperationExample>> = {
  'GET /v1/sources/{id}/profile': { url: '/v1/sources/demo/profile' },
  'POST /v1/sources/{id}/test': { url: '/v1/sources/demo/test' },
  'GET /v1/entities/{sourceId}/{entityType}/{stableId}': { url: '/v1/entities/demo/node_a/A-1' },
  'GET /v1/edges/{ref}': { url: `/v1/edges/${Buffer.from(JSON.stringify({ sourceId: 'demo', type: 'LINKS', from: 'node_a', to: 'node_b', stableId: 'L-1' })).toString('base64url')}` },
  'GET /v1/source-links/{ref}': { url: `/v1/source-links/${Buffer.from(JSON.stringify({ sourceId: 'demo', entityType: 'node_a', stableId: 'A-1' })).toString('base64url')}`, headers: { accept: 'application/json' } },
  'POST /v1/investigations': { url: '/v1/investigations', payload: JSON.stringify({ sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'node_a', stableId: 'A-1' } }) },
  'GET /v1/investigations/{id}': { url: '/v1/investigations/0192f000-0000-7000-8000-000000000001' },
};

const PATH_ITEM_MEMBERS = new Set(['summary', 'description', 'servers', 'parameters']);

const operationSchema = z.object({ responses: z.record(z.string(), z.unknown()) });
const responseSchema = z.object({
  content: z.record(z.string(), z.object({ schema: z.unknown().optional() })).optional(),
});

function pointer(...parts: readonly string[]): string {
  return parts.map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
}

function newAjv(document: OpenApiDocument): Ajv2020 {
  const ajv = new Ajv2020({ strict: false });
  for (const [name, check] of CHECKED_FORMATS) ajv.addFormat(name, check);
  ajv.addSchema({ $id: 'document', ...document });
  return ajv;
}

function compileAt(ajv: Ajv2020, location: string): ValidateFunction | string {
  try {
    return ajv.compile({ $ref: `document#/${location}` });
  } catch (error) {
    return error instanceof Error ? error.message : 'the schema cannot be compiled';
  }
}

const NOT_JSON = Symbol('not JSON');

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return NOT_JSON;
  }
}

function isJson(contentType: unknown): boolean {
  return typeof contentType === 'string' && contentType.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

const utcDateTime = z.iso.datetime();
const uuid = z.uuid();
const CHECKED_FORMATS: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ['date-time', (value: string) => utcDateTime.safeParse(value).success],
  ['uuid', (value: string) => uuid.safeParse(value).success],
]);

function usesUnsupportedFormat(document: OpenApiDocument): boolean {
  return [...JSON.stringify(document).matchAll(/"format":"([^"]*)"/g)].some((match) => !CHECKED_FORMATS.has(match[1] ?? ''));
}

interface Observed {
  readonly label: string;
  readonly status: number;
  readonly traceHeader: unknown;
  readonly contentType: unknown;
  readonly body: string;
}

async function observe(app: FastifyInstance, errorCase: ErrorCase): Promise<Observed> {
  if ('raw' in errorCase) {
    const response = await sendRaw(app, errorCase.raw);
    return {
      label: `RAW ${errorCase.raw.split('\r\n')[0] ?? ''}`,
      status: response.status,
      traceHeader: response.headers['x-trace-id'],
      contentType: response.headers['content-type'],
      body: response.body,
    };
  }
  const response = await app.inject({ ...errorCase });
  return {
    label: `${errorCase.method} ${errorCase.url}`,
    status: response.statusCode,
    traceHeader: response.headers['x-trace-id'],
    contentType: response.headers['content-type'],
    body: response.body,
  };
}

export async function checkErrorResponses(
  app: FastifyInstance,
  document: OpenApiDocument,
  cases: readonly ErrorCase[],
): Promise<readonly ContractFailure[]> {
  await app.ready();
  const validate = compileAt(newAjv(document), pointer('components', 'schemas', 'ErrorResponse'));
  if (typeof validate === 'string') return [{ route: 'ErrorResponse', problem: `the schema cannot be compiled: ${validate}` }];

  const needsSocket = cases.some((errorCase) => 'raw' in errorCase);
  if (needsSocket) await app.listen({ host: '127.0.0.1', port: 0 });
  const failures: ContractFailure[] = [];
  try {
    for (const errorCase of cases) {
      const seen = await observe(app, errorCase);
      const body = parseBody(seen.body);
      const parsed = errorBodySchema.safeParse(body);
      if (body === NOT_JSON || !isJson(seen.contentType) || !validate(body) || !parsed.success) {
        failures.push({ route: seen.label, problem: 'the error response does not match ErrorResponse' });
        continue;
      }
      if (seen.status !== ERROR_TABLE[parsed.data.error.code].status) {
        failures.push({ route: seen.label, problem: 'the status does not match the code' });
      }
      if (seen.traceHeader !== parsed.data.error.traceId) {
        failures.push({ route: seen.label, problem: 'the traceId is not the X-Trace-Id header' });
      }
    }
  } finally {
    if (needsSocket) await app.close();
  }
  return failures;
}

export async function checkOperations(
  app: FastifyInstance,
  document: OpenApiDocument,
  examples: Readonly<Record<string, OperationExample>> = {},
): Promise<readonly ContractFailure[]> {
  await app.ready();
  const ajv = newAjv(document);
  const failures: ContractFailure[] = [];
  const documented = new Set<string>();
  const formatsUnchecked = usesUnsupportedFormat(document);
  if (formatsUnchecked) failures.push({ route: 'document', problem: 'the document uses a format the contract check cannot validate' });

  for (const [path, item] of Object.entries(document.paths)) {
    if (item['$ref'] !== undefined) {
      failures.push({ route: path, problem: 'a path item $ref is not supported by the contract check' });
      continue;
    }
    for (const member of Object.keys(item)) {
      if (!METHODS.some(([method]) => method === member) && !PATH_ITEM_MEMBERS.has(member) && !member.startsWith('x-')) {
        failures.push({ route: path, problem: `the path item has an unknown member ${member}` });
      }
    }
    for (const [method, httpMethod] of METHODS) {
      if (item[method] === undefined) continue;
      const route = `${httpMethod} ${path}`;
      const operation = operationSchema.safeParse(item[method]);
      if (!operation.success) {
        failures.push({ route, problem: 'the operation is malformed in the document' });
        continue;
      }
      documented.add(`${httpMethod} ${path.replaceAll(/\{(\w+)\}/g, ':$1')}`);
      const example = examples[route] ?? PRODUCT_EXAMPLES[route] ?? (path.includes('{') ? undefined : { url: path });
      if (example === undefined) {
        failures.push({ route, problem: 'the operation has no example request' });
        continue;
      }
      const response = await app.inject({ method: httpMethod, url: example.url, payload: example.payload, headers: example.headers });
      const status = String(response.statusCode);
      const key = Object.hasOwn(operation.data.responses, status) ? status : 'default';
      const described = responseSchema.safeParse(operation.data.responses[key]);
      if (!described.success) {
        failures.push({ route, problem: key === 'default' && !Object.hasOwn(operation.data.responses, key) ? `status ${status} is not documented` : 'the response is malformed in the document' });
        continue;
      }
      const json = described.data.content?.['application/json'];
      if (json === undefined) {
        if (response.body.length > 0) failures.push({ route, problem: 'the response has a body the document does not describe' });
        continue;
      }
      if (formatsUnchecked) continue;
      const validate = compileAt(ajv, pointer('paths', path, method, 'responses', key, 'content', 'application/json', 'schema'));
      if (typeof validate === 'string') {
        failures.push({ route, problem: `the schema cannot be compiled: ${validate}` });
      } else if (!isJson(response.headers['content-type'])) {
        failures.push({ route, problem: 'the response is not JSON' });
      } else {
        const body = parseBody(response.body);
        if (body === NOT_JSON) failures.push({ route, problem: 'the response body is not valid JSON' });
        else if (!validate(body)) failures.push({ route, problem: 'the response does not match the document' });
      }
    }
  }

  for (const route of apiRoutesOf(app)) {
    if (!documented.has(`${route.method} ${route.url}`)) {
      failures.push({ route: `${route.method} ${route.url}`, problem: 'the route is not in the document' });
    }
  }
  return failures;
}

export async function checkContract(
  app: FastifyInstance,
  document: OpenApiDocument,
  cases: readonly ErrorCase[],
  examples: Readonly<Record<string, OperationExample>> = {},
): Promise<readonly ContractFailure[]> {
  return [...(await checkOperations(app, document, examples)), ...(await checkErrorResponses(app, document, cases))];
}
