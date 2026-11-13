import type { Count, TemplateRunNotice } from '@neburyx/contracts';
import { isNormalizedSharedCount } from '../gate/normalize/shared-attribute-count.js';
import { isNormalizedLinkedCount } from '../gate/normalize/linked-entities-count.js';
import { LINKED_ENTITIES_ID } from '../gate/templates/linked-entities.js';
import { LINKED_ENTITIES_COUNT_ID } from '../gate/templates/linked-entities-count.js';
import { linkedEntitiesRequestOf } from '../gate/templates/linked-entities-statement.js';
import { SHARED_ATTRIBUTE_ID } from '../gate/templates/shared-attribute.js';
import { SHARED_ATTRIBUTE_COUNT_ID } from '../gate/templates/shared-attribute-count.js';
import { sharedAttributeRequestOf } from '../gate/templates/shared-attribute-statement.js';
import type { Params, SourceAllowlist } from '../gate/types.js';

/** What a probe read, in the terms the service needs: the matches counted (at most the count cap plus one) and the flags that make the estimate a lower bound or add a notice. */
export interface ProbeRead {
  readonly anchorFound: boolean;
  readonly usable: boolean;
  readonly matches: number;
  /** Whether a bound of the read (the anchor's attribute nodes, or the frontier) was reached, so that some matches were not read. */
  readonly bounded: boolean;
  readonly notices: readonly TemplateRunNotice[];
}

/**
 * The estimate of a probe read, labelled (TAS §8.1): more matches than the threshold (the probe reads one more than the source's count cap, which is the threshold) is a lower bound at the threshold and makes the run heavy; at most the
 * threshold is `exact`, unless a bound of the read was reached, which makes it a lower bound with the value counted and no warning.
 */
export function estimateOf(read: Pick<ProbeRead, 'matches' | 'bounded'>, threshold: number, scope: string): { readonly estimate: Count; readonly heavy: boolean } {
  if (read.matches > threshold) return { estimate: { value: threshold, quality: 'lowerBound', scope }, heavy: true };
  return { estimate: { value: read.matches, quality: read.bounded ? 'lowerBound' : 'exact', scope }, heavy: false };
}

/** The heavy-operation probe of one pattern template (TAS §8.1): the count template the service runs first, and how to read its answer. A template with no probe has an `unknown` estimate and runs with no warning. */
export interface TemplateProbe {
  readonly templateId: string;
  read(item: unknown, params: Params, allowlist: SourceAllowlist): ProbeRead | undefined;
}

const sharedAttributeProbe: TemplateProbe = {
  templateId: SHARED_ATTRIBUTE_COUNT_ID,
  read(item, params, allowlist) {
    if (!isNormalizedSharedCount(item)) return undefined;
    const request = sharedAttributeRequestOf(allowlist, params);
    const notices: TemplateRunNotice[] = [
      ...(item.skipped ? [{ code: 'stopListSkipped' as const }] : []),
      ...(request.stopListProperties.length === 0 ? [{ code: 'noStopList' as const }] : []),
      ...(request.windowed ? [{ code: 'undatedExcluded' as const }] : []),
      ...(item.anchorBounded ? [{ code: 'readBounded' as const }] : []),
    ];
    return { anchorFound: item.anchorFound, usable: item.usable, matches: item.matches, bounded: item.anchorBounded, notices };
  },
};

const linkedEntitiesProbe: TemplateProbe = {
  templateId: LINKED_ENTITIES_COUNT_ID,
  read(item, params, allowlist) {
    if (!isNormalizedLinkedCount(item)) return undefined;
    const request = linkedEntitiesRequestOf(allowlist, params);
    const notices: TemplateRunNotice[] = [
      ...(request.maxHops > 1 && request.stopListed.size === 0 ? [{ code: 'noStopList' as const }] : []),
      ...(request.windowed ? [{ code: 'undatedExcluded' as const }] : []),
      ...(request.windowed && request.untimedTypes.length > 0 ? [{ code: 'windowNotApplied' as const, relationshipTypes: [...request.untimedTypes] }] : []),
      ...(item.frontierBounded ? [{ code: 'readBounded' as const }] : []),
    ];
    return { anchorFound: item.anchorFound, usable: item.usable, matches: item.matches, bounded: item.frontierBounded || item.supernodeSkipped, notices };
  },
};

/** The probes of the built-in pattern templates, by template ID. */
export function defaultTemplateProbes(): ReadonlyMap<string, TemplateProbe> {
  return new Map([[SHARED_ATTRIBUTE_ID, sharedAttributeProbe], [LINKED_ENTITIES_ID, linkedEntitiesProbe]]);
}
