import { useState } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AskSummary } from '@neburyx/contracts';
import { addResultToGraph, type AddedOutcome } from '../patterns/add-to-graph.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { ResultView } from './plan-result.js';
import { addableOf } from './plan-result-model.js';
import type { ResultPanel, RunView } from './result-panel.js';

afterEach(cleanup);

const SOURCE = 'demo';
const NODE = (stableId: string, entityType = 'widget') => ({
  ref: { sourceId: SOURCE, entityType, stableId },
  display: { title: `Widget ${stableId}`, type: entityType },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});
const sharedResult = (): RunView =>
  ({
    outcome: 'complete',
    result: { templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'exact', value: 2, scope: 'test' }, matchIds: [NODE('w-2').ref], nodes: [NODE('w-1'), NODE('w-2')], edges: [], notices: [], warnings: [] } },
  }) as RunView;

const withSummary = (run: RunView, summary: AskSummary): RunView => ({ ...run, summary });
const cite = (key: string, stableId: string, title = `Widget ${stableId}`) => ({ key, element: NODE(stableId).ref, type: 'widget', title });
const SUMMARY: AskSummary = {
  sentences: [
    { text: 'Other records that share an attribute with Widget w-1: ~ 1,500 (estimated).', cites: ['n1'] },
    { text: 'There may be more: ≥ 40 · lower bound, and the rest has no count.', cites: ['n1', 'n2'] },
  ],
  citations: [cite('n1', 'w-1'), cite('n2', 'w-2')],
  omissions: '2 shown; ≥ 38 · lower bound not yet retrieved.',
};

