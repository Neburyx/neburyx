import { describe, expect, it } from 'vitest';
import { createApiClient, type Fetcher } from './client.js';

const RECORD = { id: '0192f000-0000-7000-8000-0000000000e1', status: 'ready', format: 'json', filename: 'neburyx-export-20261110T101500Z.json', sizeBytes: 12, createdAt: '2026-11-10T10:15:00.000Z', expiresAt: '2026-11-17T10:15:00.000Z' };
const REQUEST: Parameters<ReturnType<typeof createApiClient>['createExport']>[1] = { kind: 'view', format: 'json', entities: [], edges: [], aggregates: [], derived: [] };
const KEY = 'a-key-of-sixteen-chars';

function once(response: () => Response): { readonly fetcher: Fetcher; readonly asked: { path: string; init: Parameters<Fetcher>[1] }[] } {
  const asked: { path: string; init: Parameters<Fetcher>[1] }[] = [];
  return { asked, fetcher: async (path, init) => (asked.push({ path, init }), response()) };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const error = (code: string, message: string, status: number, details?: unknown) => json({ error: { code, message, retryable: false, traceId: 't', ...(details === undefined ? {} : { details }) } }, status);

describe('createExport', () => {
  it('posts the references with the idempotency key and parses the export', async () => {
    const { fetcher, asked } = once(json(RECORD, 201));
    const result = await createApiClient(fetcher).createExport('inv/1', REQUEST, KEY);
    expect(result).toEqual({ ok: true, value: RECORD });
    expect(asked[0]?.path).toBe('/v1/investigations/inv%2F1/exports');
    expect(asked[0]?.init).toMatchObject({ method: 'POST', headers: { 'idempotency-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(REQUEST) });
  });

  it('answers the server\'s failure, with the limit an export that is too large names', async () => {
    const { fetcher } = once(error('INVALID_REQUEST', 'This view holds more than one export can. Hide some items, then export again.', 400, { reason: 'export-too-large', maxEntities: 300, maxRelationships: 300, maxAggregates: 100, exceeded: 'aggregates' }));
    const result = await createApiClient(fetcher).createExport('i', REQUEST, KEY);
    expect(result).toMatchObject({ ok: false, failure: { code: 'INVALID_REQUEST', details: { reason: 'export-too-large', maxEntities: 300, maxRelationships: 300, maxAggregates: 100, exceeded: 'aggregates' } } });
  });

  it('refuses an answer that is not a ready export, or does not parse', async () => {
    expect(await createApiClient(once(json({ ...RECORD, status: 'pending' }, 201)).fetcher).createExport('i', REQUEST, KEY)).toMatchObject({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await createApiClient(once(json({ nope: 1 }, 201)).fetcher).createExport('i', REQUEST, KEY)).toMatchObject({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('reports a network failure and an abort', async () => {
    const failing: Fetcher = async () => { throw new Error('offline'); };
    expect(await createApiClient(failing).createExport('i', REQUEST, KEY)).toEqual({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    const controller = new AbortController();
    controller.abort();
    expect(await createApiClient(once(json(RECORD)).fetcher).createExport('i', REQUEST, KEY, controller.signal)).toEqual({ ok: false, failure: { code: 'ABORTED' } });
  });
});

describe('downloadExport', () => {
  it('returns the bytes with the name the server gave', async () => {
    const { fetcher, asked } = once(() => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="neburyx-export-20261110T101500Z.json"' } }));
    const result = await createApiClient(fetcher).downloadExport('e/1');
    expect(asked[0]?.path).toBe('/v1/exports/e%2F1/download');
    expect(result.ok && result.value.filename).toBe('neburyx-export-20261110T101500Z.json');
    expect(result.ok && (await result.value.blob.text())).toBe('{"a":1}');
  });

  it('answers a refusal because access changed as the server\'s failure, with its reason', async () => {
    const { fetcher } = once(error('ACCESS_DENIED', 'Your access changed since this export was made. Export again to get a file that matches your current access.', 403, { reason: 'access-changed' }));
    expect(await createApiClient(fetcher).downloadExport('e')).toMatchObject({ ok: false, failure: { code: 'ACCESS_DENIED', details: { reason: 'access-changed' } } });
  });

  it('answers NOT_FOUND, a lost answer and a download with no name', async () => {
    expect(await createApiClient(once(error('NOT_FOUND', 'Not found.', 404)).fetcher).downloadExport('e')).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND' } });
    expect(await createApiClient(() => Promise.reject(new Error('offline'))).downloadExport('e')).toEqual({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    expect(await createApiClient(once(() => new Response('x', { status: 200 })).fetcher).downloadExport('e')).toEqual({ ok: false, failure: { code: 'UNREADABLE_RESPONSE' } });
  });
});
