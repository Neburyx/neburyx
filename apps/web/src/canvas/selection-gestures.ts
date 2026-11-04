import type { PointerTool } from '../state/presentation-state.js';

/** A press and release in one place: on a drawn item (its key) or on empty canvas, with or without Shift. */
export interface Click {
  readonly target: string | undefined;
  readonly shift: boolean;
}

/** The selection a click leads to, or undefined when it leaves the selection as it is (the matrix of the pointer modes). */
export function selectionAfterClick(tool: PointerTool, selection: ReadonlySet<string>, click: Click): readonly string[] | undefined {
  if (tool === 'pan') return undefined;
  const { target, shift } = click;
  if (target === undefined) return shift || selection.size === 0 ? undefined : [];
  if (!shift) return selection.size === 1 && selection.has(target) ? undefined : [target];
  return selection.has(target) ? [...selection].filter((key) => key !== target) : [...selection, target];
}
