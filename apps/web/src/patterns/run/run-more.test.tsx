import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternRunResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { ref } from '../../state/test-data.js';
import { typedNode } from '../../workspace/filters-kit.js';
import { definitionHeavy, definitionOk, settle } from '../patterns-kit.js';
import { builderPanel, cleanup, runButton, runWorkspace, screen, userEvent, validPattern, within } from './run-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Run = ApiResult<PatternRunResponse>;
const press = async (): Promise<void> => {
  await userEvent.click(runButton());
  await settle();
};
const result = (): HTMLElement => screen.getByRole('region', { name: 'Result' });

describe('the heavy-operation stop of a pattern run', () => {
  it('shows the estimate, the threshold, the line and both buttons, and no table', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionHeavy() }) });
    await validPattern();
    await press();
    expect(screen.getByText('Estimated ≥ 500 matches · warning threshold 500')).toBeTruthy();
    expect(screen.getByText('Refine filters or continue with a bounded limit of 25.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refine filters' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue with 25' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('closes on Refine filters, moves the focus to the builder’s first choice and keeps the choices', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionHeavy() }) });
    await validPattern();
    await press();
    await userEvent.click(screen.getByRole('button', { name: 'Refine filters' }));
    expect(screen.queryByText(/Estimated/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Starts at'));
    expect((screen.getByLabelText('Starts at') as HTMLSelectElement).value).toBe('n-a');
  });

  it('sends one continue run with the same definition and entity, continue and the limit, and shows the page', async () => {
    let call = 0;
    const kit = await runWorkspace({ runDefinition: async () => ({ ok: true, value: ++call === 1 ? definitionHeavy() : definitionOk(['acc-2']) }) });
    await validPattern();
    await press();
    await userEvent.click(screen.getByRole('button', { name: 'Continue with 25' }));
    await settle();
    expect(kit.definitionRuns).toHaveLength(2);
    expect(kit.definitionRuns[1]?.request).toEqual({ ...kit.definitionRuns[0]?.request, continue: true, limit: 25 });
    expect(screen.queryByText(/Estimated/)).toBeNull();
    expect(result()).toBeTruthy();
  });

  it('shows no warning for an ok answer whatever its count quality, and takes the stop down when the definition changes', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk(['acc-2'], { count: { quality: 'unknown', scope: 'matches' } } as never) }) });
    await validPattern();
    await press();
    expect(screen.queryByText(/Estimated/)).toBeNull();
    cleanup();
    document.body.replaceChildren();
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionHeavy() }) });
    await validPattern();
    await press();
    await userEvent.click(within(screen.getByRole('group', { name: 'Step 1' })).getByRole('checkbox', { name: 'r-2' }));
    expect(screen.queryByText(/Estimated/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue with 25' })).toBeNull();
  });
});

describe('reading a result', () => {
  const twoHops = (): PatternRunResponse =>
    definitionOk(['acc-2', 'acc-3'], {
      matches: [
        { match: ref('a', 'n-a', 'acc-2'), hops: 2, through: [ref('a', 'n-b', 'dev-1')], relationships: [{ relationshipType: 'r-1', from: ref('a', 'n-a', 'x-1'), to: ref('a', 'n-b', 'dev-1') }, { relationshipType: 'r-3', from: ref('a', 'n-b', 'dev-1'), to: ref('a', 'n-a', 'acc-2') }] },
        { match: ref('a', 'n-a', 'acc-3'), hops: 2, through: [null], relationships: [{ relationshipType: null, from: null, to: null }, { relationshipType: 'r-3', from: null, to: ref('a', 'n-a', 'acc-3') }] },
      ],
      nodes: [typedNode('dev-1', 'n-b'), typedNode('acc-2', 'n-a'), typedNode('acc-3', 'n-a')],
    });

  it('draws the path of each match: the relationship of each hop and the entities between, a gap kept, an unusable relationship named', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: twoHops() }) });
    await validPattern();
    await press();
    const rows = within(result()).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toBe('acc-2r-1 → dev-1 → r-3');
    expect(rows[1]?.textContent).toBe('acc-3a relationship → an entity without an ID → r-3');
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
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk(['acc-2'], { notices: [notice] } as never) }) });
    await validPattern();
    await press();
    expect(within(result()).getByText(new RegExp(text.replace('.', '\\.')))).toBeTruthy();
  });

  it('lists the evidence references of the edges, and shows masked titles as the response carries them', async () => {
    const answer = definitionOk(['acc-2']);
    if (answer.status !== 'ok') throw new Error('ok');
    const nodes = answer.nodes.map((node) => (node.ref.stableId === 'acc-2' ? { ...node, display: { ...node.display, title: '••••' } } : node));
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: { ...answer, nodes } }) });
    await validPattern();
    await press();
    expect(within(result()).getByText('REC-0')).toBeTruthy();
    expect(within(within(result()).getByRole('table')).getByText('••••')).toBeTruthy();
  });
});

