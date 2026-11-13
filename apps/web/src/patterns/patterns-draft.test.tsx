import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftWriteRequest, DraftWriteResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { AUTOSAVE_DELAY_MS, createDraftSync } from '../draft/draft-sync.js';
import { key } from '../state/test-data.js';
import { ID } from '../lifecycle/harness.js';
import { failure, heavyRun, okRun, openPatterns, patternsWorkspace, selectAccount, settle, type KitOptions, type PatternsKit } from './patterns-kit.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.parse('2026-11-10T10:00:00.000Z') }));
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.replaceChildren();
});

const page = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined };

async function drafted(run: KitOptions['run'], status: 'open' | 'closed' = 'open') {
  const kit: PatternsKit = await patternsWorkspace({ run });
  const writes: DraftWriteRequest[] = [];
  const client = fakeClient({
    saveDraft: async (_id, _version, body) => {
      writes.push(body);
      const answer: ApiResult<DraftWriteResponse> = { ok: true, value: { version: writes.length + 1, save: { state: 'unsaved', savedAt: null }, notes: null } };
      return answer;
    },
  });
  const held = kit.state.investigation.getState();
  const graph = kit.state.loadedGraph();
  const closed = status === 'closed';
  const { record } = held;
  if (record === null) throw new Error('no record');
  act(() => void kit.state.show({ id: ID, sourceId: 'a', record: { ...record, status, readOnly: closed }, resultKeys: [key('a')], nodeRefs: graph.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('a'), result: { sourceId: 'a', nodes: [...graph.nodes], edges: [] } }]));
  const sync = createDraftSync({ client, state: kit.state, page, document: page });
  sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: status === 'open' });
  await openPatterns();
  selectAccount(kit.state, 'acc-1');
  fireEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
  await settle();
  await act(async () => void (await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)));
  return { kit, writes };
}

const pass = (): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)));

describe('the draft after a pattern run', () => {
  it('is not written for a result, only for what is added to the canvas, and then once with the result items', async () => {
    const { writes } = await drafted(async () => ({ ok: true, value: okRun(['acc-2', 'acc-3']) }));
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    await pass();
    expect(writes).toHaveLength(1);
    const loaded = writes[0]?.queryContext.loaded.nodes.map((entry) => entry.id).sort();
    expect(loaded).toEqual(['acc-1', 'acc-2', 'acc-3', 'dev-1']);
  });

  it('is not written after a heavy stop', async () => {
    const { writes } = await drafted(async () => ({ ok: true, value: heavyRun() }));
    await pass();
    expect(writes).toHaveLength(0);
  });

  it('is not written for a failed run', async () => {
    const { writes } = await drafted(async () => ({ ok: false, failure: failure('SOURCE_UNAVAILABLE') }));
    await pass();
    expect(writes).toHaveLength(0);
  });

  it('is not written when the result is added to a closed investigation', async () => {
    const { writes } = await drafted(async () => ({ ok: true, value: okRun(['acc-2', 'acc-3']) }), 'closed');
    fireEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    await pass();
    expect(writes).toHaveLength(0);
  });

  it('is not written for a run cancelled in flight', async () => {
    let call = 0;
    const { writes } = await drafted(async () => {
      if (++call === 1) return { ok: true, value: okRun(['acc-2', 'acc-3']) };
      return new Promise<never>(() => undefined);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    await pass();
    expect(writes).toHaveLength(0);
  });
});
