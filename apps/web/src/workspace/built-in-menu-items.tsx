import { runSelectionCommand } from '../canvas/selection-commands.js';
import { MENU_GROUP, MENU_ORDER, type MenuRegistry } from './menu-registry.js';

export function registerBuiltInMenuItems(registry: MenuRegistry): () => void {
  const removals = [
    registry.register('canvas', {
      id: 'fit-to-view',
      label: 'Fit to view',
      icon: <span className="icon icon-fit" aria-hidden="true" />,
      group: MENU_GROUP.canvas.view,
      order: MENU_ORDER.canvas.fit,
      shortcut: '⌘0',
      run: (context) => context.canvas?.fit(),
    }),
    registry.register('canvas', {
      id: 'select-all',
      label: 'Select all',
      icon: <span className="icon icon-box-select" aria-hidden="true" />,
      group: MENU_GROUP.canvas.view,
      order: MENU_ORDER.canvas.selectAll,
      shortcut: '⌘A',
      run: (context) => runSelectionCommand(context.state, 'select-all'),
    }),
    registry.register('canvas', {
      id: 'invert-selection',
      label: 'Invert selection',
      icon: <span className="icon icon-invert" aria-hidden="true" />,
      group: MENU_GROUP.canvas.view,
      order: MENU_ORDER.canvas.invertSelection,
      shortcut: '⇧⌘I',
      run: (context) => runSelectionCommand(context.state, 'invert-selection'),
    }),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}
