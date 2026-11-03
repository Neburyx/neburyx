import { MeasureError } from './errors.js';

export interface FocusModel {
  current(): string | undefined;
  enter(): string;
  next(): string;
  previous(): string;
  first(): string;
  last(): string;
  activate(): string | undefined;
}

/** Focus moves between nodes in a fixed order and wraps at both ends, so it is never nowhere once the canvas has it. */
export function createFocusModel(ids: readonly string[]): FocusModel {
  const first = ids[0];
  const last = ids[ids.length - 1];
  if (first === undefined || last === undefined) throw new MeasureError('FOCUS_ORDER_EMPTY');
  let index: number | undefined;
  const at = (position: number): string => {
    index = (position + ids.length) % ids.length;
    return ids[index] ?? first;
  };
  return {
    current: () => (index === undefined ? undefined : ids[index]),
    enter: () => (index === undefined ? at(0) : (ids[index] ?? first)),
    next: () => at((index ?? -1) + 1),
    previous: () => at((index ?? 0) - 1),
    first: () => at(0),
    last: () => at(ids.length - 1),
    activate: () => (index === undefined ? undefined : ids[index]),
  };
}
