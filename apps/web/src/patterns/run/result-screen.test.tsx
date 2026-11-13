import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode, PatternRunOk, PatternRunResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { ref } from '../../state/test-data.js';
import { typedNode } from '../../workspace/filters-kit.js';
import { assertNoCodes } from '../no-codes.js';
import { definitionHeavy, definitionOk, failure, settle } from '../patterns-kit.js';
import { cleanup, inRun, screen, panelHeader, previewedSaved, ran, runButton, runWorkspace, startCombo, userEvent, within } from './run-kit.js';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-11-13T09:46:30.000Z'));
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Run = ApiResult<PatternRunResponse>;
const ok = (value: PatternRunResponse): Run => ({ ok: true, value });
const matchCard = (n: number): HTMLElement => within(inRun().getByRole('list', { name: 'Matches' })).getAllByRole('listitem').filter((item) => item.classList.contains('run-match'))[n - 1] as HTMLElement;
const addAllButton = (): HTMLButtonElement => inRun().getByRole('button', { name: /^(Add all|Add these|On the graph)/ }) as HTMLButtonElement;
const withNodeProperties = (answer: PatternRunResponse, id: string, properties: GraphNode['properties']): PatternRunResponse => {
  if (answer.status !== 'ok') throw new Error('ok');
  return { ...answer, nodes: answer.nodes.map((node) => (node.ref.stableId === id ? { ...node, properties } : node)) };
};

describe('an exact result', () => {
  it('says "n matches · Exact" with the time of the answer, offers Add all n, Edit pattern and Save…, and numbers the list', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2', 'acc-3'])) });
    await ran();
    expect(panelHeader()).toEqual({ title: 'Pattern result', subtitle: 'Draft · from x-1' });
    const here = inRun();
    expect(here.getByText('2 matches')).toBeTruthy();
    expect(here.getByText('Exact')).toBeTruthy();
    expect(here.getByText('Counted by the source. Run at 09:46 UTC.')).toBeTruthy();
    expect(document.activeElement?.classList.contains('run-summary')).toBe(true);
    expect(here.getByRole('button', { name: 'Add all 2 to graph' })).toBeTruthy();
    expect(here.getByRole('button', { name: 'Edit pattern' })).toBeTruthy();
    expect(here.getByRole('button', { name: 'Save…' })).toBeTruthy();
    expect(here.getByText('Matches · showing 1 to 2 of 2')).toBeTruthy();
    expect(here.queryByRole('button', { name: 'Next' })).toBeNull();
    assertNoCodes(document.body.textContent ?? '', 'the result');
  });

  it('names the saved pattern and where it started in the header', async () => {
    await previewedSaved({ runDefinition: async () => ok(definitionOk(['acc-2'])) });
    await userEvent.click(runButton());
    await settle();
    expect(panelHeader()).toEqual({ title: 'Pattern result', subtitle: 'Alpha · from x-1' });
  });

  it('returns to the editor with the same draft on Edit pattern', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2'])) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Edit pattern' }));
    await settle();
    expect(panelHeader().title).toBe('New pattern');
    expect(screen.getByRole('tab', { name: /^Step 1/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens the Save pattern dialog from Save…', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2'])) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Save…' }));
    expect(within(document.querySelector('[role="dialog"]') as HTMLElement).getByLabelText('Name')).toBeTruthy();
  });
});

