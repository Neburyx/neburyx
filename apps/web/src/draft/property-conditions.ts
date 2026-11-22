import type { QueryContextDocument } from '@neburyx/contracts';
import { isRangeKind, type PropertyCondition } from '../state/property-filter.js';
import type { MappedTypes } from '../state/presentation-state.js';

type StoredFilter = QueryContextDocument['filters']['properties'][number];

/** Whether the condition is on a personal-data property of its entity type: such a filter is never written. */
function personal(condition: PropertyCondition, mapped: MappedTypes | undefined): boolean {
  return condition.on === 'entity' && (mapped?.properties?.entity[condition.type]?.pii.includes(condition.property) ?? false);
}

/** A condition as the draft stores it: the type it applies to, its kind and its values or bounds, and never a value of any item. */
function storedOf(condition: PropertyCondition): StoredFilter {
  const identity = { on: condition.on, type: condition.type, key: condition.property, kind: condition.kind };
  if (condition.op === 'in') return { ...identity, op: 'in', values: [...condition.values] };
  return { ...identity, op: 'between', values: [], ...(condition.from === undefined ? {} : { from: condition.from }), ...(condition.to === undefined ? {} : { to: condition.to }) };
}

/** The property filters of the view as the draft stores them, without one on a personal-data property of its type. */
export function storedPropertyFilters(conditions: readonly PropertyCondition[], mapped: MappedTypes | undefined): StoredFilter[] {
  return conditions.filter((condition) => !personal(condition, mapped)).map(storedOf);
}

/** A stored property filter as a condition of the view, or nothing when it is not of the shape the web writes (it names its type and kind and holds what its operator needs). */
export function conditionOf(entry: StoredFilter): PropertyCondition | undefined {
  const { on, type, kind, key } = entry;
  if (on === undefined || type === undefined || kind === undefined) return undefined;
  const target = { on, type, property: key };
  if (entry.op === 'in' && (kind === 'text' || kind === 'boolean' || kind === 'number')) return { ...target, kind, op: 'in', values: [...entry.values] };
  if (entry.op === 'between' && isRangeKind(kind)) return { ...target, kind, op: 'between', from: entry.from, to: entry.to };
  return undefined;
}
