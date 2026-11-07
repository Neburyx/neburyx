import type { DisabledRelationship, EvidenceHit, GraphEdge } from '@neburyx/contracts';
import type { DerivedRuleModel } from '../mapping/model.js';
import { onlineFormOf } from '../gate/index-guard.js';
import type { EvidenceTarget } from '../gate/templates/search-evidence.js';
import type { IndexSnapshot } from '../gate/types.js';
import type { RelationshipModel, SourceModel } from '../mapping/model.js';

export interface EvidencePlan {
  readonly targets: readonly EvidenceTarget[];
  /** The mapping rows with an evidence property that are not searched, each with why. */
  readonly disabled: DisabledRelationship[];
}

const rowsWithEvidence = (source: SourceModel): readonly RelationshipModel[] => source.relationships.filter((row) => row.evidence.length > 0);

export function evidenceRowsOf(source: SourceModel): number {
  return rowsWithEvidence(source).filter((row) => row.stableId !== undefined).length;
}

/**
 * What is searched for evidence: every evidence property of a relationship mapping row that has a `stable_id` and whose evidence indexes are all online, in the form its index serves; a row with a
 * property that has no online index is left out whole, and a row without a `stable_id` is not searched. With no snapshot (the login cannot list indexes) every property is searched as a `value`.
 */
export function planEvidence(source: SourceModel, snapshot: IndexSnapshot | undefined): EvidencePlan {
  const targets: EvidenceTarget[] = [];
  const disabled: DisabledRelationship[] = [];
  for (const row of rowsWithEvidence(source)) {
    const named = { relationshipType: row.type, from: row.from, to: row.to };
    if (row.stableId === undefined) {
      disabled.push({ ...named, reason: 'no-stable-id' });
      continue;
    }
    const properties = [...new Set(row.evidence)];
    const forms = properties.map((property) => (snapshot === undefined ? ('value' as const) : onlineFormOf(snapshot, row.type, property, 'RELATIONSHIP')));
    if (forms.some((form) => form === undefined)) {
      disabled.push({ ...named, reason: 'index-unavailable' });
      continue;
    }
    properties.forEach((property, index) => targets.push({ ...named, property, match: forms[index] === 'text' ? 'text' : 'value' }));
  }
  return { targets, disabled };
}

/** The rules of the mapping that use a relationship type, in the mapping's order: its `via` alternates relationship types (even places) and entity types (odd places), and only the first kind counts. */
function rulesUsing(rules: readonly DerivedRuleModel[], relationshipType: string): EvidenceHit['rules'] {
  return rules.filter((rule) => rule.via.some((name, index) => index % 2 === 0 && name === relationshipType)).map((rule) => ({ ruleId: rule.id, ruleVersion: rule.ruleVersion }));
}

/** The hits in the mapping's order of relationship rows and then by stable ID text, so the same hits are always in the same order; only a stored relationship with its reference is a hit. */
export function evidenceHitsOf(source: SourceModel, edges: readonly GraphEdge[]): EvidenceHit[] {
  const position = new Map(source.relationships.map((row, index) => [JSON.stringify([row.type, row.from, row.to]), index]));
  const hits = edges.flatMap((edge) => {
    if (!('stableId' in edge.ref)) return [];
    const records = [...new Set(edge.evidenceRefs)].map((sourceRecordId) => ({ sourceRecordId }));
    return records.length === 0 ? [] : [{ rank: position.get(JSON.stringify([edge.ref.type, edge.ref.from, edge.ref.to])) ?? source.relationships.length, hit: { supports: edge.ref, records, rules: rulesUsing(source.derived, edge.ref.type) } }];
  });
  return hits
    .sort((first, second) => first.rank - second.rank || (first.hit.supports.stableId < second.hit.supports.stableId ? -1 : first.hit.supports.stableId > second.hit.supports.stableId ? 1 : 0))
    .map((entry) => entry.hit);
}