describe('a match', () => {
  const twoHops = (): PatternRunResponse => {
    const base = definitionOk(['acc-2', 'acc-3']);
    if (base.status !== 'ok') throw new Error('ok');
    const mid = typedNode('mid-1', 'kind-b');
    return withNodeProperties(
      {
        ...base,
        nodes: [...base.nodes, mid],
        matches: [
          { match: ref('a', 'kind-a', 'acc-2'), hops: 2, through: [ref('a', 'kind-b', 'mid-1')], relationships: [{ relationshipType: 'r-1', from: ref('a', 'kind-a', 'acc-1'), to: ref('a', 'kind-b', 'mid-1') }, { relationshipType: 'r-3', from: ref('a', 'kind-b', 'mid-1'), to: ref('a', 'kind-a', 'acc-2') }] },
          { match: ref('a', 'kind-a', 'acc-3'), hops: 2, through: [null], relationships: [{ relationshipType: null, from: null, to: null }, { relationshipType: 'r-3', from: null, to: ref('a', 'kind-a', 'acc-3') }] },
        ],
        edges: [],
      },
      'acc-2',
      [
        { key: 'p-1', value: 'v-1', dataClass: 'text', masked: false },
        { key: 'p-2', value: 'secret@example.test', dataClass: 'email', masked: false },
        { key: 'p-3', value: 'hidden', dataClass: 'text', masked: true },
        { key: 'p-4', value: 12, dataClass: 'number', masked: false },
      ],
    );
  };

  it('draws "Match k" and the path as chips, a gap kept where an entity has no usable ID and an unusable relationship named', async () => {
    await runWorkspace({ runDefinition: async () => ok(twoHops()) });
    await ran();
    expect(within(matchCard(1)).getByText('Match 1')).toBeTruthy();
    const first = within(within(matchCard(1)).getByRole('list', { name: 'Path' })).getAllByRole('listitem').map((item) => item.textContent);
    expect(first).toEqual(['acc-1', '→ r-1 →', 'mid-1', '→ r-3 →', 'acc-2']);
    const second = within(within(matchCard(2)).getByRole('list', { name: 'Path' })).getAllByRole('listitem').map((item) => item.textContent);
    expect(second).toEqual(['an entity without an ID', '→ a relationship →', 'an entity without an ID', '→ r-3 →', 'acc-3']);
  });

  it('shows the lines the answer carries, and the value of a personal-data property only while masking is off', async () => {
    const kit = await runWorkspace({ runDefinition: async () => ok(twoHops()) });
    await ran();
    expect(within(matchCard(1)).getByText('acc-2: p-1 is v-1')).toBeTruthy();
    expect(within(matchCard(1)).getByText('acc-2: p-2 is secret@example.test')).toBeTruthy();
    expect(within(matchCard(1)).getByText('acc-2: p-4 is 12')).toBeTruthy();
    expect(within(matchCard(1)).queryByText(/hidden/)).toBeNull();
    cleanup();
    document.body.replaceChildren();
    const masked = await runWorkspace({ runDefinition: async () => ok(twoHops()) });
    act(() => masked.state.setMask(true));
    await settle();
    const { openBuilder } = await import('./run-kit.js');
    await openBuilder();
    await ran();
    expect(within(matchCard(1)).getByText('acc-2: p-1 is v-1')).toBeTruthy();
    expect(within(matchCard(1)).queryByText(/secret@example\.test/)).toBeNull();
    expect(kit).toBeTruthy();
  });

  it('opens the evidence references of its relationships on Evidence', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2'])) });
    await ran();
    expect(within(matchCard(1)).queryByText('REC-0')).toBeNull();
    const toggle = within(matchCard(1)).getByRole('button', { name: /^Evidence/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(matchCard(1)).getByText('REC-0')).toBeTruthy();
    expect(within(matchCard(1)).getByText('r-1', { selector: '.run-mono' })).toBeTruthy();
  });

  it('shows masked titles as the answer carries them', async () => {
    const answer = definitionOk(['acc-2']);
    if (answer.status !== 'ok') throw new Error('ok');
    const nodes = answer.nodes.map((node) => (node.ref.stableId === 'acc-2' ? { ...node, display: { ...node.display, title: '••••' } } : node));
    await runWorkspace({ runDefinition: async () => ok({ ...answer, nodes }) });
    await ran();
    expect(within(matchCard(1)).getByText('••••')).toBeTruthy();
  });

  it('outlines the entities of the matches that are on the canvas', async () => {
    const kit = await runWorkspace({ runDefinition: async () => ok(definitionOk(['x-2'])), nodes: [typedNode('x-1', 'n-a'), typedNode('x-2', 'n-a'), typedNode('acc-1', 'kind-a')], opened: { entityType: 'n-a', stableId: 'x-1' } });
    await ran();
    expect(kit.state.presentation.view.getState().selection.size).toBeGreaterThan(0);
  });

  it('writes the notices of the run as sentences', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2'], { notices: [{ code: 'readBounded' }, { code: 'windowNotApplied', relationshipTypes: ['A', 'B'] }] } as never)) });
    await ran();
    expect(inRun().getByText('The read was cut, so the count is a lower bound.')).toBeTruthy();
    expect(inRun().getByText('The window did not apply to 2 relationship types.')).toBeTruthy();
  });
});