/** Holds a finished result the way the panel does: Add to graph goes through the same add the application uses. */
function Held({ run, state }: { readonly run: RunView; readonly state: ReturnType<typeof createClientState> }) {
  const [added, setAdded] = useState<AddedOutcome | undefined>(undefined);
  const addable = addableOf(run.result);
  const panel: ResultPanel = {
    stage: { kind: 'result', seconds: 0, outcome: run.outcome, run, added },
    canAdd: addable !== undefined,
    addToGraph: () => {
      if (addable === undefined || added !== undefined) return;
      setAdded(addResultToGraph(state, addable, { sourceId: SOURCE, principalId: 'p' }));
    },
    continueRun: () => undefined,
    cancel: () => undefined,
  };
  return <ResultView panel={panel} />;
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

async function ran(summary: AskSummary | 'none' = SUMMARY) {
  const state = createClientState();
  state.bindSource(SOURCE);
  render(
    <ClientStateProvider state={state}>
      <Held run={summary === 'none' ? sharedResult() : withSummary(sharedResult(), summary)} state={state} />
    </ClientStateProvider>,
  );
  return { state };
}

describe('the answer under a result', () => {
  it('draws the sentences exactly as the server wrote them, a marker after each cite in the order of first citation, and the omissions line', async () => {
    await ran();
    const section = screen.getByRole('region', { name: 'Answer' });
    const items = within(section).getAllByRole('listitem').slice(0, 2);
    expect(items[0]?.textContent).toBe('Other records that share an attribute with Widget w-1: ~ 1,500 (estimated).[1]');
    expect(items[1]?.textContent).toBe('There may be more: ≥ 40 · lower bound, and the rest has no count.[1][2]');
    expect(within(section).getByText('2 shown; ≥ 38 · lower bound not yet retrieved.')).toBeTruthy();
  });

  it('shows each count with its label, and no digit for a count that has none', async () => {
    await ran();
    const text = screen.getByRole('region', { name: 'Answer' }).textContent ?? '';
    expect(text).toContain('~ 1,500 (estimated)');
    expect(text).toContain('≥ 40 · lower bound');
    expect(text).toContain('the rest has no count.');
  });

  it('draws nothing of an answer when the run has no summary, and the counts and notices are as before', async () => {
    await ran('none');
    expect(screen.queryByRole('region', { name: 'Answer' })).toBeNull();
    expect(screen.getByText('Matches', { selector: 'dt' })).toBeTruthy();
  });

});

describe('the list of sources', () => {
  it('is a button that announces its state, comes after the markers in reading order, and lists each source in key order with its type and title as they arrived', async () => {
    await ran();
    const toggle = screen.getByRole('button', { name: '2 sources' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const markers = screen.getAllByRole('button', { name: /^Source / });
    for (const marker of markers) expect(marker.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const lines = within(screen.getByRole('region', { name: 'Answer' })).getAllByRole('listitem').slice(2).map((item) => item.textContent);
    expect(lines).toEqual(['widget Widget w-1', 'widget Widget w-2']);
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the stable-ID fallback as the title and nothing more, and no property', async () => {
    await ran({ sentences: [{ text: 'w-3 is of type widget.', cites: ['n1'] }], citations: [cite('n1', 'w-3', 'w-3')] });
    await userEvent.click(screen.getByRole('button', { name: '1 source' }));
    expect(screen.getAllByRole('listitem').map((item) => item.textContent).at(-1)).toBe('widget w-3');
  });
});

describe('a marker', () => {
  const marker = (number: string): HTMLButtonElement => screen.getAllByRole('button', { name: new RegExp(`^Source ${number}:`) })[0] as HTMLButtonElement;

  it('says to use Add to graph first when the result was not added, and selects nothing', async () => {
    const { state } = await ran();
    await userEvent.click(marker('1'));
    expect(await screen.findByText('It is not on the graph yet. Use Add to graph first.')).toBeTruthy();
    expect(state.presentation.view.getState().selection.size).toBe(0);
  });

  it('keeps one status region mounted and announces the same words again after a second press, and clears it when an element is selected', async () => {
    await ran();
    const region = screen.getAllByRole('status').find((element) => element.closest('.ask-summary') !== null);
    expect(region?.textContent).toBe('');
    await userEvent.click(marker('1'));
    expect(await within(screen.getByRole('region', { name: 'Answer' })).findByText('It is not on the graph yet. Use Add to graph first.')).toBe(region);
    const seen: string[] = [];
    const watcher = new MutationObserver(() => seen.push(region?.textContent ?? ''));
    watcher.observe(region as Node, { childList: true, characterData: true, subtree: true });
    await userEvent.click(marker('1'));
    await within(screen.getByRole('region', { name: 'Answer' })).findByText('It is not on the graph yet. Use Add to graph first.');
    watcher.disconnect();
    expect(seen).toContain('');
    expect(region?.textContent).toBe('It is not on the graph yet. Use Add to graph first.');
  });

  it('selects the element through the app’s own selection once it is on the graph, with no request, and the keyboard does the same', async () => {
    const { state } = await ran();
    await userEvent.click(button('Add to graph'));
    act(() => state.presentation.select([]));
    await userEvent.click(marker('2'));
    expect([...state.presentation.view.getState().selection]).toEqual([elementKey(NODE('w-2').ref)]);
    act(() => state.presentation.select([]));
    marker('1').focus();
    await userEvent.keyboard('{Enter}');
    expect([...state.presentation.view.getState().selection]).toEqual([elementKey(NODE('w-1').ref)]);
    act(() => state.presentation.select([]));
    await userEvent.keyboard(' ');
    expect([...state.presentation.view.getState().selection]).toEqual([elementKey(NODE('w-1').ref)]);
  });

  it('clears what a marker said about an element that was not on the graph once the result is added', async () => {
    await ran();
    await userEvent.click(marker('1'));
    expect(await screen.findByText('It is not on the graph yet. Use Add to graph first.')).toBeTruthy();
    await userEvent.click(button('Add to graph'));
    expect(screen.queryByText('It is not on the graph yet. Use Add to graph first.')).toBeNull();
  });

  it('says that this kind of result does not add the element when the result lists it only as a citation', async () => {
    const { state } = await ran({ sentences: [{ text: 'x', cites: ['n1'] }], citations: [cite('n1', 'elsewhere')] });
    await userEvent.click(button('Add to graph'));
    act(() => state.presentation.select([]));
    await userEvent.click(marker('1'));
    expect(await screen.findByText('This kind of result does not add it to the graph.')).toBeTruthy();
    expect(state.presentation.view.getState().selection.size).toBe(0);
  });

  it('says that the element is outside the view when it is on the graph but hidden, and that it is gone when it was removed after the add', async () => {
    const { state } = await ran();
    await userEvent.click(button('Add to graph'));
    act(() => state.hide([elementKey(NODE('w-2').ref)]));
    act(() => state.presentation.select([]));
    await userEvent.click(marker('2'));
    expect(await screen.findByText('It is on the graph but outside the current view.')).toBeTruthy();
    expect(state.presentation.view.getState().selection.size).toBe(0);
    act(() => state.setLoaded([], [], []));
    await userEvent.click(marker('1'));
    expect(await screen.findByText('It is no longer on the graph.')).toBeTruthy();
  });
});
