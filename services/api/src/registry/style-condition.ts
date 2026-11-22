import type { StyleValue } from '@neburyx/contracts';
import type { StyleRuleModel } from '../mapping/model.js';

const SYMBOLS = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

/** A number written with thousands separators on its integer digits ("2,000"), its fraction as it is. */
function numberText(value: number): string {
  const [whole = '', fraction] = String(value).split('.');
  if (!/^-?\d+$/.test(whole)) return String(value);
  const digits = whole.startsWith('-') ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole.startsWith('-') ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

const valueText = (value: StyleValue): string => (typeof value.value === 'number' ? numberText(value.value) : String(value.value));

/**
 * A rule's condition in words, built from its typed condition and nothing else: `flag = on`, `size > 2,000`, `state in (open, held)`, `size between 1 and 9`.
 * It names the property the rule reads and the values the mapping gives, which is all the mapping holds of it.
 */
export function conditionText(rule: StyleRuleModel): string {
  const { property, op, values } = rule.when;
  if (op === 'in') return `${property} in (${values.map(valueText).join(', ')})`;
  if (op === 'between') return `${property} between ${valueText(values[0] as StyleValue)} and ${valueText(values[1] as StyleValue)}`;
  return `${property} ${SYMBOLS[op]} ${valueText(values[0] as StyleValue)}`;
}
