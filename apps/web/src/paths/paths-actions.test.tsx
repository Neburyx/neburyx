import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { edgeKey, elementKey } from '../state/keys.js';
import type { MenuContext, MenuItem } from '../workspace/menu-registry.js';
import { nodeRef, okPaths, pathsWorkspace, settle, type PathsKit } from './paths-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const select = (kit: PathsKit, ...ids: string[]): void => act(() => kit.state.presentation.select(ids.map((id) => elementKey(nodeRef(id, id.startsWith('dev') ? 'kind-b' : 'kind-a')))));
const field = (label: 'From' | 'To'): string => (screen.getByLabelText(label) as HTMLInputElement).value;
const key = (id: string): string => elementKey(nodeRef(id, id.startsWith('dev') ? 'kind-b' : 'kind-a'));

function itemOf(kit: PathsKit, kind: 'node' | 'relationship', id: string): MenuItem {
  const found = kit.menus.view.getState().get(kind)?.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no menu item ${id}`);
  return found;
}

const contextOf = (kit: PathsKit, kind: 'node' | 'relationship', menuKey: string): MenuContext => ({ kind, key: menuKey, selection: [menuKey], state: kit.state, canvas: undefined });

describe('Paths between on the selection bar', () => {
  it('opens the panel with the first two selected entities, in selection order, as From and To, and sends nothing', async () => {
    const kit = await pathsWorkspace();
    select(kit, 'dev-1', 'acc-2', 'acc-1');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Paths between' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Bounded path search' })).toBeTruthy();
    expect(field('From')).toBe('dev-1');
    expect(field('To')).toBe('acc-2');
    expect(kit.sent).toEqual([]);
  });

  it('is not offered for a selection of fewer than two items, and says so for two relationships', async () => {
    const edges = okPaths([['acc-1', 'acc-2']]);
    const kit = await pathsWorkspace({ edges: edges.status === 'ok' ? edges.edges : [] });
    select(kit, 'acc-1');
    await settle();
    expect(screen.queryByRole('button', { name: 'Paths between' })).toBeNull();
    const [edge] = kit.state.loadedGraph().edges;
    act(() => kit.state.presentation.select([key('acc-1'), edge === undefined ? '' : edgeKey(edge.ref)]));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Paths between' }));
    await settle();
    expect(screen.getByText('Select two entities.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Bounded path search' })).toBeNull();
  });
});

describe('the menus and the key', () => {
  it('opens the panel with the entity as From for "Find paths from here…" and as To for "Find paths to…", the other end empty', async () => {
    const kit = await pathsWorkspace();
    act(() => itemOf(kit, 'node', 'paths-from-here').run?.(contextOf(kit, 'node', key('acc-1'))));
    await settle();
    expect(field('From')).toBe('acc-1');
    expect(field('To')).toBe('');
    act(() => itemOf(kit, 'node', 'paths-to-here').run?.(contextOf(kit, 'node', key('acc-2'))));
    await settle();
    expect(field('To')).toBe('acc-2');
    expect(field('From')).toBe('');
    expect(kit.sent).toEqual([]);
  });

  it('opens the panel with the two ends of a relationship for "Find paths between endpoints"', async () => {
    const answer = okPaths([['acc-1', 'acc-2']]);
    const kit = await pathsWorkspace({ edges: answer.status === 'ok' ? answer.edges : [] });
    const [edge] = kit.state.loadedGraph().edges;
    if (edge === undefined) throw new Error('no edge loaded');
    act(() => itemOf(kit, 'relationship', 'paths-between-endpoints').run?.(contextOf(kit, 'relationship', edgeKey(edge.ref))));
    await settle();
    expect(field('From')).toBe('acc-1');
    expect(field('To')).toBe('acc-2');
  });

  it('opens the panel from ⇧P for the one selected entity, and does nothing for none or for several', async () => {
    const kit = await pathsWorkspace();
    fireEvent.keyDown(document.body, { key: 'P', code: 'KeyP', shiftKey: true });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Bounded path search' })).toBeNull();
    select(kit, 'acc-1', 'acc-2');
    fireEvent.keyDown(document.body, { key: 'P', code: 'KeyP', shiftKey: true });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Bounded path search' })).toBeNull();
    select(kit, 'acc-2');
    fireEvent.keyDown(document.body, { key: 'P', code: 'KeyP', shiftKey: true });
    await settle();
    expect(field('From')).toBe('acc-2');
  });

  it('lists Find paths in the shortcut registry, and leaves no stand-in of the same place beside the real items', async () => {
    const kit = await pathsWorkspace();
    expect(kit.keyBindings.view.getState().some((binding) => binding.id === 'find-paths' && binding.label === 'Find paths')).toBe(true);
    expect(kit.menus.view.getState().get('node')?.filter((item) => item.group === 20 && item.order === 10)).toHaveLength(1);
  });
});
