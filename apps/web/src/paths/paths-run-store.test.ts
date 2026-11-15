import { describe, expect, it } from 'vitest';
import type { PathsRequest, PathsResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { okPaths } from './paths-kit.js';
import { createPathsRunStore } from './paths-run-store.js';

const ASK: PathsRequest = { sourceId: 'a', from: { entityType: 'kind-a', stableId: 'acc-1' }, to: { entityType: 'kind-a', stableId: 'acc-2' }, relTypes: ['link-a'], maxHops: 3, limit: 5 };

interface Held {
  readonly signal: AbortSignal | undefined;
  readonly answer: (result: ApiResult<PathsResponse>) => void;
}

function holding() {
  const held: Held[] = [];
  const client = fakeClient({ findPaths: (_request, signal) => new Promise((resolve) => held.push({ signal, answer: resolve })) });
  return { held, client };
}

const flush = async (): Promise<void> => void (await new Promise((resolve) => setTimeout(resolve, 0)));

describe('the run store of the Paths panel', () => {
  it('shows only the answer of the newest search, aborts the older one, and never shows an answer that arrives late', async () => {
    const { held, client } = holding();
    const store = createPathsRunStore(client, 'a');
    store.run(ASK);
    store.run({ ...ASK, limit: 7 });
    expect(held[0]?.signal?.aborted).toBe(true);
    held[1]?.answer({ ok: true, value: okPaths([['acc-1', 'acc-2']]) });
    await flush();
    held[0]?.answer({ ok: true, value: okPaths([['acc-1', 'x', 'acc-2']]) });
    await flush();
    const view = store.getState();
    expect(view.running).toBe(false);
    expect(view.result?.status === 'ok' && view.result.paths[0]?.hops).toBe(1);
  });

  it('keeps the previous result after a failure, reports the failure to the banner and shows none of its own when it was shown', async () => {
    const reported: string[] = [];
    let answers = 0;
    const client = fakeClient({ findPaths: async () => (answers++ === 0 ? { ok: true, value: okPaths([['acc-1', 'acc-2']]) } : { ok: false, failure: { code: 'SOURCE_BUSY', message: 'm', traceId: 't', retryable: true } }) });
    const store = createPathsRunStore(client, 'a', { report: (failure) => (reported.push(failure.code), true) });
    store.run(ASK);
    await flush();
    store.run(ASK);
    await flush();
    expect(reported).toEqual(['SOURCE_BUSY']);
    expect(store.getState().failure).toBeUndefined();
    expect(store.getState().result).toBeDefined();
  });

  it('keeps its own failure when the banner shows nothing, and ends quietly for an aborted search', async () => {
    const failing = createPathsRunStore(fakeClient({ findPaths: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) }), 'a');
    failing.run(ASK);
    await flush();
    expect(failing.getState().failure?.code).toBe('NETWORK_UNAVAILABLE');
    const { held, client } = holding();
    const aborted = createPathsRunStore(client, 'a');
    aborted.run(ASK);
    aborted.dispose();
    held[0]?.answer({ ok: false, failure: { code: 'ABORTED' } });
    await flush();
    expect(aborted.getState().failure).toBeUndefined();
  });

  it('cancels a running search without showing its answer, and leaves the previous result in place', async () => {
    const { held, client } = holding();
    const store = createPathsRunStore(client, 'a');
    store.run(ASK);
    held[0]?.answer({ ok: true, value: okPaths([['acc-1', 'acc-2']]) });
    await flush();
    store.run(ASK);
    store.cancel();
    held[1]?.answer({ ok: true, value: okPaths([['acc-1', 'z', 'acc-2']]) });
    await flush();
    const view = store.getState();
    expect(view.cancelled).toBe(true);
    expect(view.running).toBe(false);
    expect(view.result?.status === 'ok' && view.result.paths[0]?.hops).toBe(1);
  });
});
