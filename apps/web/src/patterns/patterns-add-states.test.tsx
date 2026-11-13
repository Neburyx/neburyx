import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphEdge } from '@neburyx/contracts';
import { aggregateEdge } from '../inspector/relationship-kit.js';
import { elementKey } from '../state/keys.js';
import { ref } from '../state/test-data.js';
import { heavyRun, okRun, openPatterns, patternsWorkspace, selectAccount, settle, type KitOptions, type Sent } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const runButton = (): HTMLElement => screen.getByRole('button', { name: 'Run pattern' });
const add = (): Promise<void> => userEvent.click(screen.getByRole('button', { name: 'Add to graph' })).then(settle);
const ids = (kit: Awaited<ReturnType<typeof patternsWorkspace>>): string[] => kit.state.loadedGraph().nodes.map((node) => node.ref.stableId).sort();

async function start(run: (sent: Sent, call: number) => ReturnType<NonNullable<KitOptions['run']>>) {
  let call = 0;
  const kit = await patternsWorkspace({ run: (sent) => run(sent, ++call) });
  await openPatterns();
  selectAccount(kit.state, 'acc-1');
  return kit;
}

describe('adding when later runs came after the result', () => {
  it('offers the retained result under a cancelled run and adds it, and the cancelled run adds nothing', async () => {
    const kit = await start(async (sent, call) => {
      if (call === 1) return { ok: true, value: okRun(['acc-2', 'acc-3']) };
      return new Promise<never>(() => void sent);
    });
    await userEvent.click(runButton());
    await settle();
    await userEvent.click(runButton());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    await add();
    expect(ids(kit)).toEqual(['acc-1', 'acc-2', 'acc-3', 'dev-1']);
  });

  it('offers the retained result after a heavy stop', async () => {
    const kit = await start(async (_sent, call) => ({ ok: true, value: call === 1 ? okRun(['acc-2', 'acc-3']) : heavyRun() }));
    await userEvent.click(runButton());
    await settle();
    await userEvent.click(runButton());
    await settle();
    await add();
    expect(ids(kit)).toContain('acc-3');
  });

  it('adds only the newest result when an older answer arrives late', async () => {
    let releaseFirst: () => void = () => undefined;
    const kit = await start(async (_sent, call) => {
      if (call === 1) {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        return { ok: true, value: okRun(['acc-2', 'acc-8']) };
      }
      return { ok: true, value: okRun(['acc-2', 'acc-3']) };
    });
    await userEvent.click(runButton());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(runButton());
    await settle();
    releaseFirst();
    await settle();
    await add();
    expect(ids(kit)).toEqual(['acc-1', 'acc-2', 'acc-3', 'dev-1']);
  });
});

describe('the control follows what the investigation holds', () => {
  it('reads On canvas before any click when everything is held, and is offered again once some of it is removed', async () => {
    const kit = await start(async () => ({ ok: true, value: okRun(['acc-2', 'acc-3']) }));
    await userEvent.click(runButton());
    await settle();
    await add();
    expect(screen.getByRole('button', { name: 'On canvas' })).toBeTruthy();
    const held = kit.state.investigation.getState();
    act(() => kit.state.setLoaded(held.resultKeys, held.nodeRefs.filter((node) => node.stableId !== 'acc-3'), held.edgeRefs.slice(0, 1)));
    await settle();
    expect(screen.getByRole('button', { name: 'Add to graph' })).toBeTruthy();
  });
});

