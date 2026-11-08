import type { DegreePreview, ElementRef } from '@neburyx/contracts';

/** What an ask would load first: the neighbor types it names and, when the person narrowed them, the relationship types. */
export interface EstimateAsk {
  readonly ref: ElementRef;
  readonly neighborTypes: readonly string[];
  readonly relTypes?: readonly string[] | undefined;
}

export type EstimateQuality = 'exact' | 'estimated' | 'lowerBound';

export interface HeavyEstimate {
  readonly value: number;
  readonly quality: EstimateQuality;
}

/** The bounded first page *Continue* offers: a fixed product value and not a source setting. */
export const BOUNDED_LIMIT = 25;

export type HeavyDecision = { readonly kind: 'none' } | { readonly kind: 'heavy'; readonly estimate: HeavyEstimate; readonly threshold: number; readonly pageSize: number };

const NONE: HeavyDecision = { kind: 'none' };

const sameNode = (preview: DegreePreview, ref: ElementRef): boolean => preview.ref.sourceId === ref.sourceId && preview.ref.entityType === ref.entityType && preview.ref.stableId === ref.stableId;

/**
 * Whether an ask is estimated above the source's warning threshold, from the degree preview already held and nothing else. The estimate is the sum of the pairs (relationship type and direction) of the asked
 * relationship types whose neighbor types are all asked; a pair that reaches a type that is not asked has an unknown share and adds nothing, and a pair whose count is unknown adds nothing. Either makes the
 * sum a floor, labelled `lowerBound`. Nothing known gives no warning. A capped bounded count is a `lowerBound` with the value of the cap, which is the threshold, so a `lowerBound` warns at the threshold
 * and an `exact` or `estimated` sum only above it.
 */
export function heavyDecision(preview: DegreePreview, ask: EstimateAsk): HeavyDecision {
  const asked = new Set(ask.neighborTypes);
  if (asked.size === 0 || !sameNode(preview, ask.ref)) return NONE;
  const narrowed = ask.relTypes !== undefined && ask.relTypes.length > 0 ? new Set(ask.relTypes) : undefined;
  let sum = 0;
  let known = false;
  let floor = false;
  let estimated = false;
  let capped = false;
  for (const pair of preview.byType) {
    if (narrowed !== undefined && !narrowed.has(pair.relationshipType)) continue;
    const reached = pair.neighborTypes.filter((type) => asked.has(type)).length;
    if (reached === 0) continue;
    if (reached < pair.neighborTypes.length || pair.count.quality === 'unknown' || pair.count.value === undefined) {
      floor = true;
      continue;
    }
    known = true;
    sum += pair.count.value;
    if (pair.count.quality === 'estimated') estimated = true;
    if (pair.count.quality === 'lowerBound') capped = true;
  }
  if (!known) return NONE;
  const quality: EstimateQuality = estimated ? 'estimated' : capped || floor ? 'lowerBound' : 'exact';
  const threshold = preview.heavyOpThreshold;
  const heavy = quality === 'lowerBound' ? sum >= threshold : sum > threshold;
  return heavy ? { kind: 'heavy', estimate: { value: sum, quality }, threshold, pageSize: preview.pageSize } : NONE;
}
