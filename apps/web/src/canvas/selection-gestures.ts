import type { PointerTool } from '../state/presentation-state.js';
import type { Platform } from '../workspace/key-spec.js';

/** A press and release in one place: on a drawn item (its key) or on empty canvas, with or without Shift or the platform's toggle modifier (⌘ on a Mac, Ctrl elsewhere). */
export interface Click {
  readonly target: string | undefined;
  readonly shift: boolean;
  /** Set when the toggle modifier was held: the click then adds or removes the item, as Shift does. */
  readonly toggle?: boolean;
}

export type ClickModifier = 'toggle' | 'menu' | 'none';

/**
 * What the modifiers held on a click mean. ⌘ toggles on a Mac and Ctrl toggles elsewhere. On a Mac a click with Ctrl held (⌘ or not) is the system's right-click and asks for the menu;
 * off a Mac Meta means nothing and Ctrl with Meta is not a toggle.
 */
export function modifierOf(held: { readonly metaKey: boolean; readonly ctrlKey: boolean }, platform: Platform): ClickModifier {
  if (platform === 'mac') return held.ctrlKey ? 'menu' : held.metaKey ? 'toggle' : 'none';
  return held.ctrlKey && !held.metaKey ? 'toggle' : 'none';
}

/** The selection a click leads to, or undefined when it leaves the selection as it is (the matrix of the pointer modes). */
export function selectionAfterClick(tool: PointerTool, selection: ReadonlySet<string>, click: Click): readonly string[] | undefined {
  if (tool === 'pan') return undefined;
  const { target } = click;
  const additive = click.shift || click.toggle === true;
  if (target === undefined) return additive || selection.size === 0 ? undefined : [];
  if (!additive) return selection.size === 1 && selection.has(target) ? undefined : [target];
  return selection.has(target) ? [...selection].filter((key) => key !== target) : [...selection, target];
}
