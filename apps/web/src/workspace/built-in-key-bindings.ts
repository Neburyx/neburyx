import { applyClick, openContextMenu } from '../canvas/apply-click.js';
import { directionOf, MOVE_STEP, MOVE_STEP_FAR, moveSelected, type Schedule } from '../canvas/arrow-move.js';
import { focusKeyAction, runFocusKey } from '../canvas/focus-commands.js';
import { hideEntities, selectedEntities } from '../canvas/hide-commands.js';
import { togglePin } from '../canvas/pin-commands.js';
import { runSelectionCommand, type SelectionCommandId } from '../canvas/selection-commands.js';
import { stepWalk, walkOrder } from '../canvas/walk.js';
import { isEdgeKey } from '../state/keys.js';
import type { PointerTool } from '../state/presentation-state.js';
import type { KeyBindingRegistry, KeyContext } from './key-binding-registry.js';

const TOOLS: readonly { readonly tool: PointerTool; readonly keys: string; readonly label: string; readonly order: number }[] = [
  { tool: 'select', keys: 'v', label: 'Select', order: 10 },
  { tool: 'pan', keys: 'h', label: 'Pan', order: 20 },
  { tool: 'box', keys: 'b', label: 'Box select', order: 30 },
];

const SELECTION: readonly { readonly id: SelectionCommandId; readonly keys: string; readonly label: string; readonly order: number }[] = [
  { id: 'select-all', keys: 'mod+a', label: 'Select all', order: 10 },
  { id: 'invert-selection', keys: 'mod+shift+i', label: 'Invert selection', order: 20 },
  { id: 'clear-selection', keys: 'escape', label: 'Clear', order: 30 },
];

/** The keys of the entities in a selection. */
const selectedNodes = (selection: ReadonlySet<string>): string[] => [...selection].filter((key) => !isEdgeKey(key));

const walking = ({ state }: KeyContext): boolean => state.presentation.view.getState().walking;
const notWalking = (context: KeyContext): boolean => !walking(context);

/** With nothing left to walk to the walk is over and the key is the browser's. */
function walkStep({ state }: KeyContext, direction: 1 | -1): 'unhandled' | undefined {
  const target = stepWalk(walkOrder(state.visibleGraph(), state.presentation.view.getState().sceneItems), state.presentation.view.getState().focused, direction);
  if (target === undefined) {
    state.presentation.endWalk();
    return 'unhandled';
  }
  state.presentation.walkTo(target);
  return undefined;
}

function walkSelect({ state }: KeyContext, shift: boolean): void {
  const { focused } = state.presentation.view.getState();
  if (focused !== undefined) applyClick(state, { target: focused, shift });
}

/** Opens the menu of the element the walk is at, or the canvas's own with the walk off or no element held, where the item is on the page. */
function openMenuFromKeyboard({ state, canvas }: KeyContext): 'unhandled' | undefined {
  const { walking: on, focused } = state.presentation.view.getState();
  const wanted = on ? focused : undefined;
  const anchored = wanted === undefined ? undefined : canvas?.anchorOf(wanted);
  const at = anchored ?? canvas?.anchorOf(undefined);
  if (at === undefined) return 'unhandled';
  const target = wanted !== undefined && anchored !== undefined ? { kind: isEdgeKey(wanted) ? ('relationship' as const) : ('node' as const), key: wanted } : undefined;
  openContextMenu(state, { target, x: at.x, y: at.y });
  return undefined;
}

