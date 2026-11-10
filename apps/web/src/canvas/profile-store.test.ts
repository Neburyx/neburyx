import type { SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiFailure, ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState } from '../state/client-state.js';
import { createProfileStore } from './profile-store.js';

type Reply = (result: ApiResult<SourceProfile>) => void;

function controlled() {
  const asked: Array<{ readonly sourceId: string; readonly reply: Reply; readonly signal: AbortSignal | undefined }> = [];
  const client = fakeClient({
    getProfile: (sourceId, signal) => new Promise((resolve) => asked.push({ sourceId, reply: resolve, signal })),
  });
  return { client, asked };
}

const ok = (sourceId: string): ApiResult<SourceProfile> => ({ ok: true, value: testProfile(sourceId) });
const down: ApiResult<never> = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
const server = (traceId: string): ApiFailure => ({ code: 'SOURCE_UNAVAILABLE', message: 'unavailable', retryable: true, traceId });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the profile store', () => {
  it('asks for the profile of the bound source once, however many readers there are', async () => {
    const { client, asked } = controlled();
    const state = createClientState();
    const store = createProfileStore(client, state.investigation);
    expect(asked).toHaveLength(0);
    state.bindSource('a');
    store.subscribe(() => undefined);
    store.subscribe(() => undefined);
    expect(asked.map((ask) => ask.sourceId)).toEqual(['a']);
    asked[0]?.reply(ok('a'));
    await settle();
    expect(store.getState().request).toMatchObject({ phase: 'ready' });
    expect(asked).toHaveLength(1);
  });

  it('asks for nothing while no source is bound, and goes back to nothing when the binding is dropped', async () => {
    const { client, asked } = controlled();
    const state = createClientState();
    const store = createProfileStore(client, state.investigation);
    expect(store.getState()).toEqual({ sourceId: null, request: { phase: 'idle' } });
    expect(asked).toHaveLength(0);
  });

  it('keeps the profile of the bound source when an older answer arrives after a source change, and never uses an answer for a source that is not bound', async () => {
    const { client, asked } = controlled();
    const state = createClientState();
    const store = createProfileStore(client, state.investigation);
    state.bindSource('a');
    state.bindSource('b');
    expect(asked.map((ask) => ask.sourceId)).toEqual(['a', 'b']);
    expect(asked[0]?.signal?.aborted).toBe(true);
    asked[1]?.reply(ok('b'));
    asked[0]?.reply(ok('a'));
    await settle();
    const current = store.getState();
    expect(current.sourceId).toBe('b');
    expect(current.request.phase === 'ready' && current.request.data.sourceId).toBe('b');
  });

  it('reports the profile as not yet known while the first read is pending, never an empty profile', () => {
    const { client } = controlled();
    const state = createClientState();
    const store = createProfileStore(client, state.investigation);
    state.bindSource('a');
    expect(store.getState().request).toEqual({ phase: 'loading' });
  });

  it('keeps the profile that was read when a later read fails, with the failure beside it', async () => {
    const { client, asked } = controlled();
    const state = createClientState();
    const store = createProfileStore(client, state.investigation);
    state.bindSource('a');
    asked[0]?.reply(ok('a'));
    await settle();
    store.reload();
    asked[1]?.reply({ ok: false, failure: server('trace-9') });
    await settle();
    const request = store.getState().request;
    expect(request.phase).toBe('ready');
    expect(request.phase === 'ready' && request.failure).toEqual(server('trace-9'));
    expect(request.phase === 'ready' && request.data.sourceId).toBe('a');
  });

  it('has no profile and the failure when the first read fails', async () => {
    const { client, asked } = controlled();
    const state = createClientState();
    const store = createProfileStore(client, state.investigation);
    state.bindSource('a');
    asked[0]?.reply(down);
    await settle();
    expect(store.getState().request).toEqual({ phase: 'failed', failure: { code: 'NETWORK_UNAVAILABLE' } });
  });

  it('starts again for a source that is bound again, with nothing left from the one before', async () => {
    const { client, asked } = controlled();
    const state = createClientState();
    const store = createProfileStore(client, state.investigation);
    state.bindSource('a');
    asked[0]?.reply(ok('a'));
    await settle();
    state.bindSource('b');
    expect(store.getState()).toEqual({ sourceId: 'b', request: { phase: 'loading' } });
  });

  it('does not use a profile that names another source than the one asked about, and says so with a failure', async () => {
    const { client, asked } = controlled();
    const state = createClientState();
    const store = createProfileStore(client, state.investigation);
    state.bindSource('a');
    asked[0]?.reply(ok('b'));
    await settle();
    expect(store.getState()).toEqual({ sourceId: 'a', request: { phase: 'failed', failure: { code: 'SCHEMA_MISMATCH' } } });
  });

  it('keeps the profile that was read when a later answer names another source, with the failure beside it', async () => {
    const { client, asked } = controlled();
    const state = createClientState();
    const store = createProfileStore(client, state.investigation);
    state.bindSource('a');
    asked[0]?.reply(ok('a'));
    await settle();
    store.reload();
    asked[1]?.reply(ok('b'));
    await settle();
    const request = store.getState().request;
    expect(request.phase === 'ready' && request.data.sourceId).toBe('a');
    expect(request.phase === 'ready' && request.failure).toEqual({ code: 'SCHEMA_MISMATCH' });
  });

  it('asks for no profile of a source that was removed, and shows no failure for it, while a re-pointed one is read as usual', async () => {
    const { client, asked } = controlled();
    const state = createClientState();
    const store = createProfileStore(client, state.investigation);
    store.subscribe(() => undefined);
    const record = (sourceState: 'removed' | 'repointed') => ({ title: 'T', caseRef: null, status: 'open' as const, readOnly: true, version: 1, save: { kind: 'unsaved' as const }, sourceState });
    state.show({ id: 'i-1', sourceId: 'gone', record: record('removed'), resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    expect(asked).toHaveLength(0);
    expect(store.getState().request).toMatchObject({ phase: 'idle' });
    state.show({ id: 'i-2', sourceId: 'moved', record: record('repointed'), resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    expect(asked.map((ask) => ask.sourceId)).toEqual(['moved']);
  });
});
