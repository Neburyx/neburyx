import { describe, expect, it } from 'vitest';
import { ASK_REFUSAL_SENTENCES, ERROR_TABLE, INVALID_REQUEST_ENTRIES } from '@neburyx/contracts';
import { createApiClient } from '../api/client.js';

const TOKEN = `${'1'.repeat(10)}.${'a'.repeat(64)}`;

describe('the Ask client methods', () => {
  it('post the question and nothing else to /v1/ask, and read a refusal as an answer', async () => {
    const seen: { path: string; method: string | undefined; body: unknown }[] = [];
    const client = createApiClient(async (path, init) => {
      seen.push({ path, method: init?.method, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ refused: { cause: 'no-intent', sentence: ASK_REFUSAL_SENTENCES['no-intent'] } }));
    });
    const result = await client.ask({ sourceId: 'a', question: 'who?', mask: true });
    expect(seen).toEqual([{ path: '/v1/ask', method: 'POST', body: { sourceId: 'a', question: 'who?', mask: true } }]);
    expect(result).toEqual({ ok: true, value: { refused: { cause: 'no-intent', sentence: ASK_REFUSAL_SENTENCES['no-intent'] } } });
  });

  it('post the kept intent, entities and token to /v1/ask/continue', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const client = createApiClient(async (path, init) => {
      seen.push({ path, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ refused: { cause: 'no-intent', sentence: ASK_REFUSAL_SENTENCES['no-intent'] } }));
    });
    await client.askContinue({ sourceId: 'a', intent: 'i', entities: { account: 'x' }, continueToken: TOKEN });
    expect(seen).toEqual([{ path: '/v1/ask/continue', body: { sourceId: 'a', intent: 'i', entities: { account: 'x' }, continueToken: TOKEN } }]);
  });

  it('fail with a schema mismatch for an answer that is neither answered nor refused', async () => {
    const client = createApiClient(async () => new Response(JSON.stringify({ ok: true })));
    const result = await client.ask({ sourceId: 'a', question: 'q' });
    expect(result.ok).toBe(false);
  });

  it('read the real bodies of an invalid continue and of a build without Ask as failures with their reasons', async () => {
    const entry = INVALID_REQUEST_ENTRIES['continue-invalid'];
    const invalid = createApiClient(async () => new Response(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: entry.message, retryable: entry.retryable, traceId: 't', details: { reason: 'continue-invalid' } } }), { status: 400 }));
    const result = await invalid.askContinue({ sourceId: 'a', intent: 'i', entities: {}, continueToken: TOKEN });
    expect(result.ok === false && result.failure.code === 'INVALID_REQUEST' && 'details' in result.failure && result.failure.details?.reason).toBe('continue-invalid');
    const audit = createApiClient(async () => new Response(JSON.stringify({ error: { code: 'AUDIT_UNAVAILABLE', message: ERROR_TABLE.AUDIT_UNAVAILABLE.message, retryable: ERROR_TABLE.AUDIT_UNAVAILABLE.retryable, traceId: 't' } }), { status: 503 }));
    expect((await audit.ask({ sourceId: 'a', question: 'q' })).ok).toBe(false);
  });
});