describe('masking and the personal-data list of the mapping', () => {
  it('leaves out every property the mapping lists as personal data while masking is on, whatever its class', async () => {
    const answer = definitionOk(['acc-2']);
    if (answer.status !== 'ok') throw new Error('ok');
    const properties: GraphNode['properties'] = [
      { key: 'p-date', value: '1990-01-01', dataClass: 'date', masked: false },
      { key: 'p-plain', value: 'v', dataClass: 'text', masked: false },
    ];
    const listedAnswer: PatternRunResponse = {
      ...answer,
      matches: answer.matches.map((entry) => ({ ...entry, match: ref('a', 'n-a', 'acc-2') })),
      nodes: [typedNode('acc-1', 'kind-a'), { ...typedNode('acc-2', 'n-a'), properties }],
    };
    const profile = async () => {
      const { builderProfile } = await import('./run-kit.js');
      const base = builderProfile();
      return { ok: true as const, value: { ...base, entityTypes: base.entityTypes.map((type) => (type.type === 'n-a' ? { ...type, pii: ['p-date'] } : type)) } };
    };
    const kit = await runWorkspace({ profile, runDefinition: async () => ok(listedAnswer) });
    await ran();
    expect(within(matchCard(1)).getByText('acc-2: p-date is 1990-01-01')).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    const masked = await runWorkspace({ profile, runDefinition: async () => ok(listedAnswer) });
    act(() => masked.state.setMask(true));
    await settle();
    const { openBuilder } = await import('./run-kit.js');
    await openBuilder();
    await ran();
    expect(within(matchCard(1)).queryByText(/p-date/)).toBeNull();
    expect(within(matchCard(1)).getByText('acc-2: p-plain is v')).toBeTruthy();
    expect(kit).toBeTruthy();
  });
});

describe('a lower-bound result', () => {
  const continued = (): Run => ok(definitionOk(['acc-2', 'acc-3'], { count: { value: 500, quality: 'lowerBound', scope: 'matches' } } as never));

  it('says "At least n matches · Lower bound", how many are shown, and offers Add these n', async () => {
    let call = 0;
    await runWorkspace({ runDefinition: async () => (++call === 1 ? ok(definitionHeavy()) : continued()) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Continue with 25' }));
    await settle();
    const here = inRun();
    expect(here.getByText('At least 500 matches')).toBeTruthy();
    expect(here.getByText('Lower bound')).toBeTruthy();
    expect(here.getByText('Showing the first 2. The real number may be higher; it is not known.')).toBeTruthy();
    expect(here.getByText('Matches · showing 1 to 2 of at least 500')).toBeTruthy();
    expect(here.getByRole('button', { name: 'Add these 2 to graph' })).toBeTruthy();
  });

  it('gives no number for a count that is not known', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2'], { count: { quality: 'unknown', scope: 'matches' } } as never)) });
    await ran();
    expect(inRun().getByText('The number of matches is not known')).toBeTruthy();
    expect(inRun().getByText('Matches · showing 1 to 1')).toBeTruthy();
  });

  it('labels an estimate as one', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2'], { count: { value: 40, quality: 'estimated', scope: 'matches' } } as never)) });
    await ran();
    expect(inRun().getByText('About 40 matches')).toBeTruthy();
    expect(inRun().getByText('Estimated')).toBeTruthy();
  });
});

