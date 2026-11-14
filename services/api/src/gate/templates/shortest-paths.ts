import { referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import { normalizeShortestPaths } from '../normalize/shortest-paths.js';
import type { NormalizeContext } from '../normalize/index.js';
import type { ElementRef, Item, Params, Plan, Row, SourceAllowlist } from '../types.js';
import { PATHS_MAX_HOPS } from './shortest-paths-statement.js';
import { integerCandidateOf } from './stable-id.js';

export const SHORTEST_PATHS_ID = 'shortest-paths';

const endSchema = z.strictObject({ sourceId: z.string().min(1), entityType: z.string().min(1), stableId: referenceValueSchema });

/** The two ends by the references the client holds (the start first, then the end), the relationship types the paths may cross and the most hops: a count above the cap is refused by the gate with the cap, not by this schema. */
const paramsSchema = z
  .strictObject({ ends: z.tuple([endSchema, endSchema]), via: z.array(z.string().min(1)).min(1), direction: z.enum(['out', 'in', 'both']).optional(), maxHops: z.number().int().min(1) })
  .transform((params) => ({ ...params, ends: params.ends.map((end) => ({ ...end, stableInteger: integerCandidateOf(end.stableId) })) }));

const endsOf = (params: Params): readonly { readonly entityType: string }[] => {
  const parsed = z.array(z.looseObject({ entityType: z.string() })).safeParse(params['ends']);
  return parsed.success ? parsed.data : [];
};

function indexNeeds(params: Params, allowlist: SourceAllowlist) {
  return endsOf(params).flatMap(({ entityType }) => {
    const property = allowlist.stableIds.get(entityType);
    return property === undefined ? [] : [{ entityType, property, accepts: 'value' as const }];
  });
}

function refsOf(params: Params): readonly ElementRef[] {
  const parsed = z.array(z.looseObject({ sourceId: z.string(), entityType: z.string(), stableId: z.string() })).safeParse(params['ends']);
  return parsed.success ? parsed.data.map(({ sourceId, entityType, stableId }) => ({ sourceId, entityType, stableId })) : [];
}

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the shortest paths run needs the normalize context');
  return [{ ...normalizeShortestPaths(context, rows) }];
}

/**
 * Finds the shortest paths between two entities over the listed relationship types, at most the limit of them and one more to learn that the read was cut, each with the nodes and relationships it crosses. The
 * statement is written by the gate from the mapping (see `Template.shortestPaths`); the request holds the two references, the relationship types and the hop count only. A cut means only that more paths of the
 * same length exist than were returned.
 */
export const shortestPathsTemplate: TemplateDefinition = {
  id: SHORTEST_PATHS_ID,
  version: '1',
  auditAction: 'graph.shortest_paths_run',
  cypher: '@shortestPaths(via)',
  shortestPaths: { endsParam: 'ends', viaParam: 'via' },
  hops: { param: 'maxHops', max: PATHS_MAX_HOPS },
  pathResults: true,
  partialOnTimeout: true,
  paramsSchema,
  scope: 'user',
  paged: false,
  cutMeans: 'lowerBound',
  entityParams: [],
  referenceLists: ['ends'],
  relationshipParams: ['via'],
  indexNeeds,
  usedProperties: (): readonly [] => [],
  refsOf,
  normalize,
};
