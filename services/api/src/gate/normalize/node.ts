import { makeToken } from '../../reference/token.js';
import type { DataClass, GraphNode, GraphProperty, UnreferencedHit } from '@neburyx/contracts';
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

type Resolved = { readonly entities: readonly EntityNormalizer[] } | { readonly dropped: DropReason };

/**
 * The entity types a node is, by its labels: the one its labels map to, or, when they map to several, those of them that the read asked for (the type an expansion or an entity read names, or the type
 * of each search target that matched it). A node whose labels match several types and that no asked type narrows to is left out as `ambiguous-type`.
 */
function resolveEntities(context: NormalizeContext, labels: readonly string[], asked: readonly string[] | undefined): Resolved {
  const found = new Map<string, EntityNormalizer>();
  for (const label of labels) for (const entity of context.model.entitiesByLabel.get(label) ?? []) found.set(entity.type, entity);
  if (found.size === 0) return { dropped: 'not-mapped' };
  const narrowed = [...new Set(asked ?? [])].flatMap((type) => found.get(type) ?? []);
  if (narrowed.length > 0) return { entities: narrowed };
  const [only] = [...found.values()];
  return found.size === 1 && only !== undefined ? { entities: [only] } : { dropped: 'ambiguous-type' };
}

/** The stable ID a reference carries: the value for a type that is not keyed, and for a keyed type the token that stands for it in this source and entity type. */
function referenceOf(context: NormalizeContext, entity: EntityNormalizer, stableId: string): string {
  if (!entity.keyed) return stableId;
  if (context.references === undefined) throw new Error('the keyed references need the reference keys');
  return makeToken(context.references, { sourceId: context.sourceId, entityType: entity.type }, stableId);
}

/** The projected properties of a record, and whether one the type expects is missing. */
function projectedProperties(entity: EntityNormalizer, plain: PlainNode): { readonly properties: GraphProperty[]; readonly missing: boolean } {
  const properties: GraphProperty[] = [];
  let missing = false;
  for (const key of entity.projection) {
    const value = ownValue(plain.properties, key);
    if (value !== undefined && value !== null) {
      const described = describeValue(value);
      properties.push({ key, ...(described.value === undefined ? {} : { value: described.value }), dataClass: described.dataClass, masked: false });
    } else if (entity.expected.includes(key)) {
      properties.push({ key, dataClass: 'unknown', masked: false });
      missing = true;
    }
  }
  return { properties, missing };
}

/** The title filled from the record, or undefined when a placeholder has no plain value. */
function filledTitle(entity: EntityNormalizer, plain: PlainNode): string | undefined {
  let incomplete = false;
  const filled = entity.title.replace(PLACEHOLDER, (_whole, key: string) => {
    const text = placeholderText(ownValue(plain.properties, key));
    if (text === undefined) incomplete = true;
    return text ?? '';
  });
  return incomplete ? undefined : filled;
}

/** What one record becomes as one entity type: a node, or an unreferenced node when its stable ID is missing or unusable (it is listed and marked, and never given a reference). */
function asEntity(context: NormalizeContext, plain: PlainNode, entity: EntityNormalizer): NodeResult {
  const { properties, missing } = projectedProperties(entity, plain);
  const title = filledTitle(entity, plain);
  const stableId = stableIdText(ownValue(plain.properties, entity.stableId));
  if (stableId === undefined) return { unreferenced: { entityType: entity.type, title: title ?? entity.type, properties, reason: 'no-stable-id' } };
  const flags = [...(missing ? ['missing-property'] : []), ...(title === undefined ? ['title-incomplete'] : [])];
  return {
    node: {
      ref: { sourceId: context.sourceId, entityType: entity.type, stableId: referenceOf(context, entity, stableId) },
      display: { title: title ?? `${entity.type} ${stableId}`, type: entity.type },
      properties,
      qualityFlags: flags,
      provenanceRefs: [],
      authorization: { canInspect: true, canExport: true },
    },
  };
}

export type NodeResult = { readonly node: GraphNode } | { readonly unreferenced: UnreferencedHit } | { readonly dropped: DropReason };

/**
 * A node of the source as each entity type it resolves to (see `resolveEntities`), or the one reason it was left out. The `sourceId` of a ref is the request's, whatever the record says.
 * `asked` is the entity types the read asked for this record, when the read names them.
 */
export function normalizeNodeAs(context: NormalizeContext, plain: PlainNode, asked?: readonly string[]): readonly NodeResult[] {
  const resolved = resolveEntities(context, plain.labels, asked);
  if ('dropped' in resolved) return [resolved];
  return resolved.entities.map((entity) => asEntity(context, plain, entity));
}

/** A node of the source as the one type the read asked for, or the reason it was left out; a record with no usable stable ID has no reference to stand for it, so it is left out as `no-stable-id`. */
export function normalizeNode(context: NormalizeContext, plain: PlainNode, expectedType?: string): { readonly node: GraphNode } | { readonly dropped: DropReason } {
  const [result] = normalizeNodeAs(context, plain, expectedType === undefined ? undefined : [expectedType]);
  if (result === undefined || 'unreferenced' in result) return { dropped: 'no-stable-id' };
  return result;
}
