import type { DisabledType, GraphNode, RelationshipContext } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { propertyIndexOf } from '../gate/index-guard.js';
import type { IndexSnapshot } from '../gate/types.js';
import { isRelatedContextItem } from '../gate/templates/related-context.js';
import type { Item } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';

/** What the relationship context read is asked: the related hits and the exact matches it may pair, each at most the cap, and the types left out because the `stable_id` index of the type is not online. */
export interface ContextPlan {
  readonly hits: readonly GraphNode[];
  /** For each hit, its place in the related group, so the answer is put back on the hit it belongs to. */
  readonly hitPlaces: readonly number[];
  readonly exact: readonly Pick<GraphNode, 'ref'>[];
  readonly disabledTypes: readonly DisabledType[];
}

/**
 * The hits and exact matches the context read is made for: the first `cap` of each, without those of an entity type whose `stable_id` index is not online (the read would not be served by an index, so its
 * pairs are left out and the type is named). With no snapshot (the login cannot list indexes) nothing is left out, as for the search. A read with no hit or no exact match left is not made.
 */
export function planContext(source: SourceModel, related: readonly GraphNode[], exact: readonly Pick<GraphNode, 'ref'>[], snapshot: IndexSnapshot | undefined, cap: number): ContextPlan {
  const disabled = new Map<string, DisabledType>();
  const usable = (node: Pick<GraphNode, 'ref'>): boolean => {
    const entity = source.entities.find((candidate) => candidate.type === node.ref.entityType);
    if (entity === undefined) return false;
    if (snapshot === undefined) return true;
    const index = propertyIndexOf(snapshot, entity.label, entity.stableId, 'NODE', 'value');
    if ('gap' in index) {
      disabled.set(entity.type, { entityType: entity.type, property: entity.stableId, reason: index.gap, typeSearched: false });
      return false;
    }
    return true;
  };
  const hits = related.slice(0, cap).flatMap((node, place) => (usable(node) ? [{ node, place }] : []));
  const exacts = exact.slice(0, cap).filter(usable);
  const order = source.entities.map((entity) => entity.type);
  return { hits: hits.map((entry) => entry.node), hitPlaces: hits.map((entry) => entry.place), exact: exacts, disabledTypes: [...disabled.values()].sort((first, second) => order.indexOf(first.entityType) - order.indexOf(second.entityType)) };
}

export const contextWillRead = (plan: ContextPlan): boolean => plan.hits.length > 0 && plan.exact.length > 0;

/** The parameters of the read: the references of the hits and of the exact matches, as the answer gave them. */
export const contextParamsOf = (plan: ContextPlan): { readonly hits: readonly GraphNode['ref'][]; readonly exact: readonly GraphNode['ref'][] } => ({ hits: plan.hits.map((node) => node.ref), exact: plan.exact.map((node) => node.ref) });

/** The context of each hit that has one, by the hit's place in the related group; a row that names a position the read was not given is a defect. */
export function contextsOf(plan: ContextPlan, items: readonly Item[]): Map<number, RelationshipContext> {
  const [item] = items;
  if (!isRelatedContextItem(item)) throw new AppError('INTERNAL_ERROR');
  const found = new Map<number, RelationshipContext>();
  for (const row of item.context) {
    const place = plan.hitPlaces[row.hit];
    const exact = plan.exact[row.exact];
    if (place === undefined || exact === undefined || found.has(place)) throw new AppError('INTERNAL_ERROR');
    found.set(place, { relationshipType: row.relationshipType, direction: row.direction, with: exact.ref });
  }
  return found;
}
