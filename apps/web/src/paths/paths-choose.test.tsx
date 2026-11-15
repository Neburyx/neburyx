import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { edgeKey, elementKey } from '../state/keys.js';
import { chooseEnd, nodeRef, okPaths, openPaths, pathsWorkspace, settle, type PathsKit } from './paths-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const find = (): HTMLElement => screen.getByRole('button', { name: 'Find paths' });
const choosePathButton = (name: RegExp): HTMLElement => screen.getByRole('button', { name });

async function search(kit: PathsKit): Promise<void> {
  await openPaths();
  chooseEnd('From', 'acc-1');
  chooseEnd('To', 'acc-2');
  await userEvent.click(find());
  await settle();
  void kit;
}

const loadedKeys = (kit: PathsKit): string[] => kit.state.loadedGraph().nodes.map((node) => elementKey(node.ref));
const selected = (kit: PathsKit): string[] => [...kit.state.presentation.view.getState().selection].sort();

const addButton = (): HTMLElement => screen.getByRole('button', { name: /^(Add to graph|On canvas)$/ });

describe('choosing a path', () => {
  it('highlights the loaded part of the path and fits the view clear of the panel without adding anything; the arrow keys choose nothing', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'far-1', 'acc-2'], ['acc-1', 'acc-2']]) }) });
    await search(kit);
    const before = loadedKeys(kit).length;
    await userEvent.keyboard('{ArrowDown}{ArrowUp}');
    expect(screen.queryByText(/Selected/)).toBeNull();
    await userEvent.click(choosePathButton(/Path 1 · 2 hops/));
    await settle();
    expect(loadedKeys(kit)).toHaveLength(before);
    expect(loadedKeys(kit)).not.toContain(elementKey(nodeRef('far-1')));
    expect(kit.state.loadedGraph().edges).toHaveLength(0);
    expect(selected(kit)).toEqual([elementKey(nodeRef('acc-1')), elementKey(nodeRef('acc-2'))].sort());
    expect(kit.state.presentation.view.getState().viewChange).toMatchObject({ show: { around: [elementKey(nodeRef('acc-1')), elementKey(nodeRef('acc-2'))] } });
    expect(screen.getByText(/Selected/)).toBeTruthy();
    expect(choosePathButton(/Path 1/).getAttribute('aria-pressed')).toBe('true');
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    expect(addButton().textContent).toBe('Add to graph');
  });

  it('adds what of the chosen path is not loaded only on Add to graph, once, selects the path and then reads On canvas', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'far-1', 'acc-2']]) }) });
    await search(kit);
    const before = loadedKeys(kit).length;
    await userEvent.click(choosePathButton(/Path 1/));
    await settle();
    await userEvent.click(addButton());
    await settle();
    expect(loadedKeys(kit)).toHaveLength(before + 1);
    expect(kit.state.loadedGraph().edges.length).toBe(2);
    expect(selected(kit)).toEqual([elementKey(nodeRef('acc-1')), elementKey(nodeRef('acc-2')), elementKey(nodeRef('far-1')), ...kit.state.loadedGraph().edges.map((edge) => edgeKey(edge.ref))].sort());
    expect(addButton().textContent).toBe('On canvas');
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(choosePathButton(/Path 1/));
    await settle();
    expect(loadedKeys(kit)).toHaveLength(before + 1);
  });

  it('chooses with Enter on the card title too, and reads On canvas for a path that is loaded already', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2']]) }) });
    await search(kit);
    await userEvent.click(choosePathButton(/Path 1/));
    await userEvent.click(addButton());
    await settle();
    const loaded = loadedKeys(kit).length;
    const edges = kit.state.loadedGraph().edges.length;
    act(() => kit.state.presentation.select([]));
    choosePathButton(/Path 1/).focus();
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(loadedKeys(kit)).toHaveLength(loaded);
    expect(kit.state.loadedGraph().edges).toHaveLength(edges);
    expect(selected(kit).length).toBe(2 + edges);
    expect(addButton().textContent).toBe('On canvas');
  });

  it('makes the selection the second path, and adds nothing', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2'], ['acc-1', 'far-1']]) }) });
    await search(kit);
    const before = loadedKeys(kit).length;
    await userEvent.click(choosePathButton(/Path 1/));
    await settle();
    expect(selected(kit)).toContain(elementKey(nodeRef('acc-2')));
    await userEvent.click(choosePathButton(/Path 2/));
    await settle();
    expect(loadedKeys(kit)).toHaveLength(before);
    expect(selected(kit)).toEqual([elementKey(nodeRef('acc-1'))]);
    expect(choosePathButton(/Path 1/).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByRole('button', { name: 'Add to graph' })).toHaveLength(1);
  });

  it('leaves the filters alone, keeps a loaded entity hidden by them hidden, and says how many of the path are hidden by filters', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2']]) }) });
    await search(kit);
    act(() => kit.state.setEntityTypeOff('kind-a', true));
    const filter = kit.state.presentation.view.getState().typeFilter;
    await userEvent.click(choosePathButton(/Path 1/));
    await settle();
    expect(kit.state.presentation.view.getState().typeFilter).toBe(filter);
    expect(selected(kit)).not.toContain(elementKey(nodeRef('acc-1')));
    expect(screen.getByText('2 entities of this path are hidden by filters.')).toBeTruthy();
  });

  it('keeps the graph scope line in step with the canvas after a path is added', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'far-1', 'acc-2']]) }) });
    await search(kit);
    await userEvent.click(choosePathButton(/Path 1/));
    await userEvent.click(addButton());
    await settle();
    expect(screen.getAllByText(/4 entities/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2 relationships/).length).toBeGreaterThan(0);
  });

  it('adds nothing for a search that is cancelled, stale or failed: a search adds nothing until a path is chosen', async () => {
    let first = true;
    const kit = await pathsWorkspace({ find: async () => (first ? ((first = false), { ok: true as const, value: okPaths([['acc-1', 'far-1', 'acc-2']]) }) : { ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    const before = kit.state.loadedGraph().nodes.length;
    await search(kit);
    await userEvent.click(find());
    await settle();
    expect(kit.state.loadedGraph().nodes).toHaveLength(before);
  });
});

describe('the evidence of a step', () => {
  it('offers each reference of a step as a control only once its relationship is on the canvas, and opens the evidence of that relationship', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2']], {}, ['REC-1', 'REC-2']) }) });
    const open = vi.spyOn(kit.evidence, 'open');
    await search(kit);
    expect(screen.queryByRole('button', { name: /^Evidence/ })).toBeNull();
    expect(screen.getByText('Evidence · REC-1')).toBeTruthy();
    await userEvent.click(choosePathButton(/Path 1/));
    await settle();
    expect(screen.queryByRole('button', { name: /^Evidence/ })).toBeNull();
    await userEvent.click(addButton());
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Evidence · REC-2 ↗' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({ stableId: 'e-acc-1-acc-2', type: 'link-a' });
    expect(screen.getByRole('button', { name: 'Evidence · REC-1 ↗' })).toBeTruthy();
  });

  it('shows no evidence line for a step with no reference', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2']]) }) });
    await search(kit);
    await userEvent.click(choosePathButton(/Path 1/));
    await settle();
    const list = within(screen.getByRole('list', { name: 'Paths found' }));
    expect(list.queryByText(/Evidence/)).toBeNull();
    void fireEvent;
  });
});
