import { searchTextSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { MAX_SEARCH_PROPERTIES } from '../../mapping/model.js';
import type { TemplateDefinition } from '../catalog.js';
import { isPlainRelationship } from '../normalize/edge.js';
import { expectedTypesOf, isNormalizedEvidence, normalizeWithEvidence, type AskedTypesOf, type NormalizeContext, type RelationshipEvidence } from '../normalize/index.js';
import type { Item, Params, Plan, Row } from '../types.js';
import { afterLastRow, isNormalized, keysetOf, SEARCH_SORT } from './search-template.js';
import { integerCandidateOf } from './stable-id.js';

export const SEARCH_EVIDENCE_ID = 'relationship-evidence';

/**
 * One evidence property of one relationship mapping row: the relationship type and the entity types of its two ends and the property all come from the mapping.
 * `value` matches the text and the integer it can be (a RANGE index or a constraint serves it); `text` matches the text only (a TEXT index holds strings only).
 */
export const evidenceTargetSchema = z.strictObject({ relationshipType: z.string().min(1), from: z.string().min(1), to: z.string().min(1), property: z.string().min(1), match: z.enum(['value', 'text']) });

export type EvidenceTarget = z.infer<typeof evidenceTargetSchema>;

const evidenceTargetsSchema = z.array(evidenceTargetSchema).max(MAX_SEARCH_PROPERTIES);

function evidenceTargetsOf(params: Params): readonly EvidenceTarget[] {
  const parsed = evidenceTargetsSchema.safeParse(params['targets']);
  return parsed.success ? parsed.data : [];
}

/**
 * The entity types asked for the ends of an evidence row: for its start node (`a`) the `from` types and for its end node (`b`) the `to` types of the targets of its relationship's type, so an end
 * whose labels match two entity types is resolved as the type its row maps and is not left out as ambiguous.
 */
function endTypesOf(targets: readonly EvidenceTarget[]): AskedTypesOf {
  return (row, column) => {
    const relationship = row['r'];
    if ((column !== 'a' && column !== 'b') || !isPlainRelationship(relationship)) return undefined;
    const types = targets.filter((target) => target.relationshipType === relationship.type).map((target) => (column === 'a' ? target.from : target.to));
    return types.length === 0 ? undefined : [...new Set(types)];
  };
}

/** The normalized rows with the evidence of each relationship (its records, and the element ID a member of an aggregate is listed by). */
function normalizeEvidence(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the evidence search needs the normalize context');
  return [{ ...normalizeWithEvidence(context, rows, expectedTypesOf(rows, endTypesOf(evidenceTargetsOf(context.params ?? {})))) }];
}

/** The relationships an evidence group lists: one whose evidence properties gave no record is not a hit. */
export function listedEvidenceOf(evidence: readonly RelationshipEvidence[]): readonly RelationshipEvidence[] {
  return evidence.filter((relationship) => relationship.records.length > 0);
}

/** The hits a page of the evidence search holds: its listed relationships, a stored one and each member of an aggregate alike, as the group counts them. */
function evidenceHeldOf(items: readonly Item[]): number {
  return items.reduce((sum: number, item) => sum + (isNormalized(item) && isNormalizedEvidence(item) ? listedEvidenceOf(item.evidence).length : 0), 0);
}

/**
 * Matches the whole typed text, as stored, against each evidence property of each target relationship row, as the text and, when it is a canonical 64-bit integer, as that integer too, so a
 * relationship index serves each branch. A branch returns the relationship and its two ends so the normalize stage can name both; branches are joined by `UNION` so a relationship found through two
 * properties is one row. It pages by keyset on the relationship's element ID as the entity search pages on the node's. Each branch carries an index hint: with labelled ends the Neo4j 5.26 planner scans a whole
 * relationship index and filters, and the hint makes it a seek. The hint does not protect a read whose index is gone (the server only notes it and plans without it); the gate's index guard does.
 */
export const searchEvidenceTemplate: TemplateDefinition = {
  id: SEARCH_EVIDENCE_ID,
  version: '1',
  auditAction: 'entity.search_evidence',
  cypher: 'CALL { @searchBranches(targets) } WITH r, a, b ORDER BY elementId(r) LIMIT $limit + 1 RETURN r, a, b',
  searchBranches: {
    param: 'targets',
    allowlist: 'evidence',
    value: `MATCH (a:@fromLabel)-[r:@type]->(b:@toLabel) USING RANGE INDEX SEEK r:@type(@property) WHERE r.@property IN [$text, $textInteger] AND ${keysetOf('r')} WITH r, a, b ORDER BY elementId(r) LIMIT $limit + 1 RETURN r, a, b`,
    text: `MATCH (a:@fromLabel)-[r:@type]->(b:@toLabel) USING TEXT INDEX r:@type(@property) WHERE r.@property = $text AND ${keysetOf('r')} WITH r, a, b ORDER BY elementId(r) LIMIT $limit + 1 RETURN r, a, b`,
  },
  paramsSchema: z.strictObject({ text: searchTextSchema, targets: evidenceTargetsSchema }).transform((params) => ({ ...params, textInteger: integerCandidateOf(params.text) })),
  scope: 'user',
  paged: true,
  sort: SEARCH_SORT,
  entityParams: [],
  relationshipParams: [],
  usedProperties: (params) => evidenceTargetsOf(params).map((target) => ({ relationshipType: target.relationshipType, from: target.from, to: target.to, property: target.property })),
  indexNeeds: (params) =>
    evidenceTargetsOf(params).map((target) => ({ relationshipType: target.relationshipType, from: target.from, to: target.to, property: target.property, accepts: target.match === 'text' ? ('any' as const) : ('value' as const) })),
  readsNothing: (params) => evidenceTargetsOf(params).length === 0,
  nextPosition: afterLastRow('r'),
  heldOf: evidenceHeldOf,
  refsOf: () => [],
  normalize: normalizeEvidence,
};
