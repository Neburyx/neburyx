import { describe, expect, it } from 'vitest';
import type { PathsRequest } from '@neburyx/contracts';
import { createApiClient, type Fetcher } from './client.js';
import { okPaths } from '../paths/paths-kit.js';

const REQUEST: PathsRequest = { sourceId: 'a', from: { entityType: 'kind-a', stableId: 'acc-1' }, to: { entityType: 'kind-a', stableId: 'acc-2' }, relTypes: ['link-a'], maxHops: 3, limit: 5 };

function answering(body: unknown, seen: { url?: string; body?: unknown } = {}): Fetcher {
  return async (input, init) => {
    seen.url = input;
    seen.body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('findPaths of the API client', () => {
  it('posts the search to /v1/graph/paths and returns the parsed answer', async () => {
    const seen: { url?: string; body?: unknown } = {};
    const answer = okPaths([['acc-1', 'acc-2']]);
    expect(await createApiClient(answering(answer, seen)).findPaths(REQUEST)).toEqual({ ok: true, value: answer });
    expect(seen).toEqual({ url: '/v1/graph/paths', body: REQUEST });
  });

  it('returns the stop of a heavy search as an answer, not as a failure', async () => {
    const heavy = { status: 'heavy', estimate: { value: 500, quality: 'lowerBound', scope: 'paths:estimate' }, threshold: 500, continueLimit: 25, warnings: [] };
    expect(await createApiClient(answering(heavy)).findPaths(REQUEST)).toEqual({ ok: true, value: heavy });
  });

  it('gives a schema mismatch, and no value, for an answer that is not a paths answer', async () => {
    expect(await createApiClient(answering({ status: 'ok' })).findPaths(REQUEST)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('gives a schema mismatch when a node, a relationship or a step names another source', async () => {
    const other = okPaths([['acc-1', 'acc-2']]);
    const foreign = { ...other, paths: other.status === 'ok' ? other.paths.map((path) => ({ ...path, steps: path.steps.map((step) => ({ ...step, to: { ...step.to, sourceId: 'b' } })) })) : [] };
    expect(await createApiClient(answering(foreign)).findPaths(REQUEST)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });
});
