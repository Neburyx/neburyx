import type { DroppedFilter, LayoutDocument, QueryContextDocument, UnmappedItems } from '@neburyx/contracts';
import { entityProjection } from '../mapping/projection.js';
import type { SourceModel } from '../mapping/model.js';

type Edge = LayoutDocument['edges'][number] | QueryContextDocument['loaded']['edges'][number];

const edgeEntryOf = (edge: Edge): UnmappedItems['edges'][number] => ({
  t: edge.t,
  from: edge.from,
  to: edge.to,
  ...(edge.id === undefined ? {} : { id: edge.id }),
  ...(edge.ruleId === undefined ? {} : { ruleId: edge.ruleId }),
});

/**
 * The items of a draft that the current mapping does not cover: a node whose entity type is not mapped, and a relationship whose type is not mapped, a derived one whose rule is not,
 * and one with an end whose entity type is not. Decided from the mapping alone; the source is not read. Each item is listed once, whichever document holds it.
 */
export function unmappedItemsOf(source: SourceModel, layout: LayoutDocument, queryContext: QueryContextDocument): UnmappedItems {
  const entityTypes = new Set(source.entities.map((entity) => entity.type));
  const relationshipTypes = new Set(source.relationships.map((relationship) => relationship.type));
  const rules = new Set(source.derived.map((rule) => rule.id));

  const nodes = new Map<string, UnmappedItems['nodes'][number]>();
  for (const node of [...layout.nodes, ...queryContext.loaded.nodes]) {
    if (!entityTypes.has(node.t)) nodes.set(JSON.stringify([node.t, node.id]), { t: node.t, id: node.id });
  }

  const edges = new Map<string, UnmappedItems['edges'][number]>();
  for (const edge of [...layout.edges, ...queryContext.loaded.edges]) {
    const covered = (edge.ruleId === undefined ? relationshipTypes.has(edge.t) : rules.has(edge.ruleId)) && entityTypes.has(edge.from.t) && entityTypes.has(edge.to.t);
    if (!covered) edges.set(JSON.stringify([edge.t, edge.from, edge.to, edge.id ?? null, edge.ruleId ?? null]), edgeEntryOf(edge));
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * The saved property filters the current mapping no longer supports, each with the one reason that comes first: no entity type has the property, the property is now personal data, or no entity type
 * lists it as filterable. A property filter names no entity type, so the reasons are judged over all the entity types of the source. A type filter is kept as saved, so a type that is mapped again has the state it had.
 */
export function droppedFiltersOf(source: SourceModel, filters: QueryContextDocument['filters']): DroppedFilter[] {
  const projected = new Set(source.entities.flatMap((entity) => entityProjection(entity)));
  const personal = new Set(source.entities.flatMap((entity) => entity.pii));
  const filterable = new Set(source.entities.flatMap((entity) => entity.filterable));

  const dropped: DroppedFilter[] = [];
  for (const { key } of filters.properties) {
    if (!projected.has(key)) dropped.push({ name: key, reason: 'property-removed' });
    else if (personal.has(key)) dropped.push({ name: key, reason: 'now-personal' });
    else if (!filterable.has(key)) dropped.push({ name: key, reason: 'not-filterable' });
  }
  return dropped;
}

export function withoutDropped(queryContext: QueryContextDocument, dropped: readonly DroppedFilter[]): QueryContextDocument {
  const names = new Set(dropped.map((filter) => filter.name));
  return { ...queryContext, filters: { ...queryContext.filters, properties: queryContext.filters.properties.filter((filter) => !names.has(filter.key)) } };
}
