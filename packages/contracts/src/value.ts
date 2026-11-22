import type { FilterKind } from './expand.js';
import { momentKey } from './moment-key.js';

/** The data classes a rule's value can have: the kinds a mapping can declare for a property. */
export type StyleValueClass = FilterKind;

export interface StyleValue {
  readonly class: StyleValueClass;
  readonly value: string | number | boolean;
}

const ORDERED_CLASSES: readonly StyleValueClass[] = ['number', 'date', 'dateTime', 'localDateTime', 'time', 'localTime'];

export const isOrdered = (valueClass: StyleValueClass): boolean => ORDERED_CLASSES.includes(valueClass);

interface Decimal {
  readonly negative: boolean;
  readonly integer: string;
  readonly fraction: string;
}

/** The decimal text a bound or a stored value is written in: an optional sign, digits and an optional fraction; no exponent, no separator, any length. */
export const DECIMAL_TEXT = /^[+-]?\d+(?:\.\d+)?$/;

export const isDecimalText = (text: string): boolean => DECIMAL_TEXT.test(text);

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** A number written as text or held as a JavaScript number, as sign, integer digits and fraction digits with no leading or trailing zero, or nothing when it is not a finite decimal. */
function decimalOf(value: unknown): Decimal | undefined {
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  const text = typeof value === 'number' ? (Number.isInteger(value) && Math.abs(value) < 1e21 ? BigInt(value).toString() : String(value)) : value;
  if (typeof text !== 'string') return undefined;
  const match = DECIMAL.exec(text.trim());
  if (match === null) return undefined;
  const [, sign = '', whole = '', part = '', exponentText = '0'] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) return undefined;
  let digits = `${whole}${part}`;
  let point = whole.length + exponent;
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  } else if (point > digits.length) {
    digits += '0'.repeat(point - digits.length);
  }
  const integer = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  const fraction = digits.slice(point).replace(/0+$/, '');
  const zero = integer === '0' && fraction === '';
  return { negative: sign === '-' && !zero, integer, fraction };
}

function compareDecimals(left: Decimal, right: Decimal): -1 | 0 | 1 {
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const by = (a: string, b: string): -1 | 0 | 1 => (a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length < b.length ? -1 : 1);
  let magnitude = by(left.integer, right.integer);
  if (magnitude === 0) {
    const width = Math.max(left.fraction.length, right.fraction.length);
    magnitude = by(left.fraction.padEnd(width, '0'), right.fraction.padEnd(width, '0'));
  }
  if (!left.negative || magnitude === 0) return magnitude;
  return magnitude === 1 ? -1 : 1;
}

const order = <T extends bigint | string>(left: T, right: T): -1 | 0 | 1 => (left < right ? -1 : left > right ? 1 : 0);

/**
 * How a node's value of a data class compares with a rule's value: -1, 0 or 1, or nothing when the two cannot be compared (another data class, or a value that cannot be read), which is never a match.
 * Numbers compare by numeric value whatever their text (an integer beyond 2^53 is exact), a `dateTime` and a zoned `time` as instants, and the local kinds by a key with the fraction padded to nine digits.
 */
export function compareStyleValue(rule: StyleValue, valueClass: string, value: unknown): -1 | 0 | 1 | undefined {
  if (valueClass !== rule.class) return undefined;
  switch (rule.class) {
    case 'text':
      return typeof value === 'string' ? order(value, String(rule.value)) : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? (value === rule.value ? 0 : value ? 1 : -1) : undefined;
    case 'number': {
      const left = decimalOf(value);
      const right = decimalOf(rule.value);
      return left === undefined || right === undefined ? undefined : compareDecimals(left, right);
    }
    default: {
      if (typeof value !== 'string' || typeof rule.value !== 'string') return undefined;
      const left = momentKey(rule.class, value);
      const right = momentKey(rule.class, rule.value);
      if (left === undefined || right === undefined) return undefined;
      return typeof left === 'bigint' && typeof right === 'bigint' ? order(left, right) : typeof left === 'string' && typeof right === 'string' ? order(left, right) : undefined;
    }
  }
}

/** A number, held as a JavaScript number or written as text, as its one canonical decimal text (the expanded decimal: never an exponent, no leading zero, no trailing fraction zero), or nothing when it is not a finite decimal. */
export function canonicalNumberText(value: unknown): string | undefined {
  const decimal = decimalOf(value);
  if (decimal === undefined) return undefined;
  return `${decimal.negative ? '-' : ''}${decimal.integer}${decimal.fraction === '' ? '' : `.${decimal.fraction}`}`;
}

/** How a number compares with another, each a JavaScript number or decimal text; nothing when either is not a finite decimal. */
export function compareNumbers(left: unknown, right: unknown): -1 | 0 | 1 | undefined {
  const a = decimalOf(left);
  const b = decimalOf(right);
  return a === undefined || b === undefined ? undefined : compareDecimals(a, b);
}
