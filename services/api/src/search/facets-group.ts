import { FACET_SCOPES, type Facets, type SearchMatchMode } from '@neburyx/contracts';
import type { EvidenceTarget } from '../gate/templates/search-evidence.js';
import type { FacetProbe, FacetTarget } from '../gate/templates/search-facets.js';
import type { SearchTarget } from '../gate/templates/search-template.js';
import type { GatePage } from '../gate/types.js';
import { AppError } from '../errors.js';
import type { SourceModel } from '../mapping/model.js';

/** What one probe of the facet read counts: the entities of an entity type, the matches of a match mode, or every entity matched by any target. */
export type FacetEntry = { readonly kind: 'entityType'; readonly entityType: string } | { readonly kind: 'matchMode'; readonly mode: SearchMatchMode } | { readonly kind: 'total' };

export interface FacetPlan {
  /** The probes, in the order of their counts in the read's one row. */
  readonly probes: readonly FacetProbe[];
  /** What each probe counts, by position. */
  readonly entries: readonly FacetEntry[];
}

const entityTarget = (kind: 'search' | 'reference') => (target: SearchTarget): FacetTarget => ({ kind, entityType: target.entityType, property: target.property, match: target.match });
const evidenceTarget = (target: EvidenceTarget): FacetTarget => ({ kind: 'evidence', ...target });

/**
 * The probes of a search, from the targets the groups would read (the eligible ones, after masking and the index guard, and before any selection): a probe for each entity type that has a target of
 * the exact or the related group, one for each match mode that has a target, and one for the entities matched by any entity target. No target at all gives no probe, and no read.
 */
export function planFacets(source: SourceModel, exact: readonly SearchTarget[], related: readonly SearchTarget[], evidence: readonly EvidenceTarget[]): FacetPlan {
  const probes: FacetProbe[] = [];
  const entries: FacetEntry[] = [];
  const add = (entry: FacetEntry, targets: readonly FacetTarget[]): void => {
    if (targets.length === 0) return;
    probes.push({ targets: [...targets] });
    entries.push(entry);
  };
  const exactTargets = exact.map(entityTarget('search'));
  const relatedTargets = related.map(entityTarget('reference'));
  for (const entity of source.entities) {
    add({ kind: 'entityType', entityType: entity.type }, [...exactTargets, ...relatedTargets].filter((target) => target.kind !== 'evidence' && target.entityType === entity.type));
  }
  add({ kind: 'matchMode', mode: 'exact' }, exactTargets);
  add({ kind: 'matchMode', mode: 'related' }, relatedTargets);
  add({ kind: 'matchMode', mode: 'evidence' }, evidence.map(evidenceTarget));
  add({ kind: 'total' }, [...exactTargets, ...relatedTargets]);
  return { probes, entries };
}

type Count = { readonly value: number; readonly quality: 'exact' | 'lowerBound' };

/** A probe's count is the true count up to the cap plus one: exact up to and including the cap, and a lower bound of the cap above it. */
function countOf(found: number, cap: number): Count {
  return found > cap ? { value: cap, quality: 'lowerBound' } : { value: found, quality: 'exact' };
}

function countsOf(page: GatePage): readonly number[] {
  const [item] = page.items;
  const counts = typeof item === 'object' && item !== null && 'counts' in item ? item.counts : undefined;
  if (!Array.isArray(counts) || !counts.every((count): count is number => typeof count === 'number')) throw new AppError('INTERNAL_ERROR');
  return counts;
}

/** The `facets` of an answer whose facet read failed: something to count, no count and no entry (the failure itself is named in `failures`). */
export const FAILED_FACETS: Facets = { searchable: true, total: { quality: 'unknown', scope: FACET_SCOPES.total }, entityType: [], matchMode: [] };

/** The `facets` of an answer from the page of the one facet read: `{ searchable: false }` when no probe was planned, otherwise an entry for each entity type and each match mode and the total. */
export function facetsOf(plan: FacetPlan, page: GatePage | undefined, cap: number): Facets {
  if (plan.probes.length === 0) return { searchable: false };
  if (page === undefined) throw new AppError('INTERNAL_ERROR');
  const counts = countsOf(page);
  if (counts.length !== plan.entries.length) throw new AppError('INTERNAL_ERROR');
  const entityType: Extract<Facets, { searchable: true }>['entityType'] = [];
  const matchMode: Extract<Facets, { searchable: true }>['matchMode'] = [];
  let total: Extract<Facets, { searchable: true }>['total'] | undefined;
  plan.entries.forEach((entry, index) => {
    const found = counts[index];
    if (found === undefined) throw new AppError('INTERNAL_ERROR');
    if (entry.kind === 'entityType') entityType.push({ entityType: entry.entityType, count: { ...countOf(found, cap), scope: FACET_SCOPES.entityType } });
    else if (entry.kind === 'matchMode') matchMode.push({ mode: entry.mode, count: { ...countOf(found, cap), scope: FACET_SCOPES.matchMode } });
    else total = { ...countOf(found, cap), scope: FACET_SCOPES.total };
  });
  // with no entity target nothing is matched as an entity: the total is a known zero, and the relationships of the evidence mode are not entities
  return { searchable: true, total: total ?? { value: 0, quality: 'exact', scope: FACET_SCOPES.total }, entityType, matchMode };
}
