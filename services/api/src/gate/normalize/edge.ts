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
  | { readonly kind: 'stored'; readonly edge: GraphEdge; readonly first: string }
  | { readonly kind: 'aggregate'; readonly type: string; readonly from: ElementRef; readonly to: ElementRef; readonly members: Set<string>; readonly times: unknown[]; readonly flags: Set<string> };

export type EdgeDirection = GraphEdge['direction'];

/** The time of a stored edge as the source gave it: a temporal value as its text, text as it is. */
function observedText(value: unknown): string | undefined {
  const described = describeValue(value);
  return described.value === undefined || typeof described.value !== 'string' || described.value === '' ? undefined : described.value;
}

function storedEdge(context: NormalizeContext, row: RelationshipNormalizer, relationship: PlainRelationship, stableId: string, from: ElementRef, to: ElementRef, direction: EdgeDirection): GraphEdge {
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
    direction,
    semantics: 'stored',
    properties,
    evidenceRefs,
    ...(observedAt === undefined ? {} : { observedAt }),
    qualityFlags: [],
  };
}

function aggregateEdge(context: NormalizeContext, slot: Extract<Slot, { kind: 'aggregate' }>, direction: EdgeDirection): GraphEdge {
  const { first, last, mixed } = firstAndLast(slot.times);
  return {
    ref: { sourceId: context.sourceId, aggregate: { type: slot.type, from: slot.from, to: slot.to } },
    memberCount: countOf(slot.members.size, context.hasMore ? 'lowerBound' : 'exact', MEMBERS),
    from: slot.from,
    to: slot.to,
    type: slot.type,
    direction,
    semantics: 'stored',
    ...(first === undefined ? {} : { observedFirst: first }),
    ...(last === undefined ? {} : { observedLast: last }),
    properties: [],
    evidenceRefs: [],
    qualityFlags: [...slot.flags, ...(mixed ? ['mixed-time-kinds'] : [])],
  };
}

/** The aggregate edge of a summary the source already grouped: its type, its two ends, its member count (exact, because the read covered every member) and the earliest and latest time of its members. */
export function summarizedAggregate(context: NormalizeContext, summary: { readonly type: string; readonly from: ElementRef; readonly to: ElementRef; readonly members: unknown; readonly first: unknown; readonly last: unknown; readonly direction: EdgeDirection; readonly flags: readonly string[] }): GraphEdge {
  const times = [summary.first, summary.last].filter((value) => value !== null && value !== undefined);
  const { first, last, mixed } = firstAndLast(times);
  return {
    ref: { sourceId: context.sourceId, aggregate: { type: summary.type, from: summary.from, to: summary.to } },
    memberCount: countOf(summary.members, 'exact', MEMBERS),
    from: summary.from,
    to: summary.to,
    type: summary.type,
    direction: summary.direction,
    semantics: 'stored',
    ...(first === undefined ? {} : { observedFirst: first }),
    ...(last === undefined ? {} : { observedLast: last }),
    properties: [],
    evidenceRefs: [],
    qualityFlags: [...summary.flags, ...(mixed ? ['mixed-time-kinds'] : [])],
  };
}

/**
 * The edges of the relationships whose two ends are known: a relationship of a type mapped with a `stable_id` is an edge of its own, one without is a member of the
 * aggregate for its type and pair. A relationship is left out, and counted, when an end was left out or is not in the rows, when the type is not mapped between the
 * entity types of its ends in that direction, or when a stored one has no stable ID. The same relationship twice is one.
 */
export function normalizeEdges(context: NormalizeContext, relationships: readonly PlainRelationship[], outcomes: ReadonlyMap<string, NodeOutcome>, directionOf: (relationship: PlainRelationship) => EdgeDirection = () => 'from-to'): { readonly edges: GraphEdge[]; /** For each edge, the element ID of the first relationship it stands for. */ readonly firstElementIds: string[]; readonly dropped: DropReason[] } {
  const slots = new Map<string, Slot>();
  const dropped: DropReason[] = [];
  for (const relationship of relationships) {
    const start = outcomes.get(relationship.startElementId);
    const end = outcomes.get(relationship.endElementId);
    if (start === undefined || end === undefined) {
      dropped.push('end-missing');
      continue;
    }
    if ('dropped' in start || 'dropped' in end) {
      dropped.push('end-not-shown');
      continue;
    }
    const row = context.model.relationships.find((candidate) => candidate.type === relationship.type && candidate.from === start.ref.entityType && candidate.to === end.ref.entityType);
    if (row === undefined) {
      dropped.push('no-mapping-row');
      continue;
    }
    const stableId = row.stableId === undefined ? undefined : stableIdText(ownValue(relationship.properties, row.stableId));
    if (row.stableId !== undefined && stableId !== undefined) {
      const key = JSON.stringify(['stored', row.type, start.ref.entityType, end.ref.entityType, stableId]);
      const known = slots.get(key);
      if (known === undefined) slots.set(key, { kind: 'stored', first: relationship.elementId, edge: storedEdge(context, row, relationship, stableId, start.ref, end.ref, directionOf(relationship)) });
      // a different relationship with the same type, ends and stable ID is not hidden: the first edge stays and says so
      else if (known.kind === 'stored' && !known.edge.qualityFlags.includes('conflicting-duplicate')) slots.set(key, { kind: 'stored', first: known.first, edge: { ...known.edge, qualityFlags: [...known.edge.qualityFlags, 'conflicting-duplicate'] } });
      continue;
    }
    const key = JSON.stringify(['aggregate', row.type, start.ref.entityType, start.ref.stableId, end.ref.entityType, end.ref.stableId]);
    const known = slots.get(key);
    const slot = known?.kind === 'aggregate' ? known : { kind: 'aggregate' as const, type: row.type, from: start.ref, to: end.ref, members: new Set<string>(), times: [] as unknown[], flags: new Set<string>() };
    if (row.stableId !== undefined) slot.flags.add('no-stable-id');
    if (!slot.members.has(relationship.elementId)) {
      slot.members.add(relationship.elementId);
      if (row.observedAt !== undefined) slot.times.push(ownValue(relationship.properties, row.observedAt));
    }
    slots.set(key, slot);
  }
  const kept = [...slots.values()];
  return { edges: kept.map((slot) => (slot.kind === 'stored' ? slot.edge : aggregateEdge(context, slot, 'from-to'))), firstElementIds: kept.map((slot) => (slot.kind === 'stored' ? slot.first : [...slot.members][0] ?? '')), dropped };
}
