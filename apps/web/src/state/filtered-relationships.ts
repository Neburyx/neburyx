import type { GraphEdge } from '@neburyx/contracts';
import { edgeKey, elementKey } from './keys.js';
import type { LoadedGraph } from './loaded-graph.js';
import type { TypeFilter } from './presentation-state.js';
import { satisfies, type PropertyCondition } from './property-filter.js';
import { timeFilteredOf, type TimeFiltered } from './time-window.js';

/** What the relationship filters (the time window and the property conditions on relationship types) leave out of the loaded graph. */
export interface FilteredRelationships extends TimeFiltered {
  /** The loaded relationships of a type with a property condition that carry no properties to judge (derived and aggregate ones); they stay shown. */
  readonly unjudged: number;
}

const propertyOf = (edge: GraphEdge, key: string) => edge.properties.find((property) => property.key === key);

/** A derived relationship and an aggregate relationship carry no properties of a mapping row, so a property condition does not judge them. */
const judged = (edge: GraphEdge): boolean => edge.semantics !== 'derived' && !('aggregate' in edge.ref);

const plains = new WeakMap<TimeFiltered, FilteredRelationships>();
function plain(time: TimeFiltered): FilteredRelationships {
  let known = plains.get(time);
  if (known === undefined) {
    known = { ...time, unjudged: 0 };
    plains.set(time, known);
  }
  return known;
}

const cache = new WeakMap<LoadedGraph, WeakMap<readonly PropertyCondition[], { readonly time: TimeFiltered; readonly value: FilteredRelationships }>>();

/**
 * The relationships filtered out by the time window and by the property conditions on their type together, and the entities left with no shown relationship: one derivation for every part of the page that draws or counts the graph.
 * The same graph, filter and UTC day give the same object.
 */
export function filteredRelationshipsOf(graph: LoadedGraph, filter: Pick<TypeFilter, 'time' | 'properties'>, now: Date = new Date()): FilteredRelationships {
  const time = timeFilteredOf(graph, filter.time, now);
  const conditions = filter.properties.filter((condition) => condition.on === 'relationship');
  if (conditions.length === 0) return plain(time);
  let byConditions = cache.get(graph);
  if (byConditions === undefined) {
    byConditions = new WeakMap();
    cache.set(graph, byConditions);
  }
  const known = byConditions.get(filter.properties);
  if (known !== undefined && known.time === time) return known.value;
  const value = derive(graph, time, conditions);
  byConditions.set(filter.properties, { time, value });
  return value;
}

function derive(graph: LoadedGraph, time: TimeFiltered, conditions: readonly PropertyCondition[]): FilteredRelationships {
  const types = new Set(conditions.map((condition) => condition.type));
  const out = new Set(time.relationships);
  let unjudged = 0;
  for (const edge of graph.edges) {
    if (!types.has(edge.type)) continue;
    if (!judged(edge)) {
      unjudged += 1;
      continue;
    }
    if (conditions.some((condition) => condition.type === edge.type && !satisfies(condition, propertyOf(edge, condition.property)))) out.add(edgeKey(edge.ref));
  }
  const touching = new Map<string, { shown: number; total: number }>();
  const count = (key: string, gone: boolean): void => {
    const held = touching.get(key) ?? { shown: 0, total: 0 };
    held.total += 1;
    if (!gone) held.shown += 1;
    touching.set(key, held);
  };
  for (const edge of graph.edges) {
    const gone = out.has(edgeKey(edge.ref));
    count(elementKey(edge.from), gone);
    count(elementKey(edge.to), gone);
  }
  const entities = new Set(graph.nodes.map((node) => elementKey(node.ref)).filter((key) => {
    const held = touching.get(key);
    return held !== undefined && held.total > 0 && held.shown === 0;
  }));
  return { relationships: out, entities, undated: time.undated, unjudged };
}
