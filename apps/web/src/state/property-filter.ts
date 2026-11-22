import { canonicalNumberText, compareNumbers, compareStyleValue, holdsNoNulOrLoneSurrogate, isDecimalText, momentKey, MAX_FILTER_TEXT, MAX_FILTER_VALUES, type FilterKind, type GraphNode, type GraphProperty } from '@neburyx/contracts';
import { elementKey } from './keys.js';
import type { LoadedGraph } from './loaded-graph.js';

export type ConditionOn = 'entity' | 'relationship';

/** The kinds a choice of values can be made on: the ones whose values are listed as they are loaded. */
export type ChoiceKind = Extract<FilterKind, 'text' | 'boolean' | 'number'>;

/** The kinds a range can be set on: the ordered ones. */
export type RangeKind = Exclude<FilterKind, 'text' | 'boolean'>;

interface ConditionTarget {
  readonly on: ConditionOn;
  readonly type: string;
  readonly property: string;
}

/** An item of the type matches when its value is one of the chosen ones. */
export interface ChoiceCondition extends ConditionTarget {
  readonly kind: ChoiceKind;
  readonly op: 'in';
  /** The chosen values as text: the value itself for text, `true` or `false` for a boolean, the canonical decimal text for a number. */
  readonly values: readonly string[];
}

