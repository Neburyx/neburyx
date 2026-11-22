import { useEffect, type KeyboardEvent } from 'react';
import { groupAllByType, groupTypeOnly, ungroupAll } from '../groups/group-actions.js';
import { groupsByEntityType } from '../groups/group-model.js';
import { nodeRefOfKey } from '../state/keys.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { ALL_ENTITY_TYPES, GROUP_ALL_BY_TYPE, GROUP_BY_TYPE, GROUP_SELECTION, UNGROUP_ALL } from './group-copy.js';
import { MENU_GROUP, MENU_ORDER, type MenuContext, type MenuRegistry, type SubmenuProps } from './menu-registry.js';
import { SELECTION_ACTION_ORDER, useSelectionActionRegistryWhenProvided } from './selection-actions.js';
import { groupSelection } from '../groups/group-actions.js';
import { useProfile } from '../canvas/profile-context.js';

function move(event: KeyboardEvent<HTMLDivElement>): void {
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const at = rows.findIndex((row) => row === document.activeElement);
  const last = rows.length - 1;
  const next = event.key === 'ArrowDown' ? (at >= last ? 0 : at + 1) : event.key === 'ArrowUp' ? (at <= 0 ? last : at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
  if (next === undefined) return;
  event.preventDefault();
  rows[next]?.focus();
}

interface ChoiceListProps {
  readonly label: string;
  readonly choices: readonly { readonly id: string; readonly label: string; readonly run: () => void }[];
  readonly close: () => void;
}

function ChoiceList({ label, choices, close }: ChoiceListProps) {
  return (
    <div className="layout-list" role="menu" aria-label={label} onKeyDown={move}>
      {choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          role="menuitem"
          className="menu-row"
          onClick={() => {
            choice.run();
            close();
          }}
        >
          <span className="menu-label">{choice.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The submenu of "Group all by type": every entity type at once, or one type only. */
function GroupAllSubmenu({ close }: SubmenuProps) {
  const state = useClientState();
  const profile = useProfile();
  const graph = useLoadedGraph();
  const types = groupsByEntityType(graph.nodes).map((group) => group.id.slice('type:'.length));
  const nameOf = (type: string): string => profile?.entityTypes.find((entry) => entry.type === type)?.displayName ?? type;
  return (
    <ChoiceList
      label={GROUP_ALL_BY_TYPE}
      close={close}
      choices={[{ id: 'all', label: ALL_ENTITY_TYPES, run: () => void groupAllByType(state) }, ...types.map((type) => ({ id: type, label: nameOf(type), run: () => groupTypeOnly(state, type) }))]}
    />
  );
}

/** The submenu of "Group by type" in the node menu: the type of the entity the menu is about, or every type. */
function GroupNodeSubmenu({ context, close }: SubmenuProps) {
  const state = useClientState();
  const profile = useProfile();
  const type = context.key === undefined ? undefined : nodeRefOfKey(context.key)?.entityType;
  const name = type === undefined ? undefined : (profile?.entityTypes.find((entry) => entry.type === type)?.displayName ?? type);
  return <ChoiceList label={GROUP_BY_TYPE} close={close} choices={[...(type === undefined || name === undefined ? [] : [{ id: 'this', label: name, run: () => groupTypeOnly(state, type) }]), { id: 'all', label: ALL_ENTITY_TYPES, run: () => void groupAllByType(state) }]} />;
}

const hasEntities = (context: MenuContext): boolean => context.state.loadedGraph().nodes.length > 0;

/** The grouping items of the canvas menu and the node menu; they replace the stand-ins of the frame pages. */
export function registerGroupMenuItems(registry: MenuRegistry): () => void {
  const removals = [
    registry.register('canvas', {
      id: 'group-all-by-type',
      label: GROUP_ALL_BY_TYPE,
      icon: <span className="icon icon-group" aria-hidden="true" />,
      group: MENU_GROUP.canvas.grouping,
      order: MENU_ORDER.canvas.groupAll,
      state: (context) => (hasEntities(context) ? 'enabled' : 'disabled'),
      submenu: GroupAllSubmenu,
    }),
    registry.register('canvas', {
      id: 'ungroup-all',
      label: UNGROUP_ALL,
      icon: <span className="icon icon-ungroup" aria-hidden="true" />,
      group: MENU_GROUP.canvas.grouping,
      order: MENU_ORDER.canvas.ungroupAll,
      state: (context) => (context.state.presentation.view.getState().groups.length === 0 ? 'disabled' : 'enabled'),
      run: (context) => ungroupAll(context.state),
    }),
    registry.register('node', {
      id: 'group-by-type',
      label: GROUP_BY_TYPE,
      icon: <span className="icon icon-group" aria-hidden="true" />,
      group: MENU_GROUP.node.selection,
      order: MENU_ORDER.node.groupByType,
      state: (context) => (context.key !== undefined && nodeRefOfKey(context.key) !== undefined ? 'enabled' : 'disabled'),
      submenu: GroupNodeSubmenu,
    }),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}

/** Puts *Group* on the selection bar: it groups the selected entities by entity type. Draws nothing. */
export function GroupSelectionAction() {
  const registry = useSelectionActionRegistryWhenProvided();
  const state = useClientState();
  useEffect(() => {
    if (registry === undefined) return undefined;
    return registry.register({
      id: 'group',
      order: SELECTION_ACTION_ORDER.group,
      label: GROUP_SELECTION,
      icon: <span className="icon icon-group" aria-hidden="true" />,
      run: (selection) => groupSelection(state, selection),
    });
  }, [registry, state]);
  return null;
}
