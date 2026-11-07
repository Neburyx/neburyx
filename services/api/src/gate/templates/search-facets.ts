import { searchTextSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { MAX_EVIDENCE_PROPERTIES, MAX_FACET_PROBES, MAX_REFERENCE_PROPERTIES, MAX_SEARCH_PROPERTIES } from '../../mapping/model.js';
import type { TemplateDefinition } from '../catalog.js';
import type { Item, Params, Plan, Row, UsedProperty } from '../types.js';
import type { NormalizeContext } from '../normalize/index.js';
import { NODE_BRANCH } from './search-template.js';
import { integerCandidateOf } from './stable-id.js';

export const SEARCH_FACETS_ID = 'search-facets';

const form = z.enum(['value', 'text']);

/** A property of an entity type that a probe matches: from the `search` or the `reference` list of the mapping. */
const entityFacetTargetSchema = z.strictObject({ kind: z.enum(['search', 'reference']), entityType: z.string().min(1), property: z.string().min(1), match: form });
/** An evidence property of a relationship mapping row (one with a `stable_id`) that a probe matches. */
const evidenceFacetTargetSchema = z.strictObject({ kind: z.literal('evidence'), relationshipType: z.string().min(1), from: z.string().min(1), to: z.string().min(1), property: z.string().min(1), match: form });

export const facetTargetSchema = z.discriminatedUnion('kind', [entityFacetTargetSchema, evidenceFacetTargetSchema]);
export type FacetTarget = z.infer<typeof facetTargetSchema>;
export type EntityFacetTarget = z.infer<typeof entityFacetTargetSchema>;
export type EvidenceFacetTarget = z.infer<typeof evidenceFacetTargetSchema>;

/** One probe: a non-empty list of targets of one kind, whose matches are counted together, each once. */
export const facetProbeSchema = z.strictObject({ targets: z.array(facetTargetSchema).min(1).max(MAX_SEARCH_PROPERTIES + MAX_REFERENCE_PROPERTIES + MAX_EVIDENCE_PROPERTIES) });
export type FacetProbe = z.infer<typeof facetProbeSchema>;

const probesSchema = z.array(facetProbeSchema).max(MAX_FACET_PROBES);

function probesOf(params: Params): readonly FacetProbe[] {
  const parsed = probesSchema.safeParse(params['probes']);
  return parsed.success ? parsed.data : [];
}

const targetsOf = (params: Params): readonly FacetTarget[] => probesOf(params).flatMap((probe) => probe.targets);

/**
 * The counts of the facets, one row of integers: the value of column `c<i>` is the number of rows probe `i` found, at most `limit + 1`; anything else is a read the gate cannot trust. The row holds a
 * count for each probe and nothing else, in order.
 */
export function normalizeFacetCounts(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  const limit = context?.limit;
  if (limit === undefined) throw new Error('the facet counts need the page limit');
  const [row, ...others] = rows;
  if (row === undefined && others.length === 0) return [];
  if (row === undefined || others.length > 0) throw new AppError('INTERNAL_ERROR');
  const names = Object.keys(row);
  const counts = names.map((_name, index) => row[`c${index}`]);
  if (names.some((name, index) => name !== `c${index}`) || !counts.every((count): count is number => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= limit + 1)) {
    throw new AppError('INTERNAL_ERROR');
  }
  return [{ counts }];
}

/**
 * Counts, in one read, how many entities or relationships the typed text matches: each probe is a list of targets of one kind, written in by the gate from the mapping as branches joined by `UNION`
 * (so a node found through two properties is one row), the combined result cut at `$limit + 1`, and counted. Each count is the true count up to `$limit + 1`, so the service can tell exact (up to and
 * including the cap) from a lower bound. The text is matched as the exact search matches it, as the text and, when it is a canonical 64-bit integer, as that integer too. The statement is one row of counts.
 */
export const searchFacetsTemplate: TemplateDefinition = {
  id: SEARCH_FACETS_ID,
  version: '1',
  auditAction: 'entity.search_facets',
  cypher: '@facetProbes(probes)',
  facetProbes: {
    param: 'probes',
    node: NODE_BRANCH,
    evidence: {
      value: 'MATCH (a:@fromLabel)-[r:@type]->(b:@toLabel) USING RANGE INDEX SEEK r:@type(@property) WHERE r.@property IN [$text, $textInteger] RETURN r LIMIT $limit + 1',
      text: 'MATCH (a:@fromLabel)-[r:@type]->(b:@toLabel) USING TEXT INDEX r:@type(@property) WHERE r.@property = $text RETURN r LIMIT $limit + 1',
    },
  },
  paramsSchema: z.strictObject({ text: searchTextSchema, probes: probesSchema }).transform((params) => ({ ...params, textInteger: integerCandidateOf(params.text) })),
  scope: 'user',
  paged: false,
  entityParams: [],
  relationshipParams: [],
  usedProperties: (params): readonly UsedProperty[] =>
    targetsOf(params).map((target) => (target.kind === 'evidence' ? { relationshipType: target.relationshipType, from: target.from, to: target.to, property: target.property } : { entityType: target.entityType, property: target.property })),
  indexNeeds: (params) =>
    targetsOf(params).map((target) =>
      target.kind === 'evidence'
        ? { relationshipType: target.relationshipType, from: target.from, to: target.to, property: target.property, accepts: target.match === 'text' ? ('any' as const) : ('value' as const) }
        : { entityType: target.entityType, property: target.property, accepts: target.match === 'text' ? ('any' as const) : ('value' as const) },
    ),
  readsNothing: (params) => probesOf(params).length === 0,
  refsOf: () => [],
  normalize: normalizeFacetCounts,
};
