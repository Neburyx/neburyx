import { COVERAGE_SCOPE, type Count, type CoverageEntity, type DegreePreview } from '@neburyx/contracts';

export interface CoveragePart {
  readonly preview: DegreePreview | undefined;
  readonly loadedRelationships: number;
  readonly loadedQuality: CoverageEntity['loadedQuality'];
}

type Quality = Count['quality'];

interface Remainder {
  readonly value: number;
  readonly quality: Quality;
  readonly clamped: boolean;
  readonly loadedExact: boolean;
}

const UNKNOWN: Count = { quality: 'unknown', scope: COVERAGE_SCOPE };

function remainderOf(part: CoveragePart): Remainder | undefined {
  const total = part.preview?.total;
  if (total?.value === undefined || total.quality === 'unknown' || part.loadedQuality === 'unknown') return undefined;
  const clamped = part.loadedRelationships > total.value;
  return { value: clamped ? 0 : total.value - part.loadedRelationships, quality: total.quality, clamped, loadedExact: part.loadedQuality === 'exact' };
}

const lowerBoundOf = (floors: readonly number[]): Count => {
  const floor = Math.max(0, ...floors);
  return floor > 0 ? { value: floor, quality: 'lowerBound', scope: COVERAGE_SCOPE } : UNKNOWN;
};

const isFloor = (remainder: Remainder): boolean => (remainder.quality === 'exact' || remainder.quality === 'lowerBound') && !remainder.clamped && remainder.loadedExact;

/**
 * The cached totals less what is loaded, summed. A relationship between two loaded entities is in both totals and a neighbor can be shared, so only one entity with anything left is `exact`. Any `lowerBound`
 * total makes the result `lowerBound`, and its floor is the largest single `exact` or `lowerBound` remainder, since a sum may count twice. With an entity that has no preview the sum is not known, but the largest
 * such remainder is still a floor; with none above 0 it is `unknown`. More loaded than a total means the preview is older: remainder 0, at best `estimated`. A loaded count resting on an `estimated` member count makes its remainder at best `estimated` and no floor; one resting on a lower bound or an unknown member count leaves the remainder unknown.
 */
export function notRetrievedOf(parts: readonly CoveragePart[]): Count {
  const remainders: Remainder[] = [];
  let anyUnknown = false;
  for (const part of parts) {
    const remainder = remainderOf(part);
    if (remainder === undefined) anyUnknown = true;
    else remainders.push(remainder);
  }
  const floors = remainders.filter(isFloor).map((remainder) => remainder.value);
  if (anyUnknown) return lowerBoundOf(floors);
  if (remainders.some((remainder) => remainder.quality === 'lowerBound')) return { value: Math.max(0, ...floors), quality: 'lowerBound', scope: COVERAGE_SCOPE };
  const sum = remainders.reduce((total, remainder) => total + remainder.value, 0);
  if (!Number.isSafeInteger(sum)) return UNKNOWN;
  const contributors = remainders.filter((remainder) => remainder.value > 0).length;
  const weakened = contributors > 1 || remainders.some((remainder) => remainder.quality === 'estimated' || remainder.clamped || !remainder.loadedExact);
  return { value: sum, quality: weakened ? 'estimated' : 'exact', scope: COVERAGE_SCOPE };
}
