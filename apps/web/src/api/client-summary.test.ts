import { describe, expect, it } from 'vitest';
import { SUMMARY_FAILURE_KINDS } from '@neburyx/contracts';
import { createApiClient, type Fetcher } from './client.js';

const REQUEST: Parameters<ReturnType<typeof createApiClient>['summarize']>[0] = { investigationId: 'inv-1', sourceId: 'a', entities: [], edges: [], aggregates: [], derived: [] };
const KEY = 'a-key-of-sixteen-chars';
const COVERAGE = { retrieval: 'r', summary: 's' };
const DRAFT = { status: 'ok', sentences: [{ text: 'One.', cites: ['n1'], storable: true }], citations: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'a', entityType: 'kind-a', stableId: 'x' } }], coverage: COVERAGE, removedCount: 0, sent: 'text', model: 'm', calls: 1, summaryToken: 't' };

function once(body: unknown, status = 200): { readonly fetcher: Fetcher; readonly asked: { path: string; init: Parameters<Fetcher>[1] }[] } {
  const asked: { path: string; init: Parameters<Fetcher>[1] }[] = [];
  return { asked, fetcher: async (path, init) => (asked.push({ path, init }), new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) };
}

describe('summarize', () => {
  it('posts the references to /v1/summary with the idempotency key', async () => {
    const { fetcher, asked } = once(DRAFT);
    const result = await createApiClient(fetcher).summarize(REQUEST, KEY);
    expect(result).toEqual({ ok: true, value: DRAFT });
    expect(asked[0]?.path).toBe('/v1/summary');
    expect(asked[0]?.init).toMatchObject({ method: 'POST', headers: { 'idempotency-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(REQUEST) });
  });

  it.each([
    ['partial', { ...DRAFT, status: 'partial', removedCount: 1 }],
    ['unsupported', { status: 'unsupported', removedCount: 1, coverage: COVERAGE, sent: 'text', model: 'm', calls: 1 }],
    ['tooLarge by elements', { status: 'tooLarge', limit: 'elements', elements: 412, cap: 300 }],
    ['tooLarge by text', { status: 'tooLarge', limit: 'text', estimatedTokens: 9, cap: 5 }],
    ['timeLimit', { status: 'timeLimit', calls: 3 }],
  ])('parses the status %s', async (_name, body) => {
    expect(await createApiClient(once(body).fetcher).summarize(REQUEST, KEY)).toEqual({ ok: true, value: body });
  });

  it.each(SUMMARY_FAILURE_KINDS)('parses a failure of the kind %s', async (kind) => {
    const body = { status: 'failed', kind, calls: 1 };
    expect(await createApiClient(once(body).fetcher).summarize(REQUEST, KEY)).toEqual({ ok: true, value: body });
  });

  it('refuses a failure kind it does not know and an answer that does not parse', async () => {
    expect(await createApiClient(once({ status: 'failed', kind: 'provider said no', calls: 1 }).fetcher).summarize(REQUEST, KEY)).toMatchObject({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await createApiClient(once({ nope: 1 }).fetcher).summarize(REQUEST, KEY)).toMatchObject({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });
});