describe('what the outcome and the canvas show', () => {
  it('counts what is new and what was held for five matches of which two were held, and keeps the run count as the run stated it', async () => {
    const kit = await start(async () => ({ ok: true, value: okRun(['acc-2', 'acc-3', 'acc-4', 'acc-5', 'acc-6']) }));
    await userEvent.click(runButton());
    await settle();
    await add();
    expect(screen.getByText('Added 4 entities and 5 relationships. 3 entities already loaded.')).toBeTruthy();
    expect(screen.getByText('5 · exact')).toBeTruthy();
    expect(ids(kit)).toHaveLength(7);
  });

  it('says an unknown count may hide more matches', async () => {
    await start(async () => ({ ok: true, value: okRun(['acc-3'], { count: { quality: 'unknown', scope: 'matches' } }) }));
    await userEvent.click(runButton());
    await settle();
    await add();
    expect(screen.getByText(/The run gave no count: more matches may exist and were not loaded/)).toBeTruthy();
  });

  it('keeps a held entity hidden and loads a new entity of a type a filter switched off without drawing it', async () => {
    const kit = await start(async () => ({ ok: true, value: okRun(['acc-2', 'acc-3']) }));
    act(() => kit.state.hide([elementKey(ref('a', 'kind-a', 'acc-2'))]));
    act(() => kit.state.setEntityTypeOff('kind-b', true));
    await userEvent.click(runButton());
    await settle();
    await add();
    expect(ids(kit)).toContain('acc-3');
    expect(kit.state.presentation.view.getState().hidden.has(elementKey(ref('a', 'kind-a', 'acc-2')))).toBe(true);
    const drawn = kit.state.visibleGraph().nodes.map((node) => node.ref.stableId);
    expect(drawn).not.toContain('dev-1');
    expect(drawn).not.toContain('acc-2');
  });

  it('loads an aggregate relationship of a result once however often it is added', async () => {
    const summed: GraphEdge = aggregateEdge('acc-2', 'acc-3', { value: 3, quality: 'lowerBound', scope: 'x' }, 'PAYS');
    const base = okRun(['acc-2', 'acc-3']);
    if (base.status !== 'ok') throw new Error('not ok');
    const kit = await start(async () => ({ ok: true, value: { ...base, edges: [...base.edges, summed] } }));
    await userEvent.click(runButton());
    await settle();
    await add();
    expect(kit.state.investigation.getState().edgeRefs).toHaveLength(3);
  });

  it('says how many supernodes were not traversed and loads the rest', async () => {
    const kit = await start(async () => ({ ok: true, value: okRun(['acc-3'], { notices: [{ code: 'supernodesSkipped', entities: [ref('a', 'kind-a', 'acc-7')] }] }) }));
    await userEvent.click(runButton());
    await settle();
    expect(screen.getByText('1 supernode was not traversed.')).toBeTruthy();
    await add();
    expect(ids(kit)).toContain('acc-3');
  });

  it('tells a screen reader how many of the new entities lie outside the neighborhood focus', async () => {
    const kit = await start(async () => ({ ok: true, value: okRun(['acc-2', 'acc-3']) }));
    await userEvent.click(runButton());
    await settle();
    act(() => kit.state.focusOn(elementKey(ref('a', 'kind-a', 'acc-1'))));
    await add();
    expect(kit.state.presentation.view.getState().moveNote?.text).toMatch(/outside focus\.$/);
  });

  it('adds the entity in between of a linked result and one node for an entity reached at both hops', async () => {
    const link = (id: string, hops: 1 | 2, through?: string) => ({ match: ref('a', 'kind-a', id), hops, ...(through === undefined ? {} : { through: ref('a', 'kind-a', through) }) });
    const base = okRun(['acc-2', 'acc-3']);
    if (base.status !== 'ok') throw new Error('not ok');
    const kit = await start(async () => ({ ok: true, value: { ...base, templateId: 'linked-entities', presetId: 'connected-accounts', links: [link('acc-2', 1), link('acc-3', 2, 'acc-2'), link('acc-2', 2, 'acc-3')] } }));
    await userEvent.click(screen.getByRole('radio', { name: 'Connected accounts' }));
    await userEvent.click(runButton());
    await settle();
    await add();
    const loaded = kit.state.loadedGraph().nodes.map((node) => node.ref.stableId);
    expect(loaded.filter((id) => id === 'acc-2')).toHaveLength(1);
    expect(loaded).toContain('acc-3');
    const drawn = new Set(kit.state.visibleGraph().nodes.map((node) => node.ref.stableId));
    expect(kit.state.loadedGraph().edges.every((edge) => 'from' in edge && drawn.has(edge.from.stableId) && drawn.has(edge.to.stableId))).toBe(true);
  });
});
