import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternRunResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { ref } from '../../state/test-data.js';
import { typedNode } from '../../workspace/filters-kit.js';
import { definitionHeavy, definitionOk, settle } from '../patterns-kit.js';
import { cleanup, inRun, panelHeader, ran, runCancel, runWorkspace, screen, toggleType, userEvent, within } from './run-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Run = ApiResult<PatternRunResponse>;
const ok = (value: PatternRunResponse): Run => ({ ok: true, value });
const card = (n: number): HTMLElement => within(inRun().getByRole('list', { name: 'Matches' })).getAllByRole('listitem').filter((item) => item.classList.contains('run-match'))[n - 1] as HTMLElement;

describe('the heavy-operation stop of a pattern run', () => {
  it('shows the estimate and both choices, and no card', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionHeavy()) });
    await ran();
    expect(inRun().getByText('Estimated ≥ 500 matches')).toBeTruthy();
    expect(inRun().getByRole('button', { name: 'Refine filters' })).toBeTruthy();
    expect(inRun().getByRole('button', { name: 'Continue with 25' })).toBeTruthy();
    expect(inRun().queryByRole('list', { name: 'Matches' })).toBeNull();
  });

  it('returns to the editor on Refine filters and keeps the choices', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionHeavy()) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Refine filters' }));
    await settle();
    expect(screen.queryByText(/^Estimated/)).toBeNull();
    expect(within(screen.getByRole('region', { name: 'New pattern' })).getByRole('radio', { name: 'Outgoing' }).getAttribute('aria-checked')).toBe('true');
  });

  it('sends one continue run with the same definition and entity, continue and the limit, and shows the page', async () => {
    let call = 0;
    const kit = await runWorkspace({ runDefinition: async () => ok(++call === 1 ? definitionHeavy() : definitionOk(['acc-2'])) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Continue with 25' }));
    await settle();
    expect(kit.definitionRuns).toHaveLength(2);
    expect(kit.definitionRuns[1]?.request).toEqual({ ...kit.definitionRuns[0]?.request, continue: true, limit: 25 });
    expect(screen.queryByText(/^Estimated/)).toBeNull();
    expect(inRun().getByRole('list', { name: 'Matches' })).toBeTruthy();
  });

  it('shows no warning for an ok answer whatever its count quality', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2'], { count: { quality: 'unknown', scope: 'matches' } } as never)) });
    await ran();
    expect(screen.queryByText(/^Estimated/)).toBeNull();
  });
});

describe('reading a result', () => {
  const twoHops = (): PatternRunResponse =>
    definitionOk(['acc-2', 'acc-3'], {
      matches: [
        { match: ref('a', 'n-a', 'acc-2'), hops: 2, through: [ref('a', 'n-b', 'dev-1')], relationships: [{ relationshipType: 'r-1', from: ref('a', 'n-a', 'x-1'), to: ref('a', 'n-b', 'dev-1') }, { relationshipType: 'r-3', from: ref('a', 'n-b', 'dev-1'), to: ref('a', 'n-a', 'acc-2') }] },
        { match: ref('a', 'n-a', 'acc-3'), hops: 2, through: [null], relationships: [{ relationshipType: null, from: null, to: null }, { relationshipType: 'r-3', from: null, to: ref('a', 'n-a', 'acc-3') }] },
      ],
      nodes: [typedNode('x-1', 'n-a'), typedNode('dev-1', 'n-b'), typedNode('acc-2', 'n-a'), typedNode('acc-3', 'n-a')],
    });

  it('draws the path of each match: the relationship of each hop and the entities between, a gap kept, an unusable relationship named', async () => {
    await runWorkspace({ runDefinition: async () => ok(twoHops()) });
    await ran();
    const path = (n: number): string[] => within(within(card(n)).getByRole('list', { name: 'Path' })).getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(path(1)).toEqual(['x-1', '→ r-1 →', 'dev-1', '→ r-3 →', 'acc-2']);
    expect(path(2)).toEqual(['an entity without an ID', '→ a relationship →', 'an entity without an ID', '→ r-3 →', 'acc-3']);
  });

  it.each([
    [{ code: 'stopListSkipped' }, 'stop list was skipped'],
    [{ code: 'noStopList' }, 'no stop list'],
    [{ code: 'undatedExcluded' }, 'without a usable date'],
    [{ code: 'readBounded' }, 'lower bound'],
    [{ code: 'evidenceCut' }, 'Not every shared attribute'],
    [{ code: 'windowNotApplied', relationshipTypes: ['A', 'B'] }, 'The window did not apply to 2 relationship types.'],
    [{ code: 'supernodesSkipped', entities: [ref('a', 'n-b', 'hub-1')] }, '1 supernode was not traversed.'],
  ])('writes the notice %j as a sentence', async (notice, text) => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2'], { notices: [notice] } as never)) });
    await ran();
    expect(inRun().getByText(new RegExp(text.replace('.', '\\.')))).toBeTruthy();
  });

  it('lists the evidence references of the edges, and shows masked titles as the response carries them', async () => {
    const answer = definitionOk(['acc-2']);
    if (answer.status !== 'ok') throw new Error('ok');
    const nodes = answer.nodes.map((node) => (node.ref.stableId === 'acc-2' ? { ...node, display: { ...node.display, title: '••••' } } : node));
    await runWorkspace({ runDefinition: async () => ok({ ...answer, nodes }) });
    await ran();
    await userEvent.click(within(card(1)).getByRole('button', { name: /^Evidence/ }));
    expect(within(card(1)).getByText('REC-0')).toBeTruthy();
    expect(within(card(1)).getByText('••••', { selector: '.run-path-entity' })).toBeTruthy();
  });
});