describe('a result of no match', () => {
  it('says so with the start, Edit pattern and Run from another type, and draws no card', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk([])) });
    await ran();
    const here = inRun();
    expect(here.getByText('0 matches')).toBeTruthy();
    expect(here.getByText('Exact')).toBeTruthy();
    expect(here.getByText('Nothing in this source follows this pattern from x-1. Try fewer conditions or a longer date window.')).toBeTruthy();
    expect(here.getByRole('button', { name: 'Edit pattern' })).toBeTruthy();
    expect(here.queryByRole('button', { name: /^Add/ })).toBeNull();
    expect(here.queryByRole('list', { name: 'Matches' })).toBeNull();
    await userEvent.click(here.getByRole('button', { name: 'Run from another N-A' }));
    await settle();
    expect(panelHeader().title).toBe('Preview pattern');
    expect(startCombo()).toBeTruthy();
    expect(runButton().disabled).toBe(true);
  });
});

describe('adding to the graph', () => {
  it('merges one match, says "On the graph" on its card, and adding again adds nothing', async () => {
    const kit = await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2', 'acc-3'])) });
    await ran();
    const before = kit.state.loadedGraph().nodes.length;
    const edges = kit.state.loadedGraph().edges.length;
    await userEvent.click(within(matchCard(1)).getByRole('button', { name: /^Add to graph/ }));
    const after = kit.state.loadedGraph().nodes.length;
    expect(after).toBeGreaterThan(before);
    expect(kit.state.loadedGraph().edges.length).toBe(edges + 1);
    expect(within(matchCard(1)).getByText('On the graph')).toBeTruthy();
    expect(within(matchCard(1)).queryByRole('button', { name: /^Add to graph/ })).toBeNull();
    expect(within(matchCard(2)).queryByText('On the graph')).toBeNull();
    expect(inRun().getByText(/^Added \d+ entit/)).toBeTruthy();
  });

  it('adds all of the page, reads On the graph afterwards, and a second press adds nothing', async () => {
    const kit = await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2', 'acc-3'])) });
    await ran();
    await userEvent.click(addAllButton());
    const added = kit.state.loadedGraph().nodes.length;
    expect(addAllButton().textContent).toBe('On the graph');
    expect(addAllButton().disabled).toBe(true);
    expect(within(matchCard(1)).getByText('On the graph')).toBeTruthy();
    expect(within(matchCard(2)).getByText('On the graph')).toBeTruthy();
    await userEvent.click(addAllButton());
    expect(kit.state.loadedGraph().nodes).toHaveLength(added);
  });

  it('adds only what is left after one match was added', async () => {
    const kit = await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2', 'acc-3'])) });
    await ran();
    await userEvent.click(within(matchCard(1)).getByRole('button', { name: /^Add to graph/ }));
    const one = kit.state.loadedGraph().nodes.length;
    await userEvent.click(addAllButton());
    expect(kit.state.loadedGraph().nodes.length).toBe(one + 1);
  });

  it('states the cut of a lower-bound result when it is added', async () => {
    await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2'], { count: { value: 25, quality: 'lowerBound', scope: 'matches' } } as never)) });
    await ran();
    await userEvent.click(addAllButton());
    expect(inRun().getByText(/more matches may exist and were not loaded/)).toBeTruthy();
  });

  it('disables Add to graph when the source changed under the investigation', async () => {
    const kit = await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2'])) });
    await ran();
    const record = kit.state.investigation.getState().record;
    if (record === null) throw new Error('no record');
    act(() => kit.state.describeInvestigation({ ...record, sourceState: 'removed' }));
    await settle();
    const before = kit.state.loadedGraph().nodes.length;
    const actionable = screen.queryAllByRole('button', { name: /^(Add all|Add these|Add to graph)/ }).filter((button) => !(button as HTMLButtonElement).disabled);
    for (const button of actionable) await userEvent.click(button);
    expect(kit.state.loadedGraph().nodes).toHaveLength(before);
  });

  it('gives each add its own result key', async () => {
    const kit = await runWorkspace({ runDefinition: async () => ok(definitionOk(['acc-2', 'acc-3'])) });
    await ran();
    await userEvent.click(within(matchCard(1)).getByRole('button', { name: /^Add to graph/ }));
    await userEvent.click(addAllButton());
    const keys = kit.state.investigation.getState().resultKeys.map((key) => key.params);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((params) => params.includes('definition'))).toBe(true);
  });
});