/** The bindings the workspace itself has; features add theirs through the same registry. */
export function registerBuiltInKeyBindings(registry: KeyBindingRegistry, schedule: Schedule = (callback) => void requestAnimationFrame(callback)): () => void {
  const move = (step: number) => ({ state, event }: KeyContext): 'unhandled' | undefined => {
    const direction = event === undefined ? undefined : directionOf(event.key);
    return direction !== undefined && moveSelected(state, direction, step, schedule, event?.repeat === true) ? undefined : 'unhandled';
  };
  const removals = [
    ...TOOLS.map(({ tool, keys, label, order }) =>
      registry.register({ id: `tool-${tool}`, keys: [keys], label, group: 'tools', order, scope: 'workspace', run: ({ state }) => state.presentation.setTool(tool) }),
    ),
    registry.register({
      id: 'legend',
      keys: ['l'],
      label: 'Legend',
      group: 'tools',
      order: 50,
      scope: 'workspace',
      run: ({ state }) => state.presentation.setLegendOpen(!state.presentation.view.getState().legendOpen),
    }),
    ...SELECTION.map(({ id, keys, label, order }) =>
      registry.register({ id, keys: [keys], label, group: 'selection', order, scope: 'workspace', ...(id === 'clear-selection' ? { when: notWalking } : {}), run: ({ state }) => runSelectionCommand(state, id) }),
    ),
    registry.register({
      id: 'walk-enter',
      keys: ['enter', 'space'],
      label: 'Walk the canvas',
      group: 'view',
      order: 30,
      scope: 'canvas',
      when: notWalking,
      run: ({ state }) => {
        const order = walkOrder(state.visibleGraph(), state.presentation.view.getState().sceneItems);
        const { focused } = state.presentation.view.getState();
        const start = focused !== undefined && order.includes(focused) ? focused : order[0];
        if (start !== undefined) state.presentation.walkTo(start);
      },
    }),
    registry.register({ id: 'walk-next', keys: ['tab'], label: 'Next element', group: 'view', order: 40, scope: 'canvas', when: walking, repeat: true, run: (context) => walkStep(context, 1) }),
    registry.register({ id: 'walk-previous', keys: ['shift+tab'], label: 'Previous element', group: 'view', order: 50, scope: 'canvas', when: walking, repeat: true, run: (context) => walkStep(context, -1) }),
    registry.register({ id: 'walk-leave', keys: ['escape'], label: 'Leave the walk', group: 'view', order: 60, scope: 'canvas', when: walking, run: ({ state }) => state.presentation.endWalk() }),
    registry.register({ id: 'walk-select', keys: ['enter', 'space'], label: 'Select the element', group: 'selection', order: 100, scope: 'canvas', when: walking, run: (context) => walkSelect(context, false) }),
    registry.register({
      id: 'open-context-menu',
      keys: ['contextmenu', 'shift+f10'],
      label: 'Open context menu',
      group: 'view',
      order: 70,
      scope: 'canvas',
      when: ({ state }) => state.presentation.view.getState().openMenu === undefined,
      run: openMenuFromKeyboard,
    }),
    registry.register({ id: 'move', keys: ['arrowleft', 'arrowup', 'arrowdown', 'arrowright'], label: 'Move selected entities', shownAs: { mac: ['←↑↓→'], other: ['←↑↓→'] }, group: 'selection', order: 60, scope: 'canvas', repeat: true, run: move(MOVE_STEP) }),
    registry.register({ id: 'move-far', keys: ['shift+arrowleft', 'shift+arrowup', 'shift+arrowdown', 'shift+arrowright'], label: 'Move by 50', shownAs: { mac: ['⇧←↑↓→'], other: ['Shift+←↑↓→'] }, group: 'selection', order: 70, scope: 'canvas', repeat: true, run: move(MOVE_STEP_FAR) }),
    registry.register({ id: 'walk-add', keys: ['shift+enter', 'shift+space'], label: 'Add to the selection', group: 'selection', order: 110, scope: 'canvas', when: walking, run: (context) => walkSelect(context, true) }),
    registry.register({
      id: 'expand',
      keys: ['e'],
      label: 'Expand',
      group: 'selection',
      order: 40,
      scope: 'workspace',
      when: ({ state }) => state.presentation.view.getState().openMenu === undefined && selectedNodes(state.presentation.view.getState().selection).length === 1,
      run: ({ state, expansion }) => {
        const [key] = selectedNodes(state.presentation.view.getState().selection);
        if (key !== undefined) expansion?.expandNode(key);
      },
    }),
    registry.register({
      id: 'focus',
      keys: ['f'],
      label: 'Focus',
      group: 'selection',
      order: 50,
      scope: 'workspace',
      when: ({ state }) => state.presentation.view.getState().openMenu === undefined && focusKeyAction(state) !== undefined,
      run: ({ state, canvas }) => runFocusKey(state, canvas),
    }),
    registry.register({
      id: 'pin',
      keys: ['p'],
      label: 'Pin position',
      group: 'actions',
      order: 10,
      scope: 'workspace',
      when: ({ state }) => state.presentation.view.getState().openMenu === undefined && selectedEntities(state).length > 0,
      run: ({ state }) => togglePin(state, selectedEntities(state)),
    }),
    registry.register({
      id: 'hide',
      keys: ['delete', 'backspace'],
      label: 'Hide',
      shownAs: { mac: ['⌫'], other: ['Del'] },
      group: 'actions',
      order: 20,
      scope: 'workspace',
      when: ({ state }) => state.presentation.view.getState().openMenu === undefined && selectedEntities(state).length > 0,
      run: ({ state }) => hideEntities(state, selectedEntities(state)),
    }),
    registry.register({
      id: 'shortcuts',
      keys: ['mod+/'],
      label: 'Keyboard shortcuts',
      group: 'view',
      order: 20,
      scope: 'app',
      run: ({ state }) => state.presentation.setSheetOpen(!state.presentation.view.getState().sheetOpen),
    }),
    registry.register({
      id: 'fit',
      keys: ['mod+0'],
      label: 'Fit to view',
      group: 'view',
      order: 10,
      scope: 'workspace',
      run: ({ canvas }) => canvas?.fit(),
    }),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}
