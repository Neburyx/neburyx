import { rmSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadCommittedDocument, validatorFor } from './testing/document.js';
import { createLogger } from './logger.js';
import { AppError } from './errors.js';
import { CYPHER, IDENTIFIER, registerErrorRoutes } from './testing/error-routes.js';
import { makeWebRoot } from './testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const validateErrorResponse = validatorFor(loadCommittedDocument(), 'ErrorResponse');

let output: string[] = [];
beforeEach(() => {
  output = [];
});

async function app(): ReturnType<typeof buildApp> {
  const server = await buildApp({ webRoot, logger: createLogger({ write: (chunk: string) => output.push(chunk) }) });
  registerErrorRoutes(server);
  return server;
}

async function failureOf(url: string): Promise<{ readonly status: number; readonly body: unknown; readonly traceId: unknown }> {
  const response = await (await app()).inject({ method: 'GET', url });
  return { status: response.statusCode, body: JSON.parse(response.body), traceId: response.headers['x-trace-id'] };
}

describe('the error shape of the committed document', () => {
  it('rejects a body with a code the document does not list', () => {
    expect(validateErrorResponse({ error: { code: 'MADE_UP', message: 'x', retryable: false, traceId: 'tr-1' } })).toBe(false);
  });

  it('rejects a body without a trace ID', () => {
    expect(validateErrorResponse({ error: { code: 'NOT_FOUND', message: 'x', retryable: false } })).toBe(false);
  });
});

describe('an unknown path under /v1', () => {
  it('answers 404 NOT_FOUND in the shared shape, with the trace ID of the response', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/v1/anything' });
    const body: unknown = JSON.parse(response.body);
    expect(response.statusCode).toBe(404);
    expect(body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: response.headers['x-trace-id'] },
    });
    expect(validateErrorResponse(body)).toBe(true);
  });
});

describe('sensitive text in a thrown error', () => {
  it.each(['/v1/test/leaky-app-error', '/v1/test/leaky-error'])('never reaches the response or the log (%s)', async (url) => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url });
    expect(response.body).not.toContain('MATCH');
    expect(response.body).not.toContain(IDENTIFIER);
    expect(output.join('')).not.toContain('MATCH');
    expect(output.join('')).not.toContain(IDENTIFIER);
    expect(validateErrorResponse(JSON.parse(response.body))).toBe(true);
  });

  it('gives an AppError the fixed message of its code and an unexpected Error INTERNAL_ERROR', async () => {
    expect((await failureOf('/v1/test/leaky-app-error')).body).toMatchObject({
      error: { code: 'ACCESS_DENIED', message: 'You do not have access to this.' },
    });
    expect(await failureOf('/v1/test/leaky-error')).toMatchObject({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR' } },
    });
  });
});

describe('details', () => {
  function detailsUrl(code: string, details: unknown): string {
    return `/v1/test/details?code=${code}&details=${encodeURIComponent(JSON.stringify(details))}`;
  }

  it('returns the named field of a code and drops anything else', async () => {
    const { body } = await failureOf(detailsUrl('QUERY_BUDGET_EXCEEDED', { maxPage: 50, query: CYPHER, retryAfterMs: 5 }));
    expect(body).toMatchObject({ error: { code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: 50 } } });
    expect(JSON.stringify(body)).not.toContain('MATCH');
    expect(JSON.stringify(body)).not.toContain('retryAfterMs');
  });

  it.each([{ maxPage: '50' }, { maxPage: -1 }, { maxPage: 1.5 }, { other: 1 }, 'text', null])(
    'drops a field of the wrong type or an unknown field (%j)',
    async (details) => {
      const { body } = await failureOf(detailsUrl('QUERY_BUDGET_EXCEEDED', details));
      expect(body).not.toHaveProperty('error.details');
      expect(validateErrorResponse(body)).toBe(true);
    },
  );

  it('answers RATE_LIMITED with 429, retryable and retryAfterMs', async () => {
    const result = await failureOf(detailsUrl('RATE_LIMITED', { retryAfterMs: 2000 }));
    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true, details: { retryAfterMs: 2000 } } });
  });
});

describe('an AppError thrown by a route', () => {
  it('answers ACCESS_DENIED with 403 and the full body, validating against ErrorResponse', async () => {
    const result = await failureOf('/v1/test/denied');
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: { code: 'ACCESS_DENIED', message: 'You do not have access to this.', retryable: false, traceId: result.traceId },
    });
    expect(validateErrorResponse(result.body)).toBe(true);
  });
});

describe('framework failures', () => {
  it('answers malformed JSON with 400 INVALID_REQUEST', async () => {
    const response = await (await app()).inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'INVALID_REQUEST', traceId: response.headers['x-trace-id'] } });
  });

  it('answers a malformed URL with 400 INVALID_REQUEST', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/v1/test/%zz' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'INVALID_REQUEST', traceId: response.headers['x-trace-id'] } });
  });

  it('answers an unsupported content type with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const response = await (await app()).inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: { 'content-type': 'application/x-unsupported' },
      payload: 'x',
    });
    expect(response.statusCode).toBe(415);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', traceId: response.headers['x-trace-id'] } });
  });
});

describe('hostile errors and details', () => {
  it('falls back to INTERNAL_ERROR when reading the error status throws', async () => {
    const server = await app();
    server.get('/v1/test/hostile-status', async () => {
      const error = new Error('x');
      Object.defineProperty(error, 'statusCode', {
        get() {
          throw new Error(`${CYPHER} for ${IDENTIFIER}`);
        },
      });
      throw error;
    });
    const response = await server.inject({ method: 'GET', url: '/v1/test/hostile-status' });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(response.body).not.toContain(IDENTIFIER);
    expect(output.join('')).not.toContain(IDENTIFIER);
    expect(output.join('')).not.toContain('MATCH');
  });

  it('drops details held behind a throwing getter on the AppError itself', async () => {
    const server = await app();
    server.get('/v1/test/hostile-getter', async () => {
      const error = new AppError('QUERY_BUDGET_EXCEEDED');
      Object.defineProperty(error, 'details', {
        get() {
          throw new Error(`${CYPHER} for ${IDENTIFIER}`);
        },
      });
      throw error;
    });
    const response = await server.inject({ method: 'GET', url: '/v1/test/hostile-getter' });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain(IDENTIFIER);
    expect(response.body).not.toContain('MATCH');
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'QUERY_BUDGET_EXCEEDED' } });
    expect(output.join('')).not.toContain(IDENTIFIER);
  });

  it('drops details whose inspection throws and still answers with the code', async () => {
    const server = await app();
    server.get('/v1/test/hostile-details', async () => {
      const trap = (): never => {
        throw new Error(`${CYPHER} for ${IDENTIFIER}`);
      };
      throw new AppError('QUERY_BUDGET_EXCEEDED', new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap }));
    });
    const response = await server.inject({ method: 'GET', url: '/v1/test/hostile-details' });
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'QUERY_BUDGET_EXCEEDED' } });
    expect(JSON.parse(response.body)).not.toHaveProperty('error.details');
    expect(response.body).not.toContain(IDENTIFIER);
    expect(output.join('')).not.toContain(IDENTIFIER);
  });
});
