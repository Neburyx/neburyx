import { describe, expect, it } from 'vitest';
import { fakeClient } from '../../api/fake-client.js';
import type { ApiClient } from '../../api/client.js';
import { definitionOk, okRun } from '../patterns-kit.js';
import { createDefinitionRunStore, type DefinitionAsk } from '../run/definition-run-store.js';
import { failure } from '../patterns-kit.js';
import { createSavedRunStore, savedRunRequest } from './saved-run-store.js';

const DEFINITION = { anchorType: 'kind-a', steps: [{ relationshipTypes: ['link-a'], direction: 'out' as const, arrivesAt: 'kind-b' }] };
const ask = (extra: Partial<DefinitionAsk> = {}): DefinitionAsk => ({ definition: DEFINITION, ...extra });

const settled = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('the answer of a saved run', () => {
  it('is read as the kind the person pressed Run on says, whatever the list holds meanwhile', async () => {
    const store = createSavedRunStore(fakeClient({ runSavedPattern: async () => ({ ok: true, value: okRun(['acc-2']) }) }), false);
    store.run({ id: 'p-1', kind: 'preset-run' });
    await settled();
    expect(store.getState().result?.answer.kind).toBe('template');
    const other = createSavedRunStore(fakeClient({ runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) }), false);
    other.run({ id: 'p-2', kind: 'definition' });
    await settled();
    expect(other.getState().result?.answer.kind).toBe('pattern');
  });

  it('is a mismatch, never a result, when its shape is not the kind’s', async () => {
    const store = createSavedRunStore(fakeClient({ runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) }), false);
    store.run({ id: 'p-1', kind: 'preset-run' });
    await settled();
    expect(store.getState().result).toBeUndefined();
    expect(store.getState().failure).toEqual({ code: 'SCHEMA_MISMATCH' });
  });
});

describe('the request of a saved pattern built in the app, in the store of the run view', () => {
  const store = (answer: ApiClient['runSavedPattern'] | undefined, mask = false) => {
    const sent: unknown[] = [];
    const client = fakeClient({
      runSavedPattern: async (id, request, key, signal) => {
        sent.push({ id, request, key });
        return answer === undefined ? { ok: false, failure: failure('NOT_FOUND') } : answer(id, request, key, signal);
      },
    });
    return { store: createDefinitionRunStore(savedRunRequest(client, 'p-1', mask)), sent };
  };

  it('sends no anchor for a pattern that holds its start, and the entity it is asked for otherwise', async () => {
    const { store: held, sent } = store(async () => ({ ok: true, value: definitionOk(['acc-2']) }));
    held.run(ask());
    await settled();
    expect(sent[0]).toMatchObject({ id: 'p-1', request: {} });
    expect(Object.keys((sent[0] as { request: object }).request)).toEqual([]);
    expect(held.getState().result?.answer.matches).toHaveLength(1);
    const { store: asked, sent: sentAsked } = store(async () => ({ ok: true, value: definitionOk(['acc-2']) }), true);
    asked.run(ask({ anchor: { entityType: 'kind-a', stableId: 'acc-2' } }));
    await settled();
    expect((sentAsked[0] as { request: unknown }).request).toEqual({ anchor: { entityType: 'kind-a', stableId: 'acc-2' }, mask: true });
  });

  it('carries the continuation and the cursor of the page before', async () => {
    const { store: paged, sent } = store(async () => ({ ok: true, value: definitionOk(['acc-2'], { nextCursor: 'c-1' }) }));
    paged.run(ask({ continue: { limit: 25 } }));
    await settled();
    paged.next();
    await settled();
    expect((sent[0] as { request: unknown }).request).toEqual({ continue: true, limit: 25 });
    expect((sent[1] as { request: unknown }).request).toEqual({ continue: true, limit: 25, cursor: 'c-1' });
  });

  it('keeps the answer that says the pattern is unavailable, with no result', async () => {
    const { store: gone } = store(async () => ({ ok: true, value: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type' }] } }));
    gone.run(ask());
    await settled();
    expect(gone.getState().unavailable?.reasons).toEqual([{ code: 'unknown-entity-type' }]);
    expect(gone.getState().result).toBeUndefined();
    expect(gone.getState().running).toBe(false);
  });

  it('keeps NOT_FOUND as the failure, and an answer of the built-in shape as a mismatch', async () => {
    const { store: missing } = store(undefined);
    missing.run(ask());
    await settled();
    expect(missing.getState().failure?.code).toBe('NOT_FOUND');
    const { store: wrong } = store(async () => ({ ok: true, value: okRun(['acc-2']) }));
    wrong.run(ask());
    await settled();
    expect(wrong.getState().failure).toEqual({ code: 'SCHEMA_MISMATCH' });
    expect(wrong.getState().result).toBeUndefined();
  });

  it('aborts the run on dispose, and shows nothing of an answer that comes later', async () => {
    let signal: AbortSignal | undefined;
    const { store: leaving } = store((_id, _request, _key, given) => {
      signal = given;
      return new Promise(() => undefined);
    });
    leaving.run(ask());
    leaving.dispose();
    expect(signal?.aborted).toBe(true);
  });
});
