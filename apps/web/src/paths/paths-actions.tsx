import type { ElementRef } from '@neburyx/contracts';
import type { ClientState } from '../state/client-state.js';
import { edgeKey, isEdgeKey, nodeRefOfKey } from '../state/keys.js';
import { drawnKeys } from '../state/loaded-graph.js';
import type { KeyBindingRegistry } from '../workspace/key-binding-registry.js';
import { MENU_GROUP, MENU_ORDER, type MenuContext, type MenuItemState, type MenuRegistry } from '../workspace/menu-registry.js';
import { SELECTION_ACTION_ORDER, type SelectionActionRegistry } from '../workspace/selection-actions.js';
import { PATHS_ACTIONS } from './copy.js';

const entityRefsOf = (state: ClientState, selection: readonly string[]): readonly ElementRef[] => {
  const drawn = drawnKeys(state.visibleGraph());
  return selection.flatMap((key) => {
    const found = isEdgeKey(key) || !drawn.has(key) ? undefined : nodeRefOfKey(key);
    return found === undefined ? [] : [found];
  });
};

const entityOf = (context: MenuContext): ElementRef | undefined => (context.key === undefined || isEdgeKey(context.key) ? undefined : nodeRefOfKey(context.key));

const endsOfRelationship = (context: MenuContext): { readonly from: ElementRef; readonly to: ElementRef } | undefined => {
  if (context.key === undefined || !isEdgeKey(context.key)) return undefined;
  const edge = context.state.loadedGraph().edges.find((candidate) => edgeKey(candidate.ref) === context.key);
  return edge === undefined ? undefined : { from: edge.from, to: edge.to };
};

const enabledWhen = (found: boolean): MenuItemState => (found ? 'enabled' : 'disabled');

/**
 * What the Paths panel is reached by besides its tool: **Paths between** on the selection bar (the first two selected entities in selection order), "Find paths from here…" and "Find paths to…" in the
 * entity menu, "Find paths between endpoints" in the relationship menu, and the key ⇧P on the one selected entity. Each opens the panel with the ends filled in and sends nothing. The function returned takes it all away.
 */
export function bindPathsActions(state: ClientState, menus: MenuRegistry, selectionActions: SelectionActionRegistry, keyBindings?: KeyBindingRegistry): () => void {
  const removals = [
    selectionActions.register({
      id: 'paths-between',
      label: PATHS_ACTIONS.between,
      icon: <span className="icon icon-paths" aria-hidden="true" />,
      order: SELECTION_ACTION_ORDER.pathsBetween,
      run: (selection) => {
        const [from, to] = entityRefsOf(state, selection);
        if (from === undefined || to === undefined) return PATHS_ACTIONS.needTwo;
        state.presentation.requestPaths({ from, to });
        return undefined;
      },
    }),
    menus.register('node', {
      id: 'paths-from-here',
      label: PATHS_ACTIONS.fromHere,
      icon: <span className="icon icon-stand-in-menu-route" aria-hidden="true" />,
      group: MENU_GROUP.node.paths,
      order: MENU_ORDER.node.findPathsFromHere,
      binding: 'find-paths',
      state: (context) => enabledWhen(entityOf(context) !== undefined),
      run: (context) => {
        const from = entityOf(context);
        if (from !== undefined) state.presentation.requestPaths({ from });
      },
    }),
    menus.register('node', {
      id: 'paths-to-here',
      label: PATHS_ACTIONS.toHere,
      icon: <span className="icon icon-stand-in-menu-route" aria-hidden="true" />,
      group: MENU_GROUP.node.paths,
      order: MENU_ORDER.node.findPathsTo,
      state: (context) => enabledWhen(entityOf(context) !== undefined),
      run: (context) => {
        const to = entityOf(context);
        if (to !== undefined) state.presentation.requestPaths({ to });
      },
    }),
    menus.register('relationship', {
      id: 'paths-between-endpoints',
      label: PATHS_ACTIONS.betweenEndpoints,
      icon: <span className="icon icon-stand-in-menu-route" aria-hidden="true" />,
      group: MENU_GROUP.relationship.endpoints,
      order: MENU_ORDER.relationship.findPathsBetween,
      state: (context) => enabledWhen(endsOfRelationship(context) !== undefined),
      run: (context) => {
        const ends = endsOfRelationship(context);
        if (ends !== undefined) state.presentation.requestPaths(ends);
      },
    }),
    ...(keyBindings === undefined
      ? []
      : [
          keyBindings.register({
            id: 'find-paths',
            keys: ['shift+p'],
            label: PATHS_ACTIONS.keyLabel,
            group: 'actions',
            order: 40,
            scope: 'workspace',
            when: ({ state: current }) => current.presentation.view.getState().openMenu === undefined && entityRefsOf(current, [...current.presentation.view.getState().selection]).length === 1 && [...current.presentation.view.getState().selection].length === 1,
            run: ({ state: current }) => {
              const [from] = entityRefsOf(current, [...current.presentation.view.getState().selection]);
              if (from !== undefined) current.presentation.requestPaths({ from });
            },
          }),
        ]),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}
