import type { TemplateDefinition } from '../catalog.js';
import { normalizeShortestPathsCount } from '../normalize/shortest-paths-count.js';
import type { Item, Row } from '../types.js';
import { shortestPathsTemplate } from './shortest-paths.js';

export const SHORTEST_PATHS_COUNT_ID = 'shortest-paths-count';

/**
 * The heavy-operation probe of the shortest-paths run (TAS §8.1): counts the relationships of the listed types at the two ends, in the direction the search expands, reading at most the count cap plus one at each end.
 * It returns numbers and flags only. It is not a template a pattern can bind, and the run route cannot name it. With Enterprise policy the count must become policy-aware or `unknown` before it can reveal anything about
 * relationships a viewer may not see; the Community gate has no such policy.
 */
export const shortestPathsCountTemplate: TemplateDefinition = {
  ...shortestPathsTemplate,
  id: SHORTEST_PATHS_COUNT_ID,
  auditAction: 'graph.shortest_paths_count',
  partialOnTimeout: undefined,
  shortestPaths: { endsParam: 'ends', viaParam: 'via', count: true },
  normalize: (rows: readonly Row[]): readonly Item[] => [{ ...normalizeShortestPathsCount(rows) }],
};
