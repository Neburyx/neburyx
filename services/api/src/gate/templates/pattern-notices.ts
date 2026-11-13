import type { Count, TemplateRunNotice } from '@neburyx/contracts';
import type { NormalizedPattern } from '../normalize/pattern.js';
import type { PatternRequest } from './pattern-request.js';

/**
 * The notices a pattern run reports, from what the read raised and what the request asked: an entity left out because it is on a stop-list or has too many relationships, a read that hit a bound, a window that applies and leaves
 * out the relationships with no time, and a window that does not apply to some relationship types (each listed once). A run through more than one step with no stop-list for the entities between says so.
 */
export function patternNoticesOf(item: Pick<NormalizedPattern, 'stopListed' | 'supernodes' | 'bounded'>, request: PatternRequest): TemplateRunNotice[] {
  return [
    ...(item.stopListed ? [{ code: 'stopListSkipped' as const }] : []),
    ...(request.steps.length > 1 && request.stopListed.size === 0 ? [{ code: 'noStopList' as const }] : []),
    ...(request.windowApplied ? [{ code: 'undatedExcluded' as const }] : []),
    ...(request.windowed && request.untimedTypes.length > 0 ? [{ code: 'windowNotApplied' as const, relationshipTypes: [...request.untimedTypes] }] : []),
    ...(item.supernodes.length > 0 ? [{ code: 'supernodesSkipped' as const, entities: [...item.supernodes] }] : []),
    ...(item.bounded ? [{ code: 'readBounded' as const }] : []),
  ];
}

/** How the count of a pattern run is labelled: exact only when nothing bounded or skipped in the read and the page was not cut; otherwise a lower bound, since the entities behind a bound or a skipped entity were not read. */
export function patternCountQualityOf(item: Pick<NormalizedPattern, 'stopListed' | 'supernodes' | 'bounded'>, hasMore: boolean): Count['quality'] {
  return hasMore || item.bounded || item.supernodes.length > 0 || item.stopListed ? 'lowerBound' : 'exact';
}
