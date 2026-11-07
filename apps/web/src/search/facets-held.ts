import type { Facets, GraphNode, UnreferencedHit } from '@neburyx/contracts';
import { elementKey } from '../state/keys.js';

type SearchableFacets = Extract<Facets, { searchable: true }>;
type FacetCount<Scope extends string> = { readonly value: number; readonly quality: 'exact' | 'lowerBound'; readonly scope: Scope } | { readonly quality: 'unknown'; readonly scope: Scope };

function atLeast<Scope extends string>(count: FacetCount<Scope>, shown: number): FacetCount<Scope> {
  return count.quality !== 'unknown' && count.value < shown ? { value: shown, quality: 'lowerBound', scope: count.scope } : count;
}

/** The hits the groups hold on the page: those of the first page and of the pages Show more added. */
export interface HeldHits {
  readonly exact: readonly GraphNode[];
  readonly related: readonly GraphNode[];
  /** The supporting relationships held: a stored hit is one, an aggregate its members. */
  readonly evidence: number;
  /** The hits with no usable stable ID the exact and related groups hold; absent counts as none. */
  readonly unreferenced?: { readonly exact: readonly UnreferencedHit[]; readonly related: readonly UnreferencedHit[] };
}

/**
 * The facets as the Filters show them beside the groups: a count is read once, with the first page, so after Show more a group can hold more than a count that is a lower bound of the cap; such a
 * count is shown as at least the hits held, never as a number below what the page shows.
 */
export function atLeastHeld(facets: SearchableFacets, held: HeldHits): SearchableFacets {
  const distinct = (nodes: readonly GraphNode[]): number => new Set(nodes.map((node) => elementKey(node.ref))).size;
  const entities = [...held.exact, ...held.related];
  const unreferenced = held.unreferenced ?? { exact: [], related: [] };
  // an unreferenced hit has no key to tell it from another, so a type counts the larger of the two groups' numbers of them
  const unreferencedOfType = (type?: string): number => Math.max(...[unreferenced.exact, unreferenced.related].map((hits) => hits.filter((hit) => type === undefined || hit.entityType === type).length));
  const byMode = { exact: distinct(held.exact) + unreferenced.exact.length, related: distinct(held.related) + unreferenced.related.length, evidence: held.evidence };
  return {
    ...facets,
    total: atLeast(facets.total, distinct(entities) + unreferencedOfType()),
    entityType: facets.entityType.map((entry) => ({ ...entry, count: atLeast(entry.count, distinct(entities.filter((node) => node.ref.entityType === entry.entityType)) + unreferencedOfType(entry.entityType)) })),
    matchMode: facets.matchMode.map((entry) => ({ ...entry, count: atLeast(entry.count, byMode[entry.mode]) })),
  };
}
