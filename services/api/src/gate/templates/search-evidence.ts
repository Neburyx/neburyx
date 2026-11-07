import { searchTextSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { MAX_SEARCH_PROPERTIES } from '../../mapping/model.js';
import type { TemplateDefinition } from '../catalog.js';
import type { Params } from '../types.js';
import { normalizeSearch } from './search-template.js';
import { integerCandidateOf } from './stable-id.js';

export const SEARCH_EVIDENCE_ID = 'relationship-evidence';

/**
 * One evidence property of one relationship mapping row: the relationship type and the entity types of its two ends and the property all come from the mapping (a row with a `stable_id`).
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
 * Matches the whole typed text, as stored, against each evidence property of each target relationship row, as the text and, when it is a canonical 64-bit integer, as that integer too, so a
 * relationship index serves each branch. A branch returns the relationship and its two ends so the normalize stage can name both; branches are joined by `UNION` so a relationship found through two
 * properties is one row, and each branch and the combined result are cut at `$limit + 1`. Each branch carries an index hint: with labelled ends the Neo4j 5.26 planner scans a whole
 * relationship index and filters, and the hint makes it a seek. The hint does not protect a read whose index is gone (the server only notes it and plans without it); the gate's index guard does.
 */
export const searchEvidenceTemplate: TemplateDefinition = {
  id: SEARCH_EVIDENCE_ID,
  version: '1',
  auditAction: 'entity.search_evidence',
  cypher: 'CALL { @searchBranches(targets) } WITH r, a, b LIMIT $limit + 1 RETURN r, a, b',
  searchBranches: {
    param: 'targets',
    allowlist: 'evidence',
    value: 'MATCH (a:@fromLabel)-[r:@type]->(b:@toLabel) USING RANGE INDEX SEEK r:@type(@property) WHERE r.@property IN [$text, $textInteger] RETURN r, a, b LIMIT $limit + 1',
    text: 'MATCH (a:@fromLabel)-[r:@type]->(b:@toLabel) USING TEXT INDEX r:@type(@property) WHERE r.@property = $text RETURN r, a, b LIMIT $limit + 1',
  },
  paramsSchema: z.strictObject({ text: searchTextSchema, targets: evidenceTargetsSchema }).transform((params) => ({ ...params, textInteger: integerCandidateOf(params.text) })),
  scope: 'user',
  paged: false,
  entityParams: [],
  relationshipParams: [],
  usedProperties: (params) => evidenceTargetsOf(params).map((target) => ({ relationshipType: target.relationshipType, from: target.from, to: target.to, property: target.property })),
  indexNeeds: (params) =>
    evidenceTargetsOf(params).map((target) => ({ relationshipType: target.relationshipType, from: target.from, to: target.to, property: target.property, accepts: target.match === 'text' ? ('any' as const) : ('value' as const) })),
  readsNothing: (params) => evidenceTargetsOf(params).length === 0,
  refsOf: () => [],
  normalize: normalizeSearch,
};
