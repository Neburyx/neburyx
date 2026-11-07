import { COVERAGE_SCOPE, type Count, type DegreePreview } from '@neburyx/contracts';

export interface CoveragePart {
  readonly preview: DegreePreview | undefined;
  readonly storedRelationships: number;
}

type Quality = Count['quality'];

interface Remainder {
  readonly value: number;
  readonly quality: Quality;
  readonly clamped: boolean;
}

const UNKNOWN: Count = { quality: 'unknown', scope: COVERAGE_SCOPE };

function remainderOf(part: CoveragePart): Remainder | undefined {
  const total = part.preview?.total;
  if (total?.value === undefined || total.quality === 'unknown') return undefined;
  const clamped = part.storedRelationships > total.value;
  return { value: clamped ? 0 : total.value - part.storedRelationships, quality: total.quality, clamped };
}

/**
 * The cached totals less what is loaded, summed. A relationship between two loaded entities is in both totals and a neighbor can be shared, so only one entity with anything left is `exact`. Any `lowerBound`
 * total makes the result `lowerBound`, and its floor is the largest single `exact` or `lowerBound` remainder, since a sum may count twice. More loaded than a total means the preview is older: remainder 0, at best `estimated`.
 */
export function notRetrievedOf(parts: readonly CoveragePart[]): Count {
  const remainders: Remainder[] = [];
  for (const part of parts) {
    const remainder = remainderOf(part);
    if (remainder === undefined) return UNKNOWN;
    remainders.push(remainder);
  }
  if (remainders.some((remainder) => remainder.quality === 'lowerBound')) {
    const floor = Math.max(0, ...remainders.filter((remainder) => remainder.quality !== 'estimated' && !remainder.clamped).map((remainder) => remainder.value));
    return { value: floor, quality: 'lowerBound', scope: COVERAGE_SCOPE };
  }
  const sum = remainders.reduce((total, remainder) => total + remainder.value, 0);
  if (!Number.isSafeInteger(sum)) return UNKNOWN;
  const contributors = remainders.filter((remainder) => remainder.value > 0).length;
  const weakened = contributors > 1 || remainders.some((remainder) => remainder.quality === 'estimated' || remainder.clamped);
  return { value: sum, quality: weakened ? 'estimated' : 'exact', scope: COVERAGE_SCOPE };
}
