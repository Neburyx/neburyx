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

describe('choosing a path', () => {
  it('adds what of the path is not loaded, once, selects the path and reads Selected; the arrow keys choose nothing', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'far-1', 'acc-2'], ['acc-1', 'acc-2']]) }) });
    await search(kit);
    const before = loadedKeys(kit).length;
    await userEvent.keyboard('{ArrowDown}{ArrowUp}');
    expect(loadedKeys(kit)).toHaveLength(before);
    expect(screen.queryByText(/Selected/)).toBeNull();
    await userEvent.click(choosePathButton(/Path 1 · 2 hops/));
    await settle();
    expect(loadedKeys(kit)).toContain(elementKey(nodeRef('far-1')));
    expect(loadedKeys(kit)).toHaveLength(before + 1);
    expect(kit.state.loadedGraph().edges.length).toBe(2);
    expect(selected(kit)).toEqual([elementKey(nodeRef('acc-1')), elementKey(nodeRef('acc-2')), elementKey(nodeRef('far-1')), ...kit.state.loadedGraph().edges.map((edge) => edgeKey(edge.ref))].sort());
    expect(screen.getByText(/Selected/)).toBeTruthy();
    expect(choosePathButton(/Path 1/).getAttribute('aria-pressed')).toBe('true');
  });

  it('chooses with Enter on the row too, and adds nothing for a path that is loaded already, selecting it', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2']]) }) });
    await search(kit);
    await userEvent.click(choosePathButton(/Path 1/));
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
  });

  it('makes the selection the second path, and keeps what the first path added', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'far-1', 'acc-2'], ['acc-1', 'far-2', 'acc-2']]) }) });
    await search(kit);
    await userEvent.click(choosePathButton(/Path 1/));
    await settle();
    await userEvent.click(choosePathButton(/Path 2/));
    await settle();
    expect(loadedKeys(kit)).toEqual(expect.arrayContaining([elementKey(nodeRef('far-1')), elementKey(nodeRef('far-2'))]));
    expect(selected(kit)).toContain(elementKey(nodeRef('far-2')));
    expect(selected(kit)).not.toContain(elementKey(nodeRef('far-1')));
    expect(choosePathButton(/Path 1/).getAttribute('aria-pressed')).toBe('false');
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
  it('offers each reference of a step as a control only once the path is chosen, and opens the evidence of that relationship', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2']], {}, ['REC-1', 'REC-2']) }) });
    const open = vi.spyOn(kit.evidence, 'open');
    await search(kit);
    expect(screen.queryByRole('button', { name: 'Evidence · REC-1 ↗' })).toBeNull();
    expect(screen.getByText('Evidence · REC-1 ↗')).toBeTruthy();
    await userEvent.click(choosePathButton(/Path 1/));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Evidence · REC-2 ↗' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({ stableId: 'e-acc-1-acc-2', type: 'link-a' });
    expect(screen.getByRole('button', { name: 'Evidence · REC-1 ↗' })).toBeTruthy();
  });

  it('says evidence is not available for a step with no reference and offers nothing to open', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2']]) }) });
    await search(kit);
    await userEvent.click(choosePathButton(/Path 1/));
    await settle();
    const list = within(screen.getByRole('list', { name: 'Paths found' }));
    expect(list.getByText('Evidence not available')).toBeTruthy();
    expect(list.queryByRole('button', { name: /Evidence/ })).toBeNull();
    void fireEvent;
  });
});
