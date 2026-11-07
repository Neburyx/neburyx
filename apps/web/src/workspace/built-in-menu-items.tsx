import { runSelectionCommand } from '../canvas/selection-commands.js';
import { LayoutList } from './layout-list.js';
import { NeighborTypesSubmenu } from './neighbor-types-submenu.js';
import { MENU_GROUP, MENU_ORDER, type MenuContext, type MenuRegistry, type SubmenuProps } from './menu-registry.js';

const canLayOut = (context: MenuContext): boolean => context.canvas !== undefined && context.state.loadedGraph().nodes.length > 0;

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
      submenu: NeighborTypesSubmenu,
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
