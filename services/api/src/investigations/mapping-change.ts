import { isOrdered, type DroppedFilter, type LayoutDocument, type MappingChange, type QueryContextDocument, type UnmappedItems } from '@neburyx/contracts';
import { entityProjection, relationshipProjection } from '../mapping/projection.js';
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

type PropertyFilter = QueryContextDocument['filters']['properties'][number];

/** Whether a stored property filter names its type and kind; an entry of the older shape does not, and cannot be judged against a type. */
const isTyped = (entry: PropertyFilter): boolean => entry.on !== undefined && entry.type !== undefined && entry.kind !== undefined;

const identityOf = (entry: PropertyFilter): string => JSON.stringify([entry.on ?? null, entry.type ?? null, entry.key]);
const nameOf = (entry: PropertyFilter): string => (entry.type === undefined ? entry.key : `${entry.type}.${entry.key}`);

function reasonFor(source: SourceModel, entry: PropertyFilter): DroppedFilter['reason'] | undefined {
  if (entry.on === undefined || entry.type === undefined || entry.kind === undefined) return 'property-removed';
  if (entry.on === 'entity') {
    const type = source.entities.find((candidate) => candidate.type === entry.type);
    if (type === undefined || !entityProjection(type).includes(entry.key)) return 'property-removed';
    if (type.pii.includes(entry.key)) return 'now-personal';
    if (!type.filterable.includes(entry.key)) return 'not-filterable';
    const declared = type.kinds?.[entry.key];
    if (declared !== undefined && entry.op === 'in' && isOrdered(declared)) return 'kind-changed';
    return declared !== undefined && declared !== entry.kind ? 'kind-changed' : entry.op === 'between' && declared === undefined ? 'kind-changed' : undefined;
  }
  const rows = source.relationships.filter((candidate) => candidate.type === entry.type && !candidate.aggregate);
  if (rows.length === 0 || !rows.some((row) => relationshipProjection(row).includes(entry.key))) return 'property-removed';
  const listing = rows.filter((row) => row.filterable.includes(entry.key));
  if (listing.length === 0) return 'not-filterable';
  const declared = new Set(listing.flatMap((row) => (row.kinds?.[entry.key] === undefined ? [] : [row.kinds[entry.key]])));
  if (declared.size > 1) return 'kind-changed';
  const [only] = [...declared];
  if (only !== undefined && entry.op === 'in' && isOrdered(only)) return 'kind-changed';
  return only !== undefined && only !== entry.kind ? 'kind-changed' : entry.op === 'between' && only === undefined ? 'kind-changed' : undefined;
}

/**
 * The saved property filters the current mapping no longer supports, each with the one reason that comes first: the type or the property is gone (or the entry names no type and kind), the property is now personal data, no row lists it as filterable,
 * or the kind the mapping declares is not the one stored (a range needs its kind declared; for a choice, an undeclared kind keeps any stored kind). A filter is judged against the type it names, an entity type's properties or the stored rows of a relationship type
 * (an aggregate row carries no properties), so two types with a property of one name do not mix. A type filter is kept as saved, so a type that is mapped again has the state it had.
 */
export function droppedFiltersOf(source: SourceModel, filters: QueryContextDocument['filters']): DroppedFilter[] {
  const dropped: DroppedFilter[] = [];
  for (const entry of filters.properties) {
    const reason = reasonFor(source, entry);
    if (reason !== undefined) dropped.push({ name: nameOf(entry), reason });
  }
  return dropped;
}

/**
 * The query context a reader is shown after the mapping check. When the mapping changed since the draft was written, the filters the mapping no longer supports are dropped with their reasons and reported as a change of mapping; when it did not, an entry that
 * names no type and kind (no released build writes one) is dropped without a word, since a banner saying the mapping changed would be false.
 */
export function reviewedFilters(source: SourceModel, mappingChanged: boolean, storedFilters: QueryContextDocument['filters'], queryContext: QueryContextDocument): { readonly queryContext: QueryContextDocument; readonly mappingChange?: MappingChange } {
  const withProperties = (properties: readonly PropertyFilter[]): QueryContextDocument => ({ ...queryContext, filters: { ...queryContext.filters, properties: [...properties] } });
  if (!mappingChanged) return { queryContext: withProperties(queryContext.filters.properties.filter(isTyped)) };
  const gone = new Set(storedFilters.properties.filter((entry) => reasonFor(source, entry) !== undefined).map(identityOf));
  return { queryContext: withProperties(queryContext.filters.properties.filter((entry) => !gone.has(identityOf(entry)))), mappingChange: { droppedFilters: droppedFiltersOf(source, storedFilters) } };
}