describe('adding a result to the graph', () => {
  async function ranOnce(answer: PatternRunResponse = definitionOk(['acc-2', 'acc-3'])) {
    const kit = await runWorkspace({ runDefinition: async () => ({ ok: true, value: answer }) });
    await validPattern();
    await press();
    return kit;
  }
  const add = (): HTMLButtonElement => within(result()).getByRole('button', { name: /Add to graph|On canvas/ }) as HTMLButtonElement;

  it('merges the nodes and edges once, selects the new items, says how many, and reads On canvas afterwards; adding again adds nothing', async () => {
    const kit = await ranOnce();
    const before = kit.state.loadedGraph().nodes.length;
    await userEvent.click(add());
    const added = kit.state.loadedGraph().nodes.length - before;
    expect(added).toBeGreaterThan(0);
    expect(within(result()).getByText(/^Added \d+ entities? and \d+ relationships?\./)).toBeTruthy();
    expect(add().textContent).toBe('On canvas');
    expect(add().disabled).toBe(true);
    await userEvent.click(add());
    expect(kit.state.loadedGraph().nodes.length - before).toBe(added);
  });

  it('keeps the result and the starting entity when the merge selects a new entity of the start type', async () => {
    const kit = await ranOnce(definitionOk(['x-9'], { nodes: [typedNode('x-9', 'n-a')], edges: [] } as never));
    await userEvent.click(add());
    await settle();
    expect(kit.state.presentation.view.getState().selection.size).toBe(1);
    expect(add().textContent).toBe('On canvas');
    expect(within(result()).getByText(/^Added 1 entity and 0 relationships?\./)).toBeTruthy();
    expect((screen.getByLabelText('Starts from') as HTMLSelectElement).selectedOptions[0]?.textContent).not.toContain('x-9');
  });

  it('states the cut of a lower-bound result', async () => {
    const kit = await ranOnce(definitionOk(['acc-2'], { count: { value: 25, quality: 'lowerBound', scope: 'matches' } } as never));
    await userEvent.click(add());
    expect(within(result()).getByText(/more matches may exist and were not loaded/)).toBeTruthy();
    expect(kit.state.loadedGraph().nodes.length).toBeGreaterThan(2);
  });

  it('is disabled while a run runs, and a cancelled run adds nothing', async () => {
    const runs: Array<(answer: Run) => void> = [];
    let first = true;
    const kit = await runWorkspace({ runDefinition: (_request, _key, signal) => (first ? ((first = false), Promise.resolve<Run>({ ok: true, value: definitionOk(['acc-2']) })) : new Promise<Run>((resolve) => { runs.push(resolve); signal?.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'ABORTED' } })); })) });
    await validPattern();
    await press();
    await press();
    expect(add().disabled).toBe(true);
    const before = kit.state.loadedGraph().nodes.length;
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    act(() => runs[0]?.({ ok: true, value: definitionOk(['acc-9']) }));
    await settle();
    expect(kit.state.loadedGraph().nodes).toHaveLength(before);
  });

  it('gives each add its own result key', async () => {
    const kit = await ranOnce();
    await userEvent.click(add());
    const first = kit.state.investigation.getState().resultKeys.length;
    await userEvent.click(within(builderPanel()).getByRole('button', { name: 'Run pattern' }));
    await settle();
    await userEvent.click(add());
    const keys = kit.state.investigation.getState().resultKeys.map((key) => key.params);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((params) => params.includes('definition'))).toBe(true);
    expect(first).toBeGreaterThan(0);
  });
});
