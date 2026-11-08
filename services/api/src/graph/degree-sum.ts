import type { Count } from '@neburyx/contracts';

const QUALITY_RANK: Readonly<Record<Count['quality'], number>> = { exact: 0, estimated: 1, lowerBound: 2, unknown: 3 };

/**
 * The sum of counts, with the weakest quality of its parts, and no `observedAt`: no one date describes a sum (a single part keeps its own count, date included). A sum with a `lowerBound` part stays a
 * lower bound whose value adds what each part proved, never an estimate: `floors[i]` is what the live read of an `estimated` part `i` proved (the cap), and any other part counts at its value. A
 * stale property therefore never becomes part of a floor. Unknown, with no value, when a part is unknown or the sum would pass the largest safe integer.
 */
export function sumOf(counts: readonly Count[], scope: string, floors: readonly (number | undefined)[] = []): Count {
  const only = counts.length === 1 ? counts[0] : undefined;
  if (only !== undefined) return only.value === undefined ? { quality: 'unknown', scope } : { ...only, scope };
  let total = 0;
  let proven = 0;
  let quality: Count['quality'] = 'exact';
  for (const [index, count] of counts.entries()) {
    if (count.value === undefined) return { quality: 'unknown', scope };
    total += count.value;
    proven += count.quality === 'estimated' ? (floors[index] ?? 0) : count.value;
    if (QUALITY_RANK[count.quality] > QUALITY_RANK[quality]) quality = count.quality;
  }
  const value = quality === 'lowerBound' ? proven : total;
  return Number.isSafeInteger(value) ? { value, quality, scope } : { quality: 'unknown', scope };
}
