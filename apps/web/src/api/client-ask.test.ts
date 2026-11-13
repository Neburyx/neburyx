import { describe, expect, it } from 'vitest';
import { createApiClient, type Fetcher } from './client.js';

const HASH = 'c'.repeat(64);

function answering(body: unknown, status = 200): { readonly fetcher: Fetcher; readonly seen: Array<{ input: string; method: string | undefined; body: string | undefined }> } {
  const seen: Array<{ input: string; method: string | undefined; body: string | undefined }> = [];
  return {
    seen,
    fetcher: async (input, init) => {
      seen.push({ input, method: init?.method, body: init?.body });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  };
}

describe('the API client, asking one question', () => {
  it('posts the request to /v1/ask/plan and returns each kind of answer', async () => {
    const request = { message: 'which accounts', sourceId: 'demo', send: false };
    for (const body of [
      { preview: 'which accounts', previewHash: HASH },
      { preview: 'which accounts', previewHash: HASH, changed: true },
      { blocked: { tokens: [{ text: 'zorvath', start: 6, end: 13 }] } },
      { plan: { kind: 'unsupported', reason: 'No template fits.' } },
    ]) {
      const { fetcher, seen } = answering(body);
      expect(await createApiClient(fetcher).askPlan(request)).toEqual({ ok: true, value: body });
      expect(seen).toEqual([{ input: '/v1/ask/plan', method: 'POST', body: JSON.stringify(request) }]);
    }
  });

  it('gives a schema mismatch for an answer of no known kind, and the server failure for a refusal', async () => {
    expect(await createApiClient(answering({ preview: 'x' }).fetcher).askPlan({ message: 'x', sourceId: 'demo' })).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    const refusal = { error: { code: 'ASK_UNSUPPORTED', message: 'Ask is not available in this edition.', retryable: false, traceId: 'tr-1', details: { reason: 'not-in-this-edition' } } };
    expect(await createApiClient(answering(refusal, 422).fetcher).askPlan({ message: 'x', sourceId: 'demo' })).toMatchObject({ ok: false, failure: { code: 'ASK_UNSUPPORTED' } });
  });
});
