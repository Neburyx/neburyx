import type { Count } from '@neburyx/contracts';
import { formatNumber } from './scope-text.js';

/** A degree count as the menu says it: with its quality beside the number, and no number for a count that has none. */
export function degreeCountText(count: Count): string {
  if (count.value === undefined) return 'no count';
  const number = formatNumber(count.value);
  switch (count.quality) {
    case 'exact':
      return `${number} · exact`;
    case 'estimated':
      return `~ ${number} (estimated)`;
    case 'lowerBound':
      return `≥ ${number} · lower bound`;
    case 'unknown':
      return 'no count';
    default: {
      const unreachable: never = count.quality;
      return unreachable;
    }
  }
}
