import { formatNumber } from '../workspace/scope-text.js';

/** What a screen reader is told after an expansion while focus is on and some of what it loaded is outside focus; nothing when none is. */
export function outsideFocusNote(outside: number, loaded: number): string | undefined {
  if (outside === 0) return undefined;
  return `${formatNumber(outside)} of the ${formatNumber(loaded)} ${loaded === 1 ? 'entity it loaded is' : 'entities it loaded are'} outside focus.`;
}
