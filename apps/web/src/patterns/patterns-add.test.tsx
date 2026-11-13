import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { elementKey } from '../state/keys.js';
import { ref } from '../state/test-data.js';
import { failure, okRun, openPatterns, patternsWorkspace, selectAccount, settle } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

async function shown(matches: readonly string[]) {
  const kit = await patternsWorkspace({ run: async () => ({ ok: true, value: okRun(matches) }) });
  await openPatterns();
  selectAccount(kit.state, 'acc-1');
  await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
  await settle();
  return kit;
}

const nodeIds = (kit: Awaited<ReturnType<typeof shown>>): string[] => kit.state.investigation.getState().nodeRefs.map((r) => r.stableId).sort();

describe('adding a pattern result to the graph', () => {
  it('puts the result nodes and relationships on the canvas and keeps what was held', async () => {
    const kit = await shown(['acc-2', 'acc-3']);
    expect(nodeIds(kit)).toEqual(['acc-1', 'acc-2', 'dev-1']);
    await userEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    expect(nodeIds(kit)).toEqual(['acc-1', 'acc-2', 'acc-3', 'dev-1']);
    expect(kit.state.investigation.getState().edgeRefs).toHaveLength(2);
    const selected = kit.state.presentation.view.getState().selection;
    expect(selected.has(elementKey(ref('a', 'kind-a', 'acc-3')))).toBe(true);
    expect(selected.has(elementKey(ref('a', 'kind-a', 'acc-1')))).toBe(false);
  });

  it('makes no request of its own and is no longer offered once everything is held', async () => {
    const kit = await shown(['acc-2', 'acc-3']);
    const before = kit.sent.length;
    const setLoaded = vi.spyOn(kit.state, 'setLoaded');
    await userEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    expect(kit.sent.length).toBe(before);
    expect(setLoaded).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Add to graph' })).toBeNull();
    const onCanvas = screen.getByRole('button', { name: 'On canvas' }) as HTMLButtonElement;
    expect(onCanvas.disabled).toBe(true);
    expect(screen.getByText('Added 1 entity and 2 relationships. 3 entities already loaded.')).toBeTruthy();
  });

  it('offers no control for a result without matches', async () => {
    await shown([]);
    expect(screen.queryByRole('button', { name: 'Add to graph' })).toBeNull();
  });

  it('states a cut result as a lower bound with no remainder number', async () => {
    const kit = await patternsWorkspace({ run: async () => ({ ok: true, value: okRun(['acc-3'], { count: { value: 25, quality: 'lowerBound', scope: 'matches' } }) }) });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    const text = screen.getByText(/more matches may exist and were not loaded/).textContent ?? '';
    expect(text).toContain('≥ 25 · lower bound');
    expect(text).not.toMatch(/remain|\d+ more/);
  });

  it('offers neither control for a result without matches', async () => {
    await shown([]);
    expect(screen.queryByRole('button', { name: 'On canvas' })).toBeNull();
  });

  it('hides the control when the investigation source has changed', async () => {
    const kit = await shown(['acc-2', 'acc-3']);
    const record = kit.state.investigation.getState().record;
    if (record === null) throw new Error('no record');
    act(() => kit.state.describeInvestigation({ ...record, sourceState: 'removed' }));
    expect(screen.queryByRole('button', { name: 'Add to graph' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'On canvas' })).toBeNull();
  });

  it('adds to a closed investigation', async () => {
    const kit = await shown(['acc-2', 'acc-3']);
    const record = kit.state.investigation.getState().record;
    if (record === null) throw new Error('no record');
    act(() => kit.state.describeInvestigation({ ...record, status: 'closed', readOnly: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    expect(nodeIds(kit)).toContain('acc-3');
  });

  it('keeps what an earlier add put on the canvas when the same pattern is added again after the panel was reopened', async () => {
    let call = 0;
    const kit = await patternsWorkspace({ run: async () => ({ ok: true, value: okRun(++call === 1 ? ['acc-2', 'acc-3'] : ['acc-2', 'acc-4']) }) });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    await openPatterns();
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    const ids = kit.state.loadedGraph().nodes.map((n) => n.ref.stableId);
    expect(ids).toContain('acc-3');
    expect(ids).toContain('acc-4');
  });

  it('says why the control is off while a run is in flight', async () => {
    let release: () => void = () => undefined;
    let call = 0;
    const kit = await patternsWorkspace({
      run: async () => {
        if (++call === 1) return { ok: true, value: okRun(['acc-2', 'acc-3']) };
        await new Promise<void>((resolve) => (release = resolve));
        return { ok: true, value: okRun(['acc-2']) };
      },
    });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    const add = screen.getByRole('button', { name: 'Add to graph' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('aria-describedby')).toBe('patterns-run-in-progress');
    expect(screen.getByText('A run is in progress')).toBeTruthy();
    release();
    await settle();
  });

  it('still offers the retained result after a later run failed', async () => {
    let call = 0;
    const kit = await patternsWorkspace({ run: async () => (++call === 1 ? { ok: true, value: okRun(['acc-2', 'acc-3']) } : { ok: false, failure: failure('SOURCE_UNAVAILABLE') }) });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    expect(nodeIds(kit)).toContain('acc-3');
  });
});
