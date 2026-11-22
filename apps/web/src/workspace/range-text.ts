import type { RangeKind } from '../state/property-filter.js';
import { PROPERTY_FILTER_COPY, PROPERTY_RANGE_COPY } from './filters-copy.js';

/** A decimal text with thousands separators put into its integer digits, never through a JavaScript number, so a value beyond 2^53 or with a long fraction is written as it is. */
export function groupThousands(text: string): string {
  const match = /^([+-]?)(\d+)(\.\d+)?$/.exec(text);
  if (match === null) return text;
  const [, sign = '', integer = '', fraction = ''] = match;
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign === '-' ? '-' : ''}${grouped}${fraction}`;
}

const shown = (kind: RangeKind, text: string): string => (kind === 'number' ? groupThousands(text) : text);

/** The closed text of a range control: "1,000–5,000", "≥ 1,000", "≤ 5,000", or "Any". */
export function rangeText(kind: RangeKind, from: string | undefined, to: string | undefined): string {
  if (from !== undefined && to !== undefined) return `${shown(kind, from)}–${shown(kind, to)}`;
  if (from !== undefined) return PROPERTY_RANGE_COPY.atLeast(shown(kind, from));
  if (to !== undefined) return PROPERTY_RANGE_COPY.atMost(shown(kind, to));
  return PROPERTY_FILTER_COPY.any;
}

export { shown as boundText };
