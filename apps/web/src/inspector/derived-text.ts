import type { Count } from '@neburyx/contracts';
import { formatNumber } from '../workspace/scope-text.js';
import { RULE_DERIVED } from './copy.js';

/** A rule-derived count as the Overview says it: "1 · rule-derived" when exact, "≥ 25 · rule-derived · lower bound" when capped, and no number when the count has none. */
export function derivedCountText(count: Count): string {
  if (count.value === undefined || count.quality === 'unknown') return `no count · ${RULE_DERIVED}`;
  const number = formatNumber(count.value);
  switch (count.quality) {
    case 'exact':
      return `${number} · ${RULE_DERIVED}`;
    case 'lowerBound':
      return `≥ ${number} · ${RULE_DERIVED} · lower bound`;
    case 'estimated':
      return `~ ${number} (estimated) · ${RULE_DERIVED}`;
    default: {
      const unreachable: never = count.quality;
      return unreachable;
    }
  }
}

/** What **Show** loads: the count's number, so that a capped row says it loads the cap's worth; nothing to say for an exact one. */
export function showLabel(count: Count): string {
  return count.quality === 'lowerBound' && count.value !== undefined ? `Show ${formatNumber(count.value)}` : 'Show';
}
