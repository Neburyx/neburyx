import { makeToken } from '../../reference/token.js';
import type { DataClass, GraphNode, GraphProperty } from '@neburyx/contracts';
import type { DropReason } from './drops.js';
import type { EntityNormalizer, NormalizeContext } from './model.js';

/** A node as the adapter hands it over (sources/plain-values.ts). */
export interface PlainNode {
  readonly $type: 'node';
  readonly elementId: string;
  readonly labels: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A property of a record, only when the record has it itself: a mapped name such as `constructor` is not found on the prototype chain. */
export function ownValue(properties: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(properties, key) ? properties[key] : undefined;
}

export function isPlainNode(value: unknown): value is PlainNode {
  return isObject(value) && value['$type'] === 'node' && Array.isArray(value['labels']) && isObject(value['properties']);
}

const TAGGED_KINDS: Readonly<Record<string, DataClass>> = {
  date: 'date',
  dateTime: 'dateTime',
  localDateTime: 'localDateTime',
  time: 'time',
  localTime: 'localTime',
  duration: 'duration',
  integer: 'number',
  float: 'number',
};

/** The shown value and its kind: a tagged scalar is shown as its text, with the tag as the kind. */
export function describeValue(value: unknown): { readonly value?: unknown; readonly dataClass: DataClass } {
  if (typeof value === 'string') return { value, dataClass: 'text' };
  if (typeof value === 'number') return { value, dataClass: 'number' };
  if (typeof value === 'boolean') return { value, dataClass: 'boolean' };
  if (Array.isArray(value)) return { value, dataClass: 'list' };
  if (isObject(value)) {
    const tag = value['$type'];
    if (typeof tag === 'string') {
      const kind = TAGGED_KINDS[tag];
      if (kind !== undefined && typeof value['value'] === 'string') return { value: value['value'], dataClass: kind };
      if (tag === 'point') return { value, dataClass: 'point' };
      return { dataClass: 'unknown' };
    }
    return { value, dataClass: 'other' };
  }
  return { dataClass: 'unknown' };
}

/** The stable ID as text, or nothing when the property is not text or an integer, or is empty. */
export function stableIdText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (isObject(value) && value['$type'] === 'integer' && typeof value['value'] === 'string') return value['value'];
  return undefined;
}

/** The text a title placeholder is filled with; nothing for an absent value or one that is not plain text. */
export function placeholderText(value: unknown): string | undefined {
  const described = describeValue(value);
  if (described.dataClass === 'unknown' || described.dataClass === 'list' || described.dataClass === 'other' || described.dataClass === 'point') return undefined;
  return described.value === undefined ? undefined : String(described.value);
}

export const PLACEHOLDER = /\{([^{}]*)\}/g;

type Resolved = { readonly entity: EntityNormalizer } | { readonly dropped: DropReason };

/** The entity type of a node from its labels; when the labels match several types, the type the read asked for settles it if it is one of them. */
function resolveEntity(context: NormalizeContext, labels: readonly string[], expectedType?: string): Resolved {
  const found = new Map<string, EntityNormalizer>();
  for (const label of labels) for (const entity of context.model.entitiesByLabel.get(label) ?? []) found.set(entity.type, entity);
  if (found.size === 0) return { dropped: 'not-mapped' };
  const expected = expectedType === undefined ? undefined : found.get(expectedType);
  if (expected !== undefined) return { entity: expected };
  const [only] = [...found.values()];
  return found.size === 1 && only !== undefined ? { entity: only } : { dropped: 'ambiguous-type' };
}

/** The stable ID a reference carries: the value for a type that is not keyed, and for a keyed type the token that stands for it in this source and entity type. */
function referenceOf(context: NormalizeContext, entity: EntityNormalizer, stableId: string): string {
  if (!entity.keyed) return stableId;
  if (context.references === undefined) throw new Error('the keyed references need the reference keys');
  return makeToken(context.references, { sourceId: context.sourceId, entityType: entity.type }, stableId);
}

/** A node of the source, or the reason it was left out. The `sourceId` of the ref is the request's, whatever the record says. */
export function normalizeNode(context: NormalizeContext, plain: PlainNode, expectedType?: string): { readonly node: GraphNode } | { readonly dropped: DropReason } {
  const resolved = resolveEntity(context, plain.labels, expectedType);
  if ('dropped' in resolved) return resolved;
  const { entity } = resolved;
  const stableId = stableIdText(ownValue(plain.properties, entity.stableId));
  if (stableId === undefined) return { dropped: 'no-stable-id' };

  const flags: string[] = [];
  const properties: GraphProperty[] = [];
  for (const key of entity.projection) {
    const value = ownValue(plain.properties, key);
    const present = value !== undefined && value !== null;
    if (present) {
      const described = describeValue(value);
      properties.push({ key, ...(described.value === undefined ? {} : { value: described.value }), dataClass: described.dataClass, masked: false });
    } else if (entity.expected.includes(key)) {
      properties.push({ key, dataClass: 'unknown', masked: false });
      if (!flags.includes('missing-property')) flags.push('missing-property');
    }
  }

  let incomplete = false;
  const filled = entity.title.replace(PLACEHOLDER, (_whole, key: string) => {
    const text = placeholderText(ownValue(plain.properties, key));
    if (text === undefined) incomplete = true;
    return text ?? '';
  });
  if (incomplete) flags.push('title-incomplete');

  return {
    node: {
      ref: { sourceId: context.sourceId, entityType: entity.type, stableId: referenceOf(context, entity, stableId) },
      display: { title: incomplete ? `${entity.type} ${stableId}` : filled, type: entity.type },
      properties,
      qualityFlags: flags,
      provenanceRefs: [],
      authorization: { canInspect: true, canExport: true },
    },
  };
}
