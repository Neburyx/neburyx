import type { Count } from '@neburyx/contracts';

export const MEMBERS = 'members';

export const unknownCount = (scope: string): Count => ({ quality: 'unknown', scope });

/**
 * A count of the given quality, or `unknown` with no value when the value is not a non-negative safe integer (a driver integer beyond the safe range, a fraction,
 * `NaN`, a negative, nothing). `estimated` is built only by a caller that says so; there is no arithmetic on counts here.
 */
export function countOf(value: unknown, quality: Exclude<Count['quality'], 'unknown'>, scope: string): Count {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? { value, quality, scope } : unknownCount(scope);
}