describe('pages of a result', () => {
  const page = (ids: readonly string[], nextCursor?: string): PatternRunOk => {
    const answer = definitionOk(ids, { count: { value: ids.length, quality: 'lowerBound', scope: 'matches' }, ...(nextCursor === undefined ? {} : { nextCursor }) } as never);
    if (answer.status !== 'ok') throw new Error('ok');
    return answer;
  };
  const scripted = (answers: readonly Run[]) => {
    let call = 0;
    return async (): Promise<Run> => answers[Math.min(call++, answers.length - 1)] as Run;
  };
  const next = (): HTMLButtonElement => inRun().getByRole('button', { name: /^Next/ }) as HTMLButtonElement;
  const previous = (): HTMLButtonElement => inRun().getByRole('button', { name: /^Previous/ }) as HTMLButtonElement;

  it('reads the next page with the cursor of the answer, words it "at least" and keeps the pages for Previous', async () => {
    const kit = await runWorkspace({ runDefinition: scripted([ok(page(['acc-2', 'acc-3'], 'cur-1')), ok(page(['acc-4'], 'cur-2')), ok(page(['acc-5']))]) });
    await ran();
    expect(previous().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    await userEvent.click(next());
    await settle();
    expect(kit.definitionRuns).toHaveLength(2);
    expect(kit.definitionRuns[1]?.request).toEqual({ ...kit.definitionRuns[0]?.request, cursor: 'cur-1' });
    expect(inRun().getByText('At least 3 matches')).toBeTruthy();
    expect(inRun().getByText('Matches · showing 3 to 3 of at least 3')).toBeTruthy();
    expect(inRun().getByText('Showing 3 to 3. The real number may be higher; it is not known.')).toBeTruthy();
    expect(within(matchCard(1)).getByText('Match 3')).toBeTruthy();
    await userEvent.click(previous());
    await settle();
    expect(kit.definitionRuns).toHaveLength(2);
    expect(inRun().getByText('Matches · showing 1 to 2 of at least 500'.replace('500', '2'))).toBeTruthy();
    expect(previous().disabled).toBe(true);
    await userEvent.click(next());
    await settle();
    expect(kit.definitionRuns).toHaveLength(2);
    expect(within(matchCard(1)).getByText('Match 3')).toBeTruthy();
    await userEvent.click(next());
    await settle();
    expect(kit.definitionRuns).toHaveLength(3);
    expect(kit.definitionRuns[2]?.request).toMatchObject({ cursor: 'cur-2' });
    expect(next().disabled).toBe(true);
  });

  it('keeps the page on screen when the cursor is no longer valid, says so in words and offers a new run', async () => {
    const kit = await runWorkspace({ runDefinition: scripted([ok(page(['acc-2'], 'cur-1')), { ok: false, failure: failure('CURSOR_INVALIDATED') }, ok(page(['acc-6']))]) });
    await ran();
    await userEvent.click(next());
    await settle();
    expect(within(matchCard(1)).getByText('Match 1')).toBeTruthy();
    expect(inRun().getByText('This list is out of date. Start it again.')).toBeTruthy();
    assertNoCodes(document.body.textContent ?? '', 'the invalidated page');
    await userEvent.click(inRun().getByRole('button', { name: 'Run again' }));
    await settle();
    expect(kit.definitionRuns).toHaveLength(3);
    expect(kit.definitionRuns[2]?.request).not.toHaveProperty('cursor');
    expect(inRun().queryByText(/out of date/)).toBeNull();
  });

  it('goes back to page 1 after a continued heavy run without asking again, and asks the next page as a continued run', async () => {
    const kit = await runWorkspace({ runDefinition: scripted([ok(definitionHeavy()), ok(page(['acc-2', 'acc-3'], 'cur-1')), ok(page(['acc-4']))]) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Continue with 25' }));
    await settle();
    await userEvent.click(next());
    await settle();
    expect(kit.definitionRuns[2]?.request).toMatchObject({ continue: true, limit: 25, cursor: 'cur-1' });
    await userEvent.click(previous());
    await settle();
    expect(kit.definitionRuns).toHaveLength(3);
    expect(within(matchCard(1)).getByText('Match 1')).toBeTruthy();
    expect(inRun().queryByText(/Estimated/)).toBeNull();
  });

  it('shows the failure of a page read with Try again and keeps the page', async () => {
    let call = 0;
    const kit = await runWorkspace({ runDefinition: async () => (++call === 1 ? ok(page(['acc-2'], 'cur-1')) : call === 2 ? { ok: false, failure: failure('SOURCE_BUSY') } : ok(page(['acc-7']))) });
    await ran();
    await userEvent.click(next());
    await settle();
    expect(inRun().getByText(/is busy/)).toBeTruthy();
    expect(within(matchCard(1)).getByText('Match 1')).toBeTruthy();
    await userEvent.click(inRun().getByRole('button', { name: 'Try again' }));
    await settle();
    expect(kit.definitionRuns[2]?.request).toMatchObject({ cursor: 'cur-1' });
    expect(within(matchCard(1)).getByText('Match 2')).toBeTruthy();
  });

  it('cancels the read of the next page on Escape, keeps the page on screen and does not close the panel', async () => {
    const runs: Array<{ signal: AbortSignal | undefined }> = [];
    let call = 0;
    await runWorkspace({
      runDefinition: (_request, _key, signal) => {
        if (++call === 1) return Promise.resolve(ok(page(['acc-2'], 'cur-1')));
        runs.push({ signal });
        return new Promise<Run>((resolve) => signal?.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'ABORTED' } })));
      },
    });
    await ran();
    await userEvent.click(next());
    await settle();
    await userEvent.keyboard('{Escape}');
    await settle();
    expect(runs[0]?.signal?.aborted).toBe(true);
    expect(within(matchCard(1)).getByText('Match 1')).toBeTruthy();
    expect(inRun().queryByText(/Cancelled/)).toBeNull();
    expect(next().disabled).toBe(false);
    expect(panelHeader().title).toBe('Pattern result');
  });

  it('keeps both buttons inert, and the focus on Next, while the next page is read', async () => {
    const runs: Array<(answer: Run) => void> = [];
    let call = 0;
    await runWorkspace({ runDefinition: () => (++call === 1 ? Promise.resolve(ok(page(['acc-2'], 'cur-1'))) : new Promise<Run>((resolve) => runs.push(resolve))) });
    await ran();
    await userEvent.click(next());
    await settle();
    expect(next().getAttribute('aria-disabled')).toBe('true');
    expect(previous().getAttribute('aria-disabled')).toBe('true');
    expect(inRun().getByText('Reading the next page…')).toBeTruthy();
    act(() => runs[0]?.(ok(page(['acc-8']))));
    await settle();
    expect(previous().disabled).toBe(false);
  });
});
