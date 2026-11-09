import type { ClientState } from '../state/client-state.js';
import { drawnKeys } from '../state/loaded-graph.js';
import type { Evidence } from '../evidence/evidence.js';
import { MENU_GROUP, type MenuContext, type MenuItemState, type MenuRegistry } from '../workspace/menu-registry.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import type { SelectionActionRegistry } from '../workspace/selection-actions.js';
import { bindComparePanel } from './compare-binder.js';
import { headerOf } from './compare-elements.js';
import { pickSet, selectionKind, type CompareSet } from './compare-set.js';
import { createCompare, type Compare } from './compare.js';
import { COMPARE, NOT_BOTH_KINDS, compareLabel } from './copy.js';

/** Where the selection bar puts Compare: after Paths between. */
const SELECTION_ACTION_ORDER_COMPARE = 25;
const MENU_ORDER_COMPARE = 25;

/** The drawn keys of a selection, in selection order. */
const drawnOf = (state: ClientState, selection: readonly string[]): readonly string[] => {
  const drawn = drawnKeys(state.visibleGraph());
  return selection.filter((key) => drawn.has(key));
};

export function compareSetOf(state: ClientState, selection: readonly string[]): CompareSet | undefined {
  return pickSet(drawnOf(state, selection));
}

/** Opens the comparison for a selection: the note to show instead when the selection is not two or more of one kind. */
export function openCompare(state: ClientState, compare: Compare, selection: readonly string[], opener?: HTMLElement | null): string | undefined {
  const set = compareSetOf(state, selection);
  if (set === undefined) return NOT_BOTH_KINDS;
  const graph = state.visibleGraph();
  const columns = set.compared.flatMap((key) => {
    const header = headerOf(graph, undefined, key);
    return header === undefined ? [] : [{ key, title: header.title }];
  });
  compare.open({ kind: set.kind, columns, selected: set.selected, left: set.left, gone: [] }, opener);
  return undefined;
}

/** What the selection bar and the menus say Compare is for the selection: "Compare", or "Compare 5 of 7" over the limit. */
const labelOf = (state: ClientState, selection: readonly string[]): string => {
  const set = compareSetOf(state, selection);
  return set === undefined ? COMPARE : compareLabel(set.compared.length, set.selected);
};

/**
 * The comparison of a workspace: the dock panel, **Compare** on the selection bar and in the node and relationship menus (the menu items only for a selection of one kind), and the hand-over of the dock with the relationship evidence.
 * The function returned takes all of it away.
 */
export function bindBuiltInCompare(
  state: ClientState,
  panels: PanelRegistry,
  menus: MenuRegistry,
  selectionActions: SelectionActionRegistry,
  evidence: Evidence | undefined,
): { readonly compare: Compare; readonly unbind: () => void } {
  const compare = createCompare();
  const forMenu = (kind: 'node' | 'relationship') => (context: MenuContext): MenuItemState => {
    const keys = drawnOf(state, context.selection);
    const set = selectionKind(keys);
    return keys.length >= 2 && set === (kind === 'node' ? 'entities' : 'relationships') ? 'enabled' : 'hidden';
  };
  const runMenu = (context: MenuContext): void => void openCompare(state, compare, context.selection);
  const icon = <span className="icon icon-compare" aria-hidden="true" />;
  const removals = [
    // the dock holds one panel: the evidence panel lets go of it before a comparison opens, and a comparison before the evidence panel opens
    compare.onOpening(() => {
      if (evidence?.target.getState() !== undefined) evidence?.close();
    }),
    evidence === undefined ? () => undefined : evidence.onOpening(() => compare.close(false)),
    bindComparePanel(state, panels, compare),
    selectionActions.register({
      id: 'compare',
      order: SELECTION_ACTION_ORDER_COMPARE,
      label: (selection) => labelOf(state, selection),
      icon,
      run: (selection) => openCompare(state, compare, selection),
    }),
    menus.register('node', { id: 'compare', label: (context) => labelOf(state, context.selection), icon, group: MENU_GROUP.node.selection, order: MENU_ORDER_COMPARE, state: forMenu('node'), run: runMenu }),
    menus.register('relationship', { id: 'compare', label: (context) => labelOf(state, context.selection), icon, group: MENU_GROUP.relationship.explain, order: MENU_ORDER_COMPARE + 10, state: forMenu('relationship'), run: runMenu }),
  ];
  return {
    compare,
    unbind: () => {
      for (const remove of removals.reverse()) remove();
    },
  };
}
