import type { ElementRef, GraphEdge, GraphProperty } from '@neburyx/contracts';
import { countOf, MEMBERS } from './count.js';
import type { DropReason } from './drops.js';
import type { NormalizeContext, RelationshipNormalizer } from './model.js';
import { describeValue, ownValue, stableIdText } from './node.js';
import { firstAndLast } from './observed.js';

/** A relationship as the adapter hands it over (sources/plain-values.ts). */
export interface PlainRelationship {
  readonly $type: 'relationship';
  readonly elementId: string;
  readonly type: string;
  readonly startElementId: string;
  readonly endElementId: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function isPlainRelationship(value: unknown): value is PlainRelationship {
  return isObject(value) && value['$type'] === 'relationship' && typeof value['type'] === 'string' && typeof value['startElementId'] === 'string' && typeof value['endElementId'] === 'string' && isObject(value['properties']);
}

/** What became of the node at an element ID: its ref, or the reason it was left out. */
export type NodeOutcome = { readonly ref: ElementRef } | { readonly dropped: DropReason };

type Slot =
  | { readonly kind: 'stored'; readonly edge: GraphEdge }
  | { readonly kind: 'aggregate'; readonly type: string; readonly from: ElementRef; readonly to: ElementRef; readonly members: Set<string>; readonly times: unknown[] };

/** The time of a stored edge as the source gave it: a temporal value as its text, text as it is. */
function observedText(value: unknown): string | undefined {
  const described = describeValue(value);
  return described.value === undefined || typeof described.value !== 'string' || described.value === '' ? undefined : described.value;
}

function storedEdge(context: NormalizeContext, row: RelationshipNormalizer, relationship: PlainRelationship, stableId: string, from: ElementRef, to: ElementRef): GraphEdge {
  const properties: GraphProperty[] = [];
  for (const key of row.projection) {
    const value = ownValue(relationship.properties, key);
    if (value === undefined || value === null) continue;
    const described = describeValue(value);
    properties.push({ key, ...(described.value === undefined ? {} : { value: described.value }), dataClass: described.dataClass, masked: false });
  }
  const observedAt = row.observedAt === undefined ? undefined : observedText(ownValue(relationship.properties, row.observedAt));
  const evidenceRefs = row.evidence.flatMap((key) => {
    const value = ownValue(relationship.properties, key);
    const text = observedText(value) ?? (typeof value === 'number' ? String(value) : undefined);
    return text === undefined ? [] : [text];
  });
  return {
    ref: { sourceId: context.sourceId, type: row.type, from: from.entityType, to: to.entityType, stableId },
    from,
    to,
    type: row.type,
    direction: 'from-to',
    semantics: 'stored',
    properties,
    evidenceRefs,
    ...(observedAt === undefined ? {} : { observedAt }),
    qualityFlags: [],
  };
}

function aggregateEdge(context: NormalizeContext, slot: Extract<Slot, { kind: 'aggregate' }>): GraphEdge {
  const { first, last, mixed } = firstAndLast(slot.times);
  return {
    ref: { sourceId: context.sourceId, aggregate: { type: slot.type, from: slot.from, to: slot.to } },
    memberCount: countOf(slot.members.size, context.hasMore ? 'lowerBound' : 'exact', MEMBERS),
    from: slot.from,
    to: slot.to,
    type: slot.type,
    direction: 'from-to',
    semantics: 'stored',
    ...(first === undefined ? {} : { observedFirst: first }),
    ...(last === undefined ? {} : { observedLast: last }),
    properties: [],
    evidenceRefs: [],
    qualityFlags: mixed ? ['mixed-time-kinds'] : [],
  };
}

/**
 * The edges of the relationships whose two ends are known: a relationship of a type mapped with a `stable_id` is an edge of its own, one without is a member of the
 * aggregate for its type and pair. A relationship is left out, and counted, when an end was left out or is not in the rows, when the type is not mapped between the
 * entity types of its ends in that direction, or when a stored one has no stable ID. The same relationship twice is one.
 */
export function normalizeEdges(context: NormalizeContext, relationships: readonly PlainRelationship[], outcomes: ReadonlyMap<string, NodeOutcome>): { readonly edges: GraphEdge[]; readonly dropped: DropReason[] } {
  const slots = new Map<string, Slot>();
  const dropped: DropReason[] = [];
  for (const relationship of relationships) {
    const start = outcomes.get(relationship.startElementId);
    const end = outcomes.get(relationship.endElementId);
    if (start === undefined || end === undefined || 'dropped' in start || 'dropped' in end) {
      dropped.push('not-mapped');
      continue;
    }
    const row = context.model.relationships.find((candidate) => candidate.type === relationship.type && candidate.from === start.ref.entityType && candidate.to === end.ref.entityType);
    if (row === undefined) {
      dropped.push('not-mapped');
      continue;
    }
    if (row.stableId !== undefined) {
      const stableId = stableIdText(ownValue(relationship.properties, row.stableId));
      if (stableId === undefined) {
        dropped.push('no-stable-id');
        continue;
      }
      const key = JSON.stringify(['stored', row.type, start.ref.entityType, end.ref.entityType, stableId]);
      const known = slots.get(key);
      if (known === undefined) slots.set(key, { kind: 'stored', edge: storedEdge(context, row, relationship, stableId, start.ref, end.ref) });
      // a different relationship with the same type, ends and stable ID is not hidden: the first edge stays and says so
      else if (known.kind === 'stored' && !known.edge.qualityFlags.includes('conflicting-duplicate')) slots.set(key, { kind: 'stored', edge: { ...known.edge, qualityFlags: [...known.edge.qualityFlags, 'conflicting-duplicate'] } });
      continue;
    }
    const key = JSON.stringify(['aggregate', row.type, start.ref.entityType, start.ref.stableId, end.ref.entityType, end.ref.stableId]);
    const known = slots.get(key);
    const slot = known?.kind === 'aggregate' ? known : { kind: 'aggregate' as const, type: row.type, from: start.ref, to: end.ref, members: new Set<string>(), times: [] as unknown[] };
    if (!slot.members.has(relationship.elementId)) {
      slot.members.add(relationship.elementId);
      if (row.observedAt !== undefined) slot.times.push(ownValue(relationship.properties, row.observedAt));
    }
    slots.set(key, slot);
  }
  return { edges: [...slots.values()].map((slot) => (slot.kind === 'stored' ? slot.edge : aggregateEdge(context, slot))), dropped };
}
