import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { edgeKey, elementKey } from '../state/keys.js';
import { ref } from '../state/test-data.js';
import { addResultToGraph } from '../patterns/add-to-graph.js';
import { okRun, openPatterns, patternsWorkspace, selectAccount, settle } from '../patterns/patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

async function shown() {
  const kit = await patternsWorkspace({ run: async () => ({ ok: true, value: okRun(['acc-2', 'acc-3']) }) });
  await openPatterns();
  selectAccount(kit.state, 'acc-1');
  await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
  await settle();
  return kit;
}

const references = (): HTMLElement => screen.getByText(/^Evidence:/);

describe('the evidence references of a pattern result', () => {
  it('are text before the result is on the canvas and open the evidence panel on the first drawn relationship carrying them after it', async () => {
    const kit = await shown();
    expect(within(references()).queryByRole('button')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    await userEvent.click(within(references()).getByRole('button', { name: 'AUTH-1' }));
    const target = kit.evidence.target.getState();
    const wanted = kit.state.loadedGraph().edges.find((edge) => edge.evidenceRefs.includes('AUTH-1'));
    expect(target === undefined || wanted === undefined ? undefined : edgeKey(target)).toBe(wanted === undefined ? undefined : edgeKey(wanted.ref));
    expect(target).toBeDefined();
  });

  it('stay text when every relationship that carries them is hidden', async () => {
    const kit = await shown();
    await userEvent.click(screen.getByRole('button', { name: 'Add to graph' }));
    await settle();
    act(() => kit.state.hide([elementKey(ref('a', 'kind-b', 'dev-1'))]));
    await settle();
    expect(within(references()).queryByRole('button')).toBeNull();
  });

  it('are buttons before any click when the relationships were loaded already, as an expansion does', async () => {
    const kit = await shown();
    const run = okRun(['acc-2', 'acc-3']);
    if (run.status !== 'ok') throw new Error('not ok');
    act(() => void addResultToGraph(kit.state, run, { sourceId: 'a', principalId: 'p' }));
    await settle();
    expect(within(references()).getByRole('button', { name: 'AUTH-0' })).toBeTruthy();
    act(() => kit.state.hide([elementKey(ref('a', 'kind-b', 'dev-1'))]));
    await settle();
    expect(within(references()).queryByRole('button')).toBeNull();
  });
});
