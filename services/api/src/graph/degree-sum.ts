import type { Count } from '@neburyx/contracts';

const QUALITY_RANK: Readonly<Record<Count['quality'], number>> = { exact: 0, estimated: 1, lowerBound: 2, unknown: 3 };

/** The sum of counts with the weakest quality of its parts; unknown, with no value, when a part is unknown or the sum would pass the largest safe integer. */
export function sumOf(counts: readonly Count[], scope: string): Count {
  let total = 0;
  let quality: Count['quality'] = 'exact';
  for (const count of counts) {
    if (count.value === undefined) return { quality: 'unknown', scope };
    total += count.value;
    if (QUALITY_RANK[count.quality] > QUALITY_RANK[quality]) quality = count.quality;
  }
  return Number.isSafeInteger(total) ? { value: total, quality, scope } : { quality: 'unknown', scope };
}