/** An item of the type matches when its value is not below `from` and not above `to`; either end may be left out, not both. A bound is decimal text for a number and ISO text for a date or time. */
export interface RangeCondition extends ConditionTarget {
  readonly kind: RangeKind;
  readonly op: 'between';
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** One condition of the Filters panel on one property of one entity type or relationship type. */
export type PropertyCondition = ChoiceCondition | RangeCondition;

const ORDERED_KINDS: readonly string[] = ['number', 'date', 'dateTime', 'localDateTime', 'time', 'localTime'];
export const isRangeKind = (kind: string): kind is RangeKind => ORDERED_KINDS.includes(kind);

/** Whether a condition chooses nothing: no value, or no bound. */
export const isEmptyCondition = (condition: PropertyCondition): boolean => (condition.op === 'in' ? condition.values.length === 0 : condition.from === undefined && condition.to === undefined);

export function sameCondition(a: PropertyCondition, b: PropertyCondition): boolean {
  if (a.kind !== b.kind || a.op !== b.op) return false;
  if (a.op === 'in' && b.op === 'in') return a.values.length === b.values.length && a.values.every((value, at) => value === b.values[at]);
  return a.op === 'between' && b.op === 'between' && a.from === b.from && a.to === b.to;
}

/** A typed bound read as its kind: decimal text for a number (any length), the product's ISO text for a date or time; the reason when it cannot be read. */
export function readBound(kind: RangeKind, text: string): { readonly ok: true; readonly text: string } | { readonly ok: false } {
  const trimmed = text.trim();
  if (kind === 'number') return isDecimalText(trimmed) ? { ok: true, text: trimmed } : { ok: false };
  return momentKey(kind, trimmed) === undefined ? { ok: false } : { ok: true, text: trimmed };
}

/** Whether `from` is later than `to`, which no value can satisfy. */
export const bounded = (kind: RangeKind, from: string, to: string): boolean => (compareStyleValue({ class: kind, value: from }, kind, to) ?? 0) < 0;

export const NO_CONDITIONS: readonly PropertyCondition[] = [];

/** The most values one condition may choose (the limit of an `in` condition of an expansion). */
export const MAX_CHOSEN_VALUES = MAX_FILTER_VALUES;

export const conditionKey = (condition: Pick<PropertyCondition, 'on' | 'type' | 'property'>): string => JSON.stringify([condition.on, condition.type, condition.property]);

/** A loaded value as the text a choice lists and a condition stores; nothing for a masked value, one a choice cannot be made on, or a text the stored document would refuse (empty, over 256 characters, a NUL or a lone surrogate). */
export function choiceTextOf(property: GraphProperty | undefined): string | undefined {
  if (property === undefined || property.masked) return undefined;
  const { value } = property;
  switch (property.dataClass) {
    case 'text':
      return typeof value === 'string' && value.length > 0 && value.length <= MAX_FILTER_TEXT && holdsNoNulOrLoneSurrogate(value) ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : undefined;
    case 'number':
      return canonicalNumberText(value);
    default:
      return undefined;
  }
}

/** Whether an item's property satisfies a condition: its value must be of the condition's kind and one of the chosen ones; a masked, missing or other-class value never does. */
export function satisfies(condition: PropertyCondition, property: GraphProperty | undefined): boolean {
  if (property === undefined || property.masked || property.dataClass !== condition.kind) return false;
  if (condition.op === 'between') {
    const { kind, from, to } = condition;
    const below = from === undefined ? 0 : compareStyleValue({ class: kind, value: from }, kind, property.value);
    const above = to === undefined ? 0 : compareStyleValue({ class: kind, value: to }, kind, property.value);
    return below !== undefined && above !== undefined && below >= 0 && above <= 0;
  }
  const text = choiceTextOf(property);
  return text !== undefined && condition.values.includes(text);
}

const propertyOf = (item: Filterable, key: string): GraphProperty | undefined => item.properties.find((property) => property.key === key);

/** What the loaded entities of a type hold for one property: the values a choice can list, and what stops one being offered. */
export interface PropertyChoices {
  /** Every distinct loaded non-masked value as text, in order. */
  readonly values: readonly string[];
  /** The kind the loaded values have when they are all of one class a choice can be made on. */
  readonly observed: ChoiceKind | undefined;
  /** Some loaded value of the property is masked: nothing about it is offered or counted. */
  readonly masked: boolean;
  /** The loaded entities of the type that have no value for it (unmasked ones only). */
  readonly missing: number;
  /** Loaded values a choice cannot offer because the stored document would refuse them. */
  readonly unusable: number;
  /** The loaded entities of the type. */
  readonly loaded: number;
}

const CHOICE_CLASSES: readonly string[] = ['text', 'boolean', 'number'];

function orderOf(kind: ChoiceKind | undefined): (a: string, b: string) => number {
  if (kind === 'number') return (a, b) => compareNumbers(a, b) ?? 0;
  if (kind === 'boolean') return (a, b) => Number(a === 'true') - Number(b === 'true');
  return (a, b) => (a < b ? -1 : a > b ? 1 : 0);
}

/** An entity or a relationship, as far as a filter reads it. */
export interface Filterable {
  readonly properties: readonly GraphProperty[];
}

/** The choices the loaded items of a type (already picked out by the caller) offer for a property. */
export function choicesOf(items: readonly Filterable[], property: string, kind?: ChoiceKind): PropertyChoices {
  const values = new Set<string>();
  const classes = new Set<string>();
  let masked = false;
  let missing = 0;
  let unusable = 0;
  let loaded = 0;
  for (const item of items) {
    loaded += 1;
    const held = propertyOf(item, property);
    if (held?.masked === true) {
      masked = true;
      continue;
    }
    if (held === undefined || held.value === undefined || held.value === null) {
      missing += 1;
      continue;
    }
    classes.add(held.dataClass);
    if (kind !== undefined && held.dataClass !== kind) continue;
    const text = choiceTextOf(held);
    if (text !== undefined) values.add(text);
    else if (CHOICE_CLASSES.includes(held.dataClass)) unusable += 1;
  }
  const [only, ...rest] = [...classes];
  const observed = rest.length === 0 && only !== undefined && CHOICE_CLASSES.includes(only) ? (only as ChoiceKind) : undefined;
  return { values: [...values].sort(orderOf(kind ?? observed)), observed, masked, missing, unusable, loaded };
}

/** The lowest and highest loaded value of a ranged property of one entity type, as text; nothing when any loaded value is masked or none is comparable. */
export function loadedRange(items: readonly Filterable[], property: string, kind: RangeKind): { readonly lowest: string; readonly highest: string } | undefined {
  let lowest: GraphProperty | undefined;
  let highest: GraphProperty | undefined;
  for (const item of items) {
    const held = propertyOf(item, property);
    if (held === undefined) continue;
    if (held.masked) return undefined;
    if (held.dataClass !== kind || held.value === undefined || held.value === null) continue;
    if (kind === 'number' ? canonicalNumberText(held.value) === undefined : typeof held.value !== 'string' || momentKey(kind, held.value) === undefined) continue;
    if (lowest === undefined || (compareStyleValue({ class: kind, value: lowest.value as string }, kind, held.value) ?? 0) < 0) lowest = held;
    if (highest === undefined || (compareStyleValue({ class: kind, value: highest.value as string }, kind, held.value) ?? 0) > 0) highest = held;
  }
  if (lowest === undefined || highest === undefined) return undefined;
  const text = (held: GraphProperty): string | undefined => (kind === 'number' ? canonicalNumberText(held.value) : typeof held.value === 'string' ? held.value : undefined);
  const low = text(lowest);
  const high = text(highest);
  return low === undefined || high === undefined ? undefined : { lowest: low, highest: high };
}

const keysCache = new WeakMap<LoadedGraph, WeakMap<readonly PropertyCondition[], ReadonlySet<string>>>();
const NO_KEYS: ReadonlySet<string> = new Set();

/** The keys of the loaded entities a condition on their type leaves out. The same graph and conditions give the same set. */
export function propertyFilteredKeys(graph: LoadedGraph, conditions: readonly PropertyCondition[]): ReadonlySet<string> {
  const entityConditions = conditions.filter((condition) => condition.on === 'entity');
  if (entityConditions.length === 0) return NO_KEYS;
  let byConditions = keysCache.get(graph);
  if (byConditions === undefined) {
    byConditions = new WeakMap();
    keysCache.set(graph, byConditions);
  }
  const known = byConditions.get(conditions);
  if (known !== undefined) return known;
  const keys = new Set<string>();
  for (const node of graph.nodes) {
    const failing = entityConditions.some((condition) => condition.type === node.ref.entityType && !satisfies(condition, propertyOf(node, condition.property)));
    if (failing) keys.add(elementKey(node.ref));
  }
  byConditions.set(conditions, keys);
  return keys;
}