describe('adding a result to the graph', () => {
  async function ranOnce(answer: PatternRunResponse = definitionOk(['acc-2', 'acc-3'])) {
    const kit = await runWorkspace({ runDefinition: async () => ok(answer) });
    await ran();
    return kit;
  }
  const add = (): HTMLButtonElement => inRun().getByRole('button', { name: /^(Add all|Add these|On the graph)/ }) as HTMLButtonElement;

  it('merges the nodes and edges once, selects the new items, says how many, and reads On the graph afterwards; adding again adds nothing', async () => {
    const kit = await ranOnce();
    const before = kit.state.loadedGraph().nodes.length;
    await userEvent.click(add());
    const added = kit.state.loadedGraph().nodes.length - before;
    expect(added).toBeGreaterThan(0);
    expect(inRun().getByText(/^Added \d+ entities? and \d+ relationships?\./)).toBeTruthy();
    expect(add().textContent).toBe('On the graph');
    expect(add().disabled).toBe(true);
    await userEvent.click(add());
    expect(kit.state.loadedGraph().nodes.length - before).toBe(added);
  });

  it('keeps the result when the merge selects a new entity of the start type', async () => {
    const kit = await ranOnce(definitionOk(['x-9'], { nodes: [typedNode('x-9', 'n-a')], edges: [] } as never));
    await userEvent.click(add());
    await settle();
    expect(kit.state.presentation.view.getState().selection.size).toBe(1);
    expect(add().textContent).toBe('On the graph');
    expect(inRun().getByText(/^Added 1 entity and 0 relationships?\./)).toBeTruthy();
  });

  it('states the cut of a lower-bound result', async () => {
    const kit = await ranOnce(definitionOk(['acc-2'], { count: { value: 25, quality: 'lowerBound', scope: 'matches' } } as never));
    await userEvent.click(add());
    expect(inRun().getByText(/more matches may exist and were not loaded/)).toBeTruthy();
    expect(kit.state.loadedGraph().nodes.length).toBeGreaterThan(2);
  });

  it('adds nothing for a run that was cancelled', async () => {
    const runs: Array<(answer: Run) => void> = [];
    const kit = await runWorkspace({ runDefinition: (_request, _key, signal) => new Promise<Run>((resolve) => { runs.push(resolve); signal?.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'ABORTED' } })); }) });
    await ran();
    const before = kit.state.loadedGraph().nodes.length;
    await userEvent.click(runCancel());
    await settle();
    act(() => runs[0]?.(ok(definitionOk(['acc-9']))));
    await settle();
    expect(kit.state.loadedGraph().nodes).toHaveLength(before);
    expect(panelHeader().title).toBe('Preview pattern');
  });

  it('gives each add its own result key', async () => {
    const kit = await ranOnce();
    await userEvent.click(add());
    await userEvent.click(inRun().getByRole('button', { name: 'Edit pattern' }));
    await toggleType(1, 'r-2');
    expect(kit.state.investigation.getState().resultKeys.length).toBeGreaterThan(0);
    const keys = kit.state.investigation.getState().resultKeys.map((key) => key.params);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((params) => params.includes('definition'))).toBe(true);
  });
});
