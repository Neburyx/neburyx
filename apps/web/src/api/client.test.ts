import { describe, expect, it } from 'vitest';
import { ERROR_TABLE } from '@neburyx/contracts';
import { createApiClient, type Fetcher } from './client.js';

const ME = {
  principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' },
  edition: 'community',
  identityMode: 'none',
  sources: [{ sourceId: 'source-a', viewSensitive: true, synthetic: true }],
};

function respondWith(body: unknown): Fetcher {
  return async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('the API client, reading the principal', () => {
  it('returns the parsed answer, asking for /v1/me', async () => {
    const asked: string[] = [];
    const client = createApiClient(async (input) => {
      asked.push(input);
      return new Response(JSON.stringify(ME));
    });
    const result = await client.getMe();
    expect(result).toEqual({ ok: true, value: ME });
    expect(asked).toEqual(['/v1/me']);
  });

  it('gives a network failure, and no value, when the request cannot be made', async () => {
    const client = createApiClient(async () => {
      throw new TypeError('failed to fetch');
    });
    expect(await client.getMe()).toEqual({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
  });

  it('gives a schema mismatch, and no partial value, for an answer that is not a principal', async () => {
    const client = createApiClient(respondWith({ principal: { displayName: 'x' } }));
    expect(await client.getMe()).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('treats a gateway status, or an error status with no body (what the dev proxy sends when the API is down), as the API being unreachable', async () => {
    for (const [status, body] of [[502, 'bad gateway'], [503, ''], [504, '{}'], [500, '']] as const) {
      const client = createApiClient(async () => new Response(body, { status }));
      expect(await client.getMe()).toEqual({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    }
  });

  it('gives an unreadable-response failure for a body that is not JSON', async () => {
    const client = createApiClient(async () => new Response('<html>'));
    expect(await client.getMe()).toEqual({ ok: false, failure: { code: 'UNREADABLE_RESPONSE' } });
  });
});

describe('the API client, reading an error body', () => {
  const body = (code: 'QUERY_BUDGET_EXCEEDED' | 'SOURCE_UNAVAILABLE' | 'RATE_LIMITED' | 'QUERY_TIMEOUT', extra: Record<string, unknown> = {}) => ({
    error: { code, message: ERROR_TABLE[code].message, retryable: ERROR_TABLE[code].retryable, traceId: 'trace-1', ...extra },
  });
  const failWith = (status: number, payload: unknown): Fetcher => async () => new Response(JSON.stringify(payload), { status });

  it('returns the code, message, retryable flag, trace ID and the allowed typed details', async () => {
    const client = createApiClient(failWith(400, body('QUERY_BUDGET_EXCEEDED', { details: { maxPage: 100 } })));
    const result = await client.getMe();
    expect(result).toEqual({ ok: false, failure: { code: 'QUERY_BUDGET_EXCEEDED', message: ERROR_TABLE.QUERY_BUDGET_EXCEEDED.message, retryable: ERROR_TABLE.QUERY_BUDGET_EXCEEDED.retryable, traceId: 'trace-1', details: { maxPage: 100 } } });
  });

  it.each(['SOURCE_UNAVAILABLE', 'QUERY_TIMEOUT', 'RATE_LIMITED'] as const)('returns %s, not an unreachable API, at the status the contract gives it (also 503 and 504)', async (code) => {
    const result = await createApiClient(failWith(ERROR_TABLE[code].status, body(code))).getMe();
    expect(result).toMatchObject({ ok: false, failure: { code, traceId: 'trace-1' } });
    expect(result.ok).toBe(false);
  });

  it.each([
    ['an unknown code', { error: { code: 'MADE_UP', message: 'x', retryable: false, traceId: 't' } }],
    ['a field its code does not allow', body('SOURCE_UNAVAILABLE', { extra: 1 })],
    ['details that belong to another code', body('SOURCE_UNAVAILABLE', { details: { maxPage: 3 } })],
    ['a message that is not the code\'s message', body('RATE_LIMITED', { message: 'something else' })],
    ['a body of the wrong type', ['error']],
    ['no error key', { code: 'SOURCE_UNAVAILABLE' }],
  ])('returns a schema mismatch, never a partial error, for %s', async (_name, payload) => {
    expect(await createApiClient(failWith(400, payload)).getMe()).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('gives ABORTED, and no value, when the transport answers after the caller aborted', async () => {
    const controller = new AbortController();
    const late: Fetcher = async () => {
      controller.abort();
      return new Response(JSON.stringify(ME));
    };
    expect(await createApiClient(late).getMe(controller.signal)).toEqual({ ok: false, failure: { code: 'ABORTED' } });
  });

  it.each([400, 502, 503, 504])('reads an invalid error envelope as a schema mismatch at %i too, never as an unreachable API', async (status) => {
    const unknownCode = { error: { code: 'MADE_UP', message: 'x', retryable: false, traceId: 't' } };
    expect(await createApiClient(failWith(status, unknownCode)).getMe()).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await createApiClient(failWith(status, body('SOURCE_UNAVAILABLE', { extra: 1 }))).getMe()).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('never repeats the response body in a failure', async () => {
    const result = await createApiClient(async () => new Response('secret-token-123 <html>', { status: 200 })).getMe();
    expect(JSON.stringify(result)).not.toContain('secret-token-123');
    expect(result).toEqual({ ok: false, failure: { code: 'UNREADABLE_RESPONSE' } });
  });

  it('gives ABORTED when the caller aborts before the request and when it aborts while the answer is awaited, and never a value', async () => {
    const before = new AbortController();
    before.abort();
    let asked = 0;
    const counting: Fetcher = async () => { asked += 1; return new Response(JSON.stringify(ME)); };
    expect(await createApiClient(counting).getMe(before.signal)).toEqual({ ok: false, failure: { code: 'ABORTED' } });
    expect(asked).toBe(0);

    const during = new AbortController();
    const hanging: Fetcher = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = createApiClient(hanging).getMe(during.signal);
    during.abort();
    expect(await pending).toEqual({ ok: false, failure: { code: 'ABORTED' } });
  });
});

describe('the API client, reading sources and a profile', () => {
  it('asks for /v1/sources and for a profile by the source id, encoded in the path', async () => {
    const asked: string[] = [];
    const client = createApiClient(async (input) => {
      asked.push(input);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await client.getSources();
    await client.getProfile('a b/c');
    expect(asked).toEqual(['/v1/sources', '/v1/sources/a%20b%2Fc/profile']);
  });

  it('gives a schema mismatch, never a partial value, for a list or a profile that does not match its contract', async () => {
    const client = createApiClient(async () => new Response(JSON.stringify({ items: [{ id: 1 }], nextCursor: null })));
    expect(await client.getSources()).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await client.getProfile('a')).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });
});
