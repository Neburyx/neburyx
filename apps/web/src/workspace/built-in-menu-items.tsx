import { hideEntities, hideTargetsOf, showHiddenAndFocusCanvas } from '../canvas/hide-commands.js';
import { runSelectionCommand } from '../canvas/selection-commands.js';
import { LayoutList } from './layout-list.js';
import { nodeRefOfKey } from '../state/keys.js';
import { COLLAPSE, EXPAND_BY_NEIGHBOR_TYPE, EXPAND_BY_TYPE } from './expand-copy.js';
import { ExpandByTypeSubmenu } from './expand-by-type-submenu.js';
import { MENU_GROUP, MENU_ORDER, type MenuContext, type MenuRegistry, type SubmenuProps } from './menu-registry.js';

const canLayOut = (context: MenuContext): boolean => context.canvas !== undefined && context.state.visibleGraph().nodes.length > 0;

function LayoutSubmenu({ context, close }: SubmenuProps) {
  return (
    <LayoutList
      disabled={!canLayOut(context)}
      onChoose={() => {
        context.canvas?.layout();
        close();
      }}
    />
  );
}

export function registerBuiltInMenuItems(registry: MenuRegistry): () => void {
  const removals = [
    registry.register('node', {
      id: 'expand-neighbors',
      label: 'Expand neighbors',
      icon: <span className="icon icon-expand" aria-hidden="true" />,
      group: MENU_GROUP.node.expand,
      order: MENU_ORDER.node.expandNeighbors,
      binding: 'expand',
      state: (context) => (context.expansion === undefined ? 'disabled' : 'enabled'),
      run: (context) => {
        if (context.key !== undefined) context.expansion?.expandNode(context.key);
      },
    }),
    registry.register('node', {
      id: 'expand-by-neighbor-type',
      label: EXPAND_BY_NEIGHBOR_TYPE,
      icon: <span className="icon icon-expand" aria-hidden="true" />,
      group: MENU_GROUP.node.expand,
      order: MENU_ORDER.node.expandByNeighborType,
      submenu: ExpandByTypeSubmenu,
    }),
    registry.register('node', {
      id: 'expand-by-type',
      label: EXPAND_BY_TYPE,
      icon: <span className="icon icon-expand" aria-hidden="true" />,
      group: MENU_GROUP.node.expand,
      order: MENU_ORDER.node.expandByType,
      state: (context) => (context.key !== undefined && nodeRefOfKey(context.key) !== undefined ? 'enabled' : 'disabled'),
      run: (context) => {
        if (context.key !== undefined) context.state.presentation.setSupernodePanel({ key: context.key });
      },
    }),
    registry.register('node', {
      id: 'collapse',
      label: COLLAPSE,
      icon: <span className="icon icon-collapse" aria-hidden="true" />,
      group: MENU_GROUP.node.expand,
      order: MENU_ORDER.node.collapse,
      state: (context) => {
        const ref = context.key === undefined ? undefined : nodeRefOfKey(context.key);
        return ref !== undefined && context.expansion?.store.collapsibility(ref) === 'yes' ? 'enabled' : 'disabled';
      },
      run: (context) => {
        const ref = context.key === undefined ? undefined : nodeRefOfKey(context.key);
        if (ref !== undefined) context.expansion?.store.collapse(ref);
      },
    }),
    registry.register('node', {
      id: 'invert-selection',
      label: 'Invert selection',
      icon: <span className="icon icon-invert" aria-hidden="true" />,
      group: MENU_GROUP.node.selection,
      order: MENU_ORDER.node.invertSelection,
      binding: 'invert-selection',
      run: (context) => runSelectionCommand(context.state, 'invert-selection'),
    }),
    registry.register('node', {
      id: 'hide-from-view',
      label: 'Hide from view',
      icon: <span className="icon icon-hide" aria-hidden="true" />,
      group: MENU_GROUP.node.selection,
      order: MENU_ORDER.node.hideFromView,
      binding: 'hide',
      run: (context) => hideEntities(context.state, hideTargetsOf(context.selection, context.key)),
    }),
    registry.register('canvas', {
      id: 'fit-to-view',
      label: 'Fit to view',
      icon: <span className="icon icon-fit" aria-hidden="true" />,
      group: MENU_GROUP.canvas.view,
      order: MENU_ORDER.canvas.fit,
      binding: 'fit',
      run: (context) => context.canvas?.fit(),
    }),
    registry.register('canvas', {
      id: 'select-all',
      label: 'Select all',
      icon: <span className="icon icon-box-select" aria-hidden="true" />,
      group: MENU_GROUP.canvas.view,
      order: MENU_ORDER.canvas.selectAll,
      binding: 'select-all',
      run: (context) => runSelectionCommand(context.state, 'select-all'),
    }),
    registry.register('canvas', {
      id: 'invert-selection',
      label: 'Invert selection',
      icon: <span className="icon icon-invert" aria-hidden="true" />,
      group: MENU_GROUP.canvas.view,
      order: MENU_ORDER.canvas.invertSelection,
      binding: 'invert-selection',
      run: (context) => runSelectionCommand(context.state, 'invert-selection'),
    }),
    registry.register('canvas', {
      id: 'show-hidden',
      label: (context) => `Show hidden entities (${context.state.presentation.view.getState().hidden.size})`,
      icon: <span className="icon icon-show" aria-hidden="true" />,
      group: MENU_GROUP.canvas.view,
      order: MENU_ORDER.canvas.showHidden,
      state: (context) => (context.state.presentation.view.getState().hidden.size === 0 ? 'disabled' : 'enabled'),
      run: (context) => showHiddenAndFocusCanvas(context.state),
    }),
    registry.register('canvas', {
      id: 'layout',
      label: 'Layout',
      icon: <span className="icon icon-layout" aria-hidden="true" />,
      group: MENU_GROUP.canvas.layoutAndLegend,
      order: MENU_ORDER.canvas.layout,
      state: (context) => (canLayOut(context) ? 'enabled' : 'disabled'),
      submenu: LayoutSubmenu,
    }),
    registry.register('canvas', {
      id: 'show-legend',
      label: (context) => (context.state.presentation.view.getState().legendOpen ? 'Hide legend' : 'Show legend'),
      icon: <span className="icon icon-legend" aria-hidden="true" />,
      group: MENU_GROUP.canvas.layoutAndLegend,
      order: MENU_ORDER.canvas.showLegend,
      binding: 'legend',
      run: (context) => context.state.presentation.setLegendOpen(!context.state.presentation.view.getState().legendOpen),
    }),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}
