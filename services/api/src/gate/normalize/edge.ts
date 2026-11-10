import type { ElementRef, EvidenceRecord, GraphEdge, GraphProperty, StoredEdgeRef } from '@neburyx/contracts';
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

/**
 * The evidence of one relationship of the edges, for the evidence search: the edge it is (a stored one by its reference, or a member of the aggregate of its type and ends), its element ID, the value
 * of each of its evidence properties and its time. The element ID is held as text for a member to be listed by; it is never a reference.
 */
export interface RelationshipEvidence {
  readonly elementId: string;
  readonly of: { readonly stored: StoredEdgeRef } | { readonly aggregate: { readonly type: string; readonly from: ElementRef; readonly to: ElementRef } };
  readonly records: readonly EvidenceRecord[];
  /** For a stored edge: the evidence properties that hold each record's text, by that text; a record is listed once, under the first, and this keeps the others. */
  readonly carriers?: Readonly<Record<string, readonly string[]>>;
  readonly observedAt?: string;
}

/** What became of the node at an element ID: its ref, or the reason it was left out. */
export type NodeOutcome = { readonly ref: ElementRef } | { readonly dropped: DropReason };

type Slot =
  | { readonly kind: 'stored'; readonly edge: GraphEdge; readonly first: string }
  | { readonly kind: 'aggregate'; readonly type: string; readonly from: ElementRef; readonly to: ElementRef; readonly members: Set<string>; readonly times: unknown[]; readonly flags: Set<string> };

export type EdgeDirection = GraphEdge['direction'];

/** The time of a stored edge as the source gave it: a temporal value as its text, text as it is. */
export function observedText(value: unknown): string | undefined {
  const described = describeValue(value);
  return described.value === undefined || typeof described.value !== 'string' || described.value === '' ? undefined : described.value;
}

const observedAtOf = (row: RelationshipNormalizer, relationship: PlainRelationship): string | undefined => (row.observedAt === undefined ? undefined : observedText(ownValue(relationship.properties, row.observedAt)));

/** The text of an evidence value: text as it is, a temporal value as its text, a number as its digits; nothing for a value with no text to show. */
function evidenceText(value: unknown): string | undefined {
  return observedText(value) ?? (typeof value === 'number' ? String(value) : undefined);
}

/**
 * The value of each evidence property a relationship holds, in the mapping's order, the same text once. A value that is neither text nor a number (a list, a boolean, a point, a value the adapter
 * could not convert) is kept as unreadable with its property, so a relationship the read found is never left out for its value; an absent or empty one holds nothing to show and is not listed.
 */
function evidenceRecordsOf(row: RelationshipNormalizer, relationship: PlainRelationship): EvidenceRecord[] {
  const seen = new Set<string>();
  return row.evidence.flatMap((property): EvidenceRecord[] => {
    const value = ownValue(relationship.properties, property);
    if (value === undefined || value === null || value === '') return [];
    const text = evidenceText(value);
    if (text === undefined) return [{ property, unreadable: true }];
    if (seen.has(text)) return [];
    seen.add(text);
    return [{ sourceRecordId: text }];
  });
}

function evidenceCarriersOf(row: RelationshipNormalizer, relationship: PlainRelationship): Record<string, string[]> {
  const carriers: Record<string, string[]> = Object.create(null);
  for (const property of row.evidence) {
    const text = evidenceText(ownValue(relationship.properties, property));
    if (text !== undefined && text !== '') carriers[text] = [...(carriers[text] ?? []), property];
  }
  return carriers;
}

function storedEdge(context: NormalizeContext, row: RelationshipNormalizer, relationship: PlainRelationship, stableId: string, from: ElementRef, to: ElementRef, direction: EdgeDirection): GraphEdge {
  const properties: GraphProperty[] = [];
  for (const key of row.projection) {
    const value = ownValue(relationship.properties, key);
    if (value === undefined || value === null) continue;
    const described = describeValue(value);
    properties.push({ key, ...(described.value === undefined ? {} : { value: described.value }), dataClass: described.dataClass, masked: false });
  }
  const observedAt = observedAtOf(row, relationship);
  const evidenceRefs = row.evidence.flatMap((key) => {
    const text = evidenceText(ownValue(relationship.properties, key));
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
export function normalizeEdges(
  context: NormalizeContext,
  relationships: readonly PlainRelationship[],
  outcomes: ReadonlyMap<string, NodeOutcome>,
  directionOf: (relationship: PlainRelationship) => EdgeDirection = () => 'from-to',
): { readonly edges: GraphEdge[]; /** For each edge, the element ID of the first relationship it stands for. */ readonly firstElementIds: string[]; readonly dropped: DropReason[]; readonly evidence: RelationshipEvidence[] } {
  const slots = new Map<string, Slot>();
  const dropped: DropReason[] = [];
  const evidence: RelationshipEvidence[] = [];
  const timeOf = (row: RelationshipNormalizer, relationship: PlainRelationship): { readonly observedAt?: string } => {
    const observedAt = observedAtOf(row, relationship);
    return observedAt === undefined ? {} : { observedAt };
  };
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
      if (known === undefined) {
        const edge = storedEdge(context, row, relationship, stableId, start.ref, end.ref, directionOf(relationship));
        slots.set(key, { kind: 'stored', first: relationship.elementId, edge });
        if ('stableId' in edge.ref) evidence.push({ elementId: relationship.elementId, of: { stored: edge.ref }, records: evidenceRecordsOf(row, relationship), carriers: evidenceCarriersOf(row, relationship), ...timeOf(row, relationship) });
      }
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
      evidence.push({ elementId: relationship.elementId, of: { aggregate: { type: row.type, from: start.ref, to: end.ref } }, records: evidenceRecordsOf(row, relationship), ...timeOf(row, relationship) });
    }
    slots.set(key, slot);
  }
  const kept = [...slots.values()];
  return { edges: kept.map((slot) => (slot.kind === 'stored' ? slot.edge : aggregateEdge(context, slot, 'from-to'))), firstElementIds: kept.map((slot) => (slot.kind === 'stored' ? slot.first : [...slot.members][0] ?? '')), dropped, evidence };
}
