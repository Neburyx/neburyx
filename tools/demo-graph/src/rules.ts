import type { Rng } from './rng.js';

export type Scalar = string | number | boolean;
export type Value = Scalar | { readonly $int: string } | { readonly $date: string } | { readonly $datetime: string };

export type Rule =
  | { readonly kind: 'constant'; readonly value: Scalar }
  | { readonly kind: 'sequence'; readonly prefix: string; readonly width: number; readonly start: number; readonly missing: number }
  | { readonly kind: 'choice'; readonly values: readonly Scalar[]; readonly cumulative: readonly number[] | undefined; readonly missing: number }
  | { readonly kind: 'int'; readonly min: bigint; readonly max: bigint; readonly missing: number }
  | { readonly kind: 'decimal'; readonly low: number; readonly high: number; readonly places: number; readonly missing: number }
  | { readonly kind: 'date'; readonly fromDay: number; readonly toDay: number; readonly missing: number }
  | { readonly kind: 'datetime'; readonly fromSecond: number; readonly toSecond: number; readonly missing: number }
  | { readonly kind: 'join'; readonly parts: readonly Rule[]; readonly missing: number }
  | { readonly kind: 'cycle'; readonly values: readonly Scalar[]; readonly every: number; readonly missing: number }
  | { readonly kind: 'byIndex'; readonly fallback: Rule | undefined; readonly ranges: readonly { readonly from: number; readonly to: number; readonly rule: Rule }[]; readonly missing: number };

export interface Context {
  readonly index: number;
  readonly rng: Rng;
}

const DAY_MS = 86_400_000;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function isoDay(days: number): string {
  const date = new Date(days * DAY_MS);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

export function isoDateTime(seconds: number): string {
  return `${isoDay(Math.floor(seconds / 86_400))}T${new Date(seconds * 1000).toISOString().slice(11, 19)}Z`;
}

function text(value: Value | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'object') return '$int' in value ? value.$int : '$date' in value ? value.$date : value.$datetime;
  return String(value);
}

export function evaluate(rule: Rule, context: Context): Value | undefined {
  if (rule.kind === 'constant') return rule.value;
  if (rule.missing > 0 && context.rng.next() < rule.missing) return undefined;
  switch (rule.kind) {
    case 'sequence':
      return `${rule.prefix}${pad(rule.start + context.index, rule.width)}`;
    case 'choice': {
      if (rule.cumulative === undefined) return rule.values[context.rng.between(0, rule.values.length - 1)];
      const point = context.rng.next() * (rule.cumulative.at(-1) ?? 1);
      const found = rule.cumulative.findIndex((limit) => point < limit);
      return rule.values[found < 0 ? rule.values.length - 1 : found];
    }
    case 'int':
      return { $int: context.rng.bigBetween(rule.min, rule.max).toString() };
    case 'decimal':
      return context.rng.between(rule.low, rule.high) / 10 ** rule.places;
    case 'date':
      return { $date: isoDay(context.rng.between(rule.fromDay, rule.toDay)) };
    case 'datetime':
      return { $datetime: isoDateTime(context.rng.between(rule.fromSecond, rule.toSecond)) };
    case 'join':
      return rule.parts.map((part) => text(evaluate(part, context))).join('');
    case 'cycle':
      return rule.values[Math.floor(context.index / rule.every) % rule.values.length];
    case 'byIndex': {
      const inside = rule.ranges.find((range) => context.index >= range.from && context.index < range.to);
      const chosen = inside?.rule ?? rule.fallback;
      return chosen === undefined ? undefined : evaluate(chosen, context);
    }
    default:
      return unhandled(rule);
  }
}

function unhandled(rule: never): never {
  throw new Error('a rule kind is not handled');
}

export function isIdentifierRule(rule: Rule): boolean {
  if (rule.kind === 'sequence') return rule.missing === 0;
  if (rule.kind !== 'join' || rule.missing > 0) return false;
  const sequences = rule.parts.filter((part) => part.kind === 'sequence');
  return sequences.length === 1 && sequences.every((part) => isIdentifierRule(part)) && rule.parts.every((part) => part.kind === 'constant' || part.kind === 'sequence');
}
