import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileProvider } from '../canvas/profile-context.js';
import { entityOf, keyOf, loadedState, profileWith, at } from '../groups/group-kit.js';
import { ClientStateProvider } from '../state/context.js';
import type { ClientState } from '../state/client-state.js';
import { staticProfile } from '../test-utils.js';
import { GroupSelectionAction, registerGroupMenuItems } from './group-menu.js';
import { createMenuRegistry, MENU_GROUP, MENU_ORDER, stateOf, type MenuContext, type RegisteredMenuItem } from './menu-registry.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from './selection-actions.js';

afterEach(cleanup);

const profile = profileWith({ 'kind-d': { name: 'Kind D' }, 'kind-a': { name: 'Kind A' } });
const entities = [entityOf('kind-d', 'DV1'), entityOf('kind-d', 'DV2'), entityOf('kind-a', 'A1')];

function contextOf(state: ClientState, kind: MenuContext['kind'], key?: string): MenuContext {
  return { kind, key, selection: [], state, canvas: undefined, profile };
}

function itemOf(kind: 'canvas' | 'node', id: string): RegisteredMenuItem {
  const registry = createMenuRegistry();
  registerGroupMenuItems(registry);
  const found = registry.view.getState().get(kind)?.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found;
}

function openSubmenu(item: RegisteredMenuItem, context: MenuContext, close = vi.fn()) {
  const Submenu = item.submenu;
  if (Submenu === undefined) throw new Error('not a submenu');
  render(
    <ClientStateProvider state={context.state}>
      <ProfileProvider store={staticProfile('a', profile)}>
        <Submenu context={context} close={close} />
      </ProfileProvider>
    </ClientStateProvider>,
  );
  return { user: userEvent.setup(), close };
}

describe('the grouping items of the menus', () => {
  it('put "Group all by type" (a submenu) and "Ungroup all" in the frame\'s place of the canvas menu', () => {
    const group = itemOf('canvas', 'group-all-by-type');
    const ungroup = itemOf('canvas', 'ungroup-all');
    expect([group.group, group.order, group.submenu !== undefined]).toEqual([MENU_GROUP.canvas.grouping, MENU_ORDER.canvas.groupAll, true]);
    expect([ungroup.group, ungroup.order]).toEqual([MENU_GROUP.canvas.grouping, MENU_ORDER.canvas.ungroupAll]);
  });

  it('disable both while nothing is loaded and while no group exists, and enable them otherwise', () => {
    const empty = contextOf(loadedState([]), 'canvas');
    expect([stateOf(itemOf('canvas', 'group-all-by-type'), empty), stateOf(itemOf('canvas', 'ungroup-all'), empty)]).toEqual(['disabled', 'disabled']);
    const loaded = loadedState(entities);
    expect([stateOf(itemOf('canvas', 'group-all-by-type'), contextOf(loaded, 'canvas')), stateOf(itemOf('canvas', 'ungroup-all'), contextOf(loaded, 'canvas'))]).toEqual(['enabled', 'disabled']);
    loaded.presentation.setGroups([{ id: 'g', by: 'component', members: [keyOf(at(entities, 0))], collapsed: true }]);
    expect(stateOf(itemOf('canvas', 'ungroup-all'), contextOf(loaded, 'canvas'))).toBe('enabled');
  });

  it('run "Ungroup all", which leaves no group', () => {
    const state = loadedState(entities);
    state.presentation.setGroups([{ id: 'g', by: 'component', members: [keyOf(at(entities, 0))], collapsed: true }]);
    const item = itemOf('canvas', 'ungroup-all');
    if (item.run === undefined) throw new Error('no command');
    item.run(contextOf(state, 'canvas'));
    expect(state.presentation.view.getState().groups).toEqual([]);
  });

  it('offer, under "Group all by type", every type at once and each type in the view, and close the menu after the choice', async () => {
    const state = loadedState(entities);
    const { user, close } = openSubmenu(itemOf('canvas', 'group-all-by-type'), contextOf(state, 'canvas'));
    expect(screen.getAllByRole('menuitem').map((row) => row.textContent)).toEqual(['All entity types', 'Kind D', 'Kind A']);
    await user.click(screen.getByRole('menuitem', { name: 'Kind A' }));
    expect(state.presentation.view.getState().groups.map((group) => group.id)).toEqual(['type:kind-a']);
    expect(close).toHaveBeenCalled();
    cleanup();
    openSubmenu(itemOf('canvas', 'group-all-by-type'), contextOf(state, 'canvas'));
    await user.click(screen.getByRole('menuitem', { name: 'All entity types' }));
    expect(state.presentation.view.getState().groups).toHaveLength(2);
  });

  it('offer, under "Group by type" in the node menu, the type of the entity and every type, replacing only what the choice says', async () => {
    const state = loadedState(entities);
    state.presentation.setGroups([{ id: 'type:kind-a', by: 'entityType', members: [keyOf(at(entities, 2))], collapsed: true }]);
    const { user } = openSubmenu(itemOf('node', 'group-by-type'), contextOf(state, 'node', keyOf(at(entities, 0))));
    expect(screen.getAllByRole('menuitem').map((row) => row.textContent)).toEqual(['Kind D', 'All entity types']);
    await user.click(screen.getByRole('menuitem', { name: 'Kind D' }));
    expect(state.presentation.view.getState().groups.map((group) => [group.id, group.members.length])).toEqual([['type:kind-a', 1], ['type:kind-d', 2]]);
  });

  it('move between the rows of a submenu with the arrow keys', async () => {
    const { user } = openSubmenu(itemOf('canvas', 'group-all-by-type'), contextOf(loadedState(entities), 'canvas'));
    screen.getByRole('menuitem', { name: 'All entity types' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Kind D' }));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Kind A' }));
  });

  it('disable the node item for a key that is not an entity', () => {
    expect(stateOf(itemOf('node', 'group-by-type'), contextOf(loadedState(entities), 'node', 'edge-key'))).toBe('disabled');
  });
});

describe('the Group action of the selection bar', () => {
  it('is registered at its place and groups the selected entities by type', () => {
    const state = loadedState(entities);
    const registry = createSelectionActionRegistry();
    render(
      <ClientStateProvider state={state}>
        <SelectionActionsProvider registry={registry}>
          <GroupSelectionAction />
        </SelectionActionsProvider>
      </ClientStateProvider>,
    );
    const [action] = registry.view.getState();
    expect([action?.id, action?.label]).toEqual(['group', 'Group']);
    action?.run([keyOf(at(entities, 0)), keyOf(at(entities, 1)), keyOf(at(entities, 2))]);
    expect(state.presentation.view.getState().groups.map((group) => group.id)).toEqual(['selection:kind-d:1', 'selection:kind-a:1']);
  });
});
