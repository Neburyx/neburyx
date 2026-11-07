import type { AggregateEvidenceHit, AggregateMember, DisabledRelationship, ElementRef, EvidenceHit } from '@neburyx/contracts';
import type { DerivedRuleModel } from '../mapping/model.js';
import { propertyIndexOf } from '../gate/index-guard.js';
import { countOf, MEMBERS } from '../gate/normalize/count.js';
import type { RelationshipEvidence } from '../gate/normalize/index.js';
import { listedEvidenceOf, type EvidenceTarget } from '../gate/templates/search-evidence.js';
import type { IndexSnapshot } from '../gate/types.js';
import type { RelationshipModel, SourceModel } from '../mapping/model.js';

export interface EvidencePlan {
  readonly targets: readonly EvidenceTarget[];
  /** The evidence properties that are not searched, each with its row and why. */
  readonly disabled: DisabledRelationship[];
}

const rowsWithEvidence = (source: SourceModel): readonly RelationshipModel[] => source.relationships.filter((row) => row.evidence.length > 0);

export function evidenceRowsOf(source: SourceModel): number {
  return rowsWithEvidence(source).length;
}

/**
 * What is searched for evidence: every evidence property of a relationship mapping row (with a `stable_id` or without one) that has an online index, in the form its index serves; each property that
 * has none is named with its row and why. With no snapshot (the login cannot list indexes) every property is searched as a `value`.
 */
export function planEvidence(source: SourceModel, snapshot: IndexSnapshot | undefined): EvidencePlan {
  const targets: EvidenceTarget[] = [];
  const disabled: DisabledRelationship[] = [];
  for (const row of rowsWithEvidence(source)) {
    const named = { relationshipType: row.type, from: row.from, to: row.to };
    for (const property of new Set(row.evidence)) {
      const index = snapshot === undefined ? { form: 'value' as const } : propertyIndexOf(snapshot, row.type, property, 'RELATIONSHIP');
      if ('gap' in index) disabled.push({ ...named, property, reason: index.gap });
      else targets.push({ ...named, property, match: index.form });
    }
  }
  return { targets, disabled };
}

/** The rules of the mapping that use a relationship type, in the mapping's order: its `via` alternates relationship types (even places) and entity types (odd places), and only the first kind counts. */
function rulesUsing(rules: readonly DerivedRuleModel[], relationshipType: string): EvidenceHit['rules'] {
  return rules.filter((rule) => rule.via.some((name, index) => index % 2 === 0 && name === relationshipType)).map((rule) => ({ ruleId: rule.id, ruleVersion: rule.ruleVersion }));
}

const rowKey = (type: string, from: string, to: string): string => JSON.stringify([type, from, to]);
const compareText = (first: string, second: string): number => (first < second ? -1 : first > second ? 1 : 0);
const endKey = (ref: ElementRef): string => JSON.stringify([ref.entityType, ref.stableId]);

interface Ranked {
  readonly rank: number;
  readonly order: string;
  readonly hit: EvidenceHit;
}

/**
 * The hits of an evidence read: a stored relationship is a hit of its own; the relationships of a row with no `stable_id` between the same two entities are one aggregate hit, its members in the order
 * they were read (element ID order). Hits are in the mapping's order of relationship rows, then by stable ID text (stored) or by the ends (aggregates), so the same hits are always in the same order.
 * `complete` says the read holds every match (a first page with no next page): only then is an aggregate's member count exact. A later page cannot know the members of earlier pages, so its member
 * counts are lower bounds.
 */
export function evidenceHitsOf(source: SourceModel, evidence: readonly RelationshipEvidence[], complete: boolean): EvidenceHit[] {
  const position = new Map(source.relationships.map((row, index) => [rowKey(row.type, row.from, row.to), index]));
  const rankOf = (type: string, from: string, to: string): number => position.get(rowKey(type, from, to)) ?? source.relationships.length;
  const ranked: Ranked[] = [];
  const aggregates = new Map<string, { readonly rank: number; readonly order: string; readonly aggregate: AggregateEvidenceHit['aggregate']; readonly members: AggregateMember[] }>();
  for (const relationship of listedEvidenceOf(evidence)) {
    if ('stored' in relationship.of) {
      const supports = relationship.of.stored;
      ranked.push({ rank: rankOf(supports.type, supports.from, supports.to), order: supports.stableId, hit: { supports, records: [...relationship.records], rules: rulesUsing(source.derived, supports.type) } });
      continue;
    }
    const { aggregate } = relationship.of;
    const key = JSON.stringify([aggregate.type, endKey(aggregate.from), endKey(aggregate.to)]);
    const member: AggregateMember = { elementId: relationship.elementId, records: [...relationship.records], ...(relationship.observedAt === undefined ? {} : { observedAt: relationship.observedAt }) };
    const known = aggregates.get(key);
    if (known === undefined) aggregates.set(key, { rank: rankOf(aggregate.type, aggregate.from.entityType, aggregate.to.entityType), order: key, aggregate, members: [member] });
    else known.members.push(member);
  }
  for (const { rank, order, aggregate, members } of aggregates.values()) {
    ranked.push({ rank, order, hit: { aggregate, members, memberCount: countOf(members.length, complete ? 'exact' : 'lowerBound', MEMBERS), rules: rulesUsing(source.derived, aggregate.type) } });
  }
  return ranked.sort((first, second) => first.rank - second.rank || compareText(first.order, second.order)).map((entry) => entry.hit);
}
