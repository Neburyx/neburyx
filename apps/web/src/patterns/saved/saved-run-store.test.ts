import { describe, expect, it } from 'vitest';
import { fakeClient } from '../../api/fake-client.js';
import { definitionOk, okRun } from '../patterns-kit.js';
import { createSavedRunStore } from './saved-run-store.js';

const settled = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
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
