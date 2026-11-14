import { z } from 'zod';
import { AppError } from '../../errors.js';
import { MAX_HOPS_CEILING } from '../../mapping/budgets.js';
import { quoteName } from '../render.js';
import type { Params, SourceAllowlist } from '../types.js';

/** The most hops a path run reads: the product's ceiling; the source's `max_hops` may lower it (the gate refuses more). */
export const PATHS_MAX_HOPS = MAX_HOPS_CEILING;

type PathsDirection = 'out' | 'in' | 'both';

export interface PathsRequest {
  readonly from: string;
  readonly to: string;
  readonly via: readonly string[];
  readonly maxHops: number;
  readonly direction: PathsDirection;
}

const endsSchema = z.tuple([z.looseObject({ entityType: z.string().min(1), stableId: z.string() }), z.looseObject({ entityType: z.string().min(1), stableId: z.string() })]);

/** What the request names, checked against the mapping: the two entity types, the relationship types, the hop count, and that the two ends are not one entity. */
export function pathsRequestOf(allowlist: SourceAllowlist, params: Params): PathsRequest {
  const ends = endsSchema.safeParse(params['ends']);
  const [via, hops, direction] = [params['via'], params['maxHops'], params['direction'] ?? 'both'];
  if (!ends.success || !Array.isArray(via) || via.length === 0 || !via.every((type): type is string => typeof type === 'string') || typeof hops !== 'number' || (direction !== 'out' && direction !== 'in' && direction !== 'both') || !Number.isInteger(hops) || hops < 1 || hops > PATHS_MAX_HOPS) throw new AppError('INVALID_REQUEST');
  if (new Set(via).size !== via.length || !via.every((type) => allowlist.relationshipTypes.has(type))) throw new AppError('INVALID_REQUEST');
  const [from, to] = ends.data;
  if (from.entityType === to.entityType && from.stableId === to.stableId) throw new AppError('INVALID_REQUEST');
  return { from: from.entityType, to: to.entityType, via, maxHops: hops, direction };
}

/** The walk from `a` to `b` over the relationship pattern: along the stored direction, against it, or either way. */
function walkOf(direction: PathsDirection, relationship: string): string {
  if (direction === 'out') return `(a)-${relationship}->(b)`;
  return direction === 'in' ? `(a)<-${relationship}-(b)` : `(a)-${relationship}-(b)`;
}

function labelAndKeyOf(allowlist: SourceAllowlist, type: string): { readonly label: string; readonly key: string } {
  const [label, key] = [allowlist.entityLabels.get(type), allowlist.stableIds.get(type)];
  if (label === undefined || key === undefined) throw new AppError('INVALID_REQUEST');
  return { label: quoteName(label), key: quoteName(key) };
}

/**
 * The statement of a shortest-paths run, from the mapping and the request. Each end is the first node by element ID with its stable ID (as the entity read finds it); the second is read optionally, so that a missing
 * end is told from no path. The paths are the shortest ones between the two ends over the listed relationship types, in either direction, of at most the hop count (an integer the request schema bounds and the gate
 * checks against the source's `max_hops`), at most `$limit + 1` of them to learn of a cut. One row for each path, each with the two ends, so that the rows a read has streamed when it times out are paths it found; one row with no path when there is none; no row when the first end is not found.
 */
export function shortestPathsStatementOf(allowlist: SourceAllowlist, request: PathsRequest): string {
  const [from, to] = [labelAndKeyOf(allowlist, request.from), labelAndKeyOf(allowlist, request.to)];
  const types = request.via.map((type) => quoteName(type)).join('|');
  return [
    `MATCH (a:${from.label}) WHERE a.${from.key} IN [$ends[0].stableId, $ends[0].stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`,
    `OPTIONAL MATCH (b:${to.label}) WHERE b.${to.key} IN [$ends[1].stableId, $ends[1].stableInteger] WITH a, b ORDER BY elementId(b) LIMIT 1`,
    `OPTIONAL MATCH p = allShortestPaths(${walkOf(request.direction, `[:${types}*1..${request.maxHops}]`)})`,
    'RETURN a, b, p LIMIT $limit + 1',
  ].join('\n');
}

/** The relationships of the listed types at one end, in the direction the search leaves it (`a`) or arrives at it (`b`); the frontier the search has to expand there. */
function endPatternOf(request: PathsRequest, end: 'a' | 'b'): string {
  const relationship = `[r:${request.via.map((type) => quoteName(type)).join('|')}]`;
  if (request.direction === 'both') return `(${end})-${relationship}-()`;
  const leaves = (request.direction === 'out') === (end === 'a');
  return leaves ? `(${end})-${relationship}->()` : `(${end})<-${relationship}-()`;
}

/**
 * The statement of the heavy-operation probe of a shortest-paths run: the two ends are found as in the run, and the relationships of the listed types at each end, in the direction the search expands, are counted up to
 * `$countCap + 1` each (the frontier of the search, not the number of paths, which a count would have to search for). One row: whether each end was found and the two counts; no row when the first end is not found.
 */
export function shortestPathsCountStatementOf(allowlist: SourceAllowlist, request: PathsRequest): string {
  const [from, to] = [labelAndKeyOf(allowlist, request.from), labelAndKeyOf(allowlist, request.to)];
  return [
    `MATCH (a:${from.label}) WHERE a.${from.key} IN [$ends[0].stableId, $ends[0].stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`,
    `OPTIONAL MATCH (b:${to.label}) WHERE b.${to.key} IN [$ends[1].stableId, $ends[1].stableInteger] WITH a, b ORDER BY elementId(b) LIMIT 1`,
    `CALL { WITH a OPTIONAL MATCH ${endPatternOf(request, 'a')} WITH r LIMIT $countCap + 1 RETURN count(r) AS fromDegree }`,
    `CALL { WITH b OPTIONAL MATCH ${endPatternOf(request, 'b')} WITH r LIMIT $countCap + 1 RETURN count(r) AS toDegree }`,
    'RETURN b IS NOT NULL AS toFound, fromDegree, toDegree',
  ].join('\n');
}
