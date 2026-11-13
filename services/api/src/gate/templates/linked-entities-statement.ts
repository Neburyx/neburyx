import { AppError } from '../../errors.js';
import { quoteName } from '../render.js';
import type { Params, SourceAllowlist } from '../types.js';

/** The most hops this template reads; the source's `max_hops` may lower it (the gate refuses more). */
export const LINKED_MAX_HOPS = 2;

export type LinkedDirection = 'out' | 'in' | 'both';

/** One way to cross a relationship row from a `near` entity type to a `far` one. */
export interface LinkedStep {
  readonly type: string;
  readonly near: string;
  readonly far: string;
  readonly direction: LinkedDirection;
  readonly observedAt: string | undefined;
}

export interface LinkedEntitiesRequest {
  readonly anchor: string;
  readonly target: string;
  readonly via: readonly string[];
  readonly direction: LinkedDirection;
  readonly maxHops: number;
  /** The steps that start at the anchor's type and, for one hop, end at the target's type. */
  readonly first: readonly LinkedStep[];
  /** The second steps, each after a first step that ends at their `near` type, ending at the target's type. */
  readonly second: readonly LinkedStep[];
  /** The property that puts an entity of a type on a derived rule's stop-list, for the types a two-hop run passes through. */
  readonly stopListed: ReadonlyMap<string, readonly string[]>;
  readonly windowed: boolean;
  /** The relationship types of the run's steps that have no time property, so that a window cannot apply to them. */
  readonly untimedTypes: readonly string[];
}

const same = (left: LinkedStep, right: LinkedStep): boolean => left.type === right.type && left.near === right.near && left.far === right.far && left.direction === right.direction;

function stepsOf(allowlist: SourceAllowlist, via: readonly string[], direction: LinkedDirection): readonly LinkedStep[] {
  const steps: LinkedStep[] = [];
  for (const row of allowlist.relationshipRows.filter((candidate) => via.includes(candidate.type))) {
    const crossings: LinkedStep[] =
      direction === 'out'
        ? [{ type: row.type, near: row.from, far: row.to, direction, observedAt: row.observedAt }]
        : direction === 'in'
          ? [{ type: row.type, near: row.to, far: row.from, direction, observedAt: row.observedAt }]
          : [
              { type: row.type, near: row.from, far: row.to, direction, observedAt: row.observedAt },
              ...(row.from === row.to ? [] : [{ type: row.type, near: row.to, far: row.from, direction, observedAt: row.observedAt }]),
            ];
    for (const step of crossings) if (!steps.some((known) => same(known, step))) steps.push(step);
  }
  return steps;
}

/** The direction a run takes when the request names none: the stored direction read from the anchor's type, which must be one for every listed row that touches it. */
function defaultDirectionOf(allowlist: SourceAllowlist, via: readonly string[], anchor: string): LinkedDirection {
  const found = new Set<LinkedDirection>();
  for (const row of allowlist.relationshipRows.filter((candidate) => via.includes(candidate.type))) {
    if (row.from === anchor) found.add('out');
    else if (row.to === anchor) found.add('in');
  }
  const [only] = [...found];
  if (found.size !== 1 || only === undefined) throw new AppError('INVALID_REQUEST');
  return only;
}

/**
 * What the request names, checked against the mapping: the anchor's and the target's entity types, the listed relationship types and the rows that carry them, the direction (read from the anchor when the request gives none),
 * the steps a run of one or two hops can take, the time properties a window applies to and the stop-list of the types a two-hop run passes through.
 */
export function linkedEntitiesRequestOf(allowlist: SourceAllowlist, params: Params): LinkedEntitiesRequest {
  const [anchor, target, via, requested] = [params['entityType'], params['targetType'], params['via'], params['direction']];
  const hops = params['maxHops'] ?? 1;
  if (typeof anchor !== 'string' || typeof target !== 'string' || !Array.isArray(via) || via.length === 0 || !via.every((type): type is string => typeof type === 'string') || typeof hops !== 'number') throw new AppError('INVALID_REQUEST');
  if (new Set(via).size !== via.length || !via.every((type) => allowlist.relationshipTypes.has(type))) throw new AppError('INVALID_REQUEST');
  if (requested !== undefined && requested !== 'out' && requested !== 'in' && requested !== 'both') throw new AppError('INVALID_REQUEST');
  const direction: LinkedDirection = requested ?? defaultDirectionOf(allowlist, via, anchor);
  const steps = stepsOf(allowlist, via, direction);
  const first = steps.filter((step) => step.near === anchor && (hops > 1 || step.far === target));
  const second = hops > 1 ? steps.filter((step) => step.far === target && first.some((start) => start.far === step.near)) : [];
  if (first.length === 0 || (hops === 1 ? false : first.every((step) => step.far !== target) && second.length === 0)) throw new AppError('INVALID_REQUEST');
  const used = [...first, ...second];
  const windowed = params['windowFrom'] !== undefined;
  if (windowed && used.every((step) => step.observedAt === undefined)) throw new AppError('INVALID_REQUEST');
  const stopListed = new Map<string, readonly string[]>();
  if (hops > 1) {
    for (const rule of allowlist.derivedRules ?? []) {
      if (rule.stopListProperty === undefined) continue;
      const relationships = rule.via.filter((_entry, index) => index % 2 === 0);
      const middles = rule.via.filter((_entry, index) => index % 2 === 1);
      if (!relationships.every((type) => via.includes(type))) continue;
      for (const middle of middles) if (first.some((step) => step.far === middle)) stopListed.set(middle, [...new Set([...(stopListed.get(middle) ?? []), rule.stopListProperty])]);
    }
  }
  const untimedTypes = [...new Set(used.filter((step) => step.observedAt === undefined).map((step) => step.type))];
  return { anchor, target, via, direction, maxHops: hops, first, second, stopListed, windowed, untimedTypes };
}

/** The quoted label of an entity type of the mapping. */
function labelOf(allowlist: SourceAllowlist, type: string): string {
  const label = allowlist.entityLabels.get(type);
  if (label === undefined) throw new AppError('INVALID_REQUEST');
  return quoteName(label);
}

function pattern(allowlist: SourceAllowlist, step: LinkedStep, near: string, relationship: string, far: string): string {
  const [type, label] = [quoteName(step.type), labelOf(allowlist, step.far)];
  const rel = `[${relationship}:${type}]`;
  if (step.direction === 'out') return `(${near})-${rel}->(${far}:${label})`;
  if (step.direction === 'in') return `(${near})<-${rel}-(${far}:${label})`;
  return `(${near})-${rel}-(${far}:${label})`;
}

const instant = (variable: string, time: string): string =>
  `CASE WHEN ${variable}.${time} IS :: ZONED DATETIME THEN ${variable}.${time} WHEN ${variable}.${time} IS :: LOCAL DATETIME THEN datetime({datetime: ${variable}.${time}, timezone: 'UTC'}) WHEN ${variable}.${time} IS :: DATE THEN datetime({date: ${variable}.${time}, timezone: 'UTC'}) END`;

function windowOf(request: LinkedEntitiesRequest, step: LinkedStep, relationship: string): string[] {
  if (!request.windowed || step.observedAt === undefined) return [];
  const time = quoteName(step.observedAt);
  return [`${instant(relationship, time)} >= datetime($windowFrom)`, `${instant(relationship, time)} < datetime($windowTo)`];
}

const where = (conditions: readonly string[]): string => (conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`);

/** The relationship types a supernode check counts around an intermediate entity: every listed type, in the direction of the run. */
function degreePatterns(request: LinkedEntitiesRequest): readonly string[] {
  return request.via.map((type) => {
    const rel = `[:${quoteName(type)}]`;
    return request.direction === 'out' ? `(n)-${rel}->()` : request.direction === 'in' ? `(n)<-${rel}-()` : `(n)-${rel}-()`;
  });
}

/** Whether an intermediate entity is on a stop-list: one of its type's stop-list properties is true. */
function stopCondition(allowlist: SourceAllowlist, request: LinkedEntitiesRequest): string {
  const conditions = [...request.stopListed].flatMap(([type, properties]) => properties.map((property) => `(n:${labelOf(allowlist, type)} AND coalesce(n.${quoteName(property)}, false) = true)`));
  return conditions.length === 0 ? 'false' : conditions.join(' OR ');
}

/**
 * The members of the aggregate edges of the run: for a relationship type with no stable ID, every relationship of the type between the two ends of a match's edge, at most `$countCap + 1` of them for each edge, so that the
 * member count of the edge is `exact` under the cap and `lowerBound` over it. A run with no such type reads none.
 */
function membersOf(allowlist: SourceAllowlist, request: LinkedEntitiesRequest): readonly string[] {
  const types = [...new Set([...request.first, ...request.second].filter((step) => !allowlist.relationshipRows.some((row) => row.type === step.type && row.stableId !== undefined)).map((step) => quoteName(step.type)))];
  const final = (members: string, cut: string): string => `RETURN a, bounded, heavy[..$limit] AS heavy, stopListed, m.x AS x, m.m AS mid, m.r1 AS r1, m.r2 AS r2, m.hops AS hops${members}${cut}`;
  if (types.length === 0) return [final('', '')];
  const read = (edge: string, name: string): string => `CALL { WITH m WITH m, startNode(m.${edge}) AS s, endNode(m.${edge}) AS e OPTIONAL MATCH (s)-[rr:${types.join('|')}]->(e) WHERE type(rr) = type(m.${edge}) WITH rr LIMIT $countCap + 1 RETURN collect(rr) AS ${name} }`;
  return request.maxHops > 1
    ? [read('r1', 'members1'), read('r2', 'members2'), final(', members1, members2', ', size(members1) > $countCap OR size(members2) > $countCap AS membersCut')]
    : [read('r1', 'members1'), final(', members1', ', size(members1) > $countCap AS membersCut')];
}

interface Parts {
  readonly anchorLine: string;
  readonly neighbors: (targetOnly: boolean) => string;
  readonly nearLabels: string;
  /** The line that reads the degree of each distinct neighbor that can be a middle entity and splits them into those that are traversed and the supernodes (and whether a stop-listed one was left out). */
  readonly intermediates: string;
  readonly expansions: (returns: string) => string;
  readonly targetStableId: string;
}

function partsOf(allowlist: SourceAllowlist, request: LinkedEntitiesRequest): Parts {
  const [anchorLabel, targetStableId, anchorStableId] = [allowlist.entityLabels.get(request.anchor), allowlist.stableIds.get(request.target), allowlist.stableIds.get(request.anchor)];
  if (anchorLabel === undefined || targetStableId === undefined || anchorStableId === undefined) throw new AppError('INVALID_REQUEST');
  const nearLabels = [...new Set(request.second.map((step) => `n:${labelOf(allowlist, step.near)}`))].join(' OR ');
  const counts = degreePatterns(request).map((text, index) => `CALL { WITH n MATCH ${text} WITH 1 AS hit LIMIT $countCap + 1 RETURN count(*) AS c${index} }`);
  const total = degreePatterns(request).map((_text, index) => `c${index}`).join(' + ');
  return {
    anchorLine: `MATCH (a:${quoteName(anchorLabel)}) WHERE a.${quoteName(anchorStableId)} IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`,
    neighbors: (targetOnly) =>
      request.first
        .filter((step) => !targetOnly || step.far === request.target)
        .map((step) => `WITH a MATCH ${pattern(allowlist, step, 'a', 'r', 'n')}${where(['n <> a', ...windowOf(request, step, 'r')])} RETURN n, r, ${step.far === request.target} AS isTarget`)
        .join(' UNION ALL '),
    nearLabels,
    intermediates: `CALL { WITH nbs UNWIND nbs AS e WITH DISTINCT e.n AS n WHERE ${nearLabels} ${counts.join(' ')} WITH n, ${total} AS degree, ${stopCondition(allowlist, request)} AS stopped RETURN collect(CASE WHEN degree > $countCap THEN n END) AS heavy, collect(CASE WHEN degree <= $countCap AND NOT stopped THEN n END) AS mids, count(CASE WHEN stopped THEN 1 END) > 0 AS stopListed }`,
    expansions: (returns) => request.second.map((step) => `WITH a, n MATCH ${pattern(allowlist, step, `n:${labelOf(allowlist, step.near)}`, 'r2', 'x')}${where(['x <> a', ...windowOf(request, step, 'r2')])} RETURN ${returns}`).join(' UNION ALL '),
    targetStableId,
  };
}

/**
 * The statement of a linked-entities run, from the mapping and the request. The anchor is the first node by element ID with the stable ID. Its neighbors over the listed steps are read, at most `$countCap + 1` of them, each
 * with the relationship that joins it and whether it is of the target's type. A run of two hops then reads, for each distinct neighbor, the relationships it has over the listed types, at most `$countCap + 1` for each type: a neighbor
 * with more than `$countCap` is a supernode, which is not traversed and is returned in `heavy`, and one on a stop-list is not traversed either. The second steps from the others end at the target's type, at most `$countCap + 1` rows in all. The
 * matches are the neighbors of the target's type (hop 1) and those reached by a second step (hop 2), once each at their lowest hop, ordered by hop and then by stable ID, at most `$limit + 1`. Every name comes from the allowlist and
 * every request value is a parameter.
 */
export function linkedEntitiesStatementOf(allowlist: SourceAllowlist, request: LinkedEntitiesRequest): string {
  const parts = partsOf(allowlist, request);
  const twoHops = request.maxHops > 1;
  const lines = [
    parts.anchorLine,
    `CALL { WITH a CALL { ${parts.neighbors(false)} } WITH n, r, isTarget LIMIT $countCap + 1 WITH collect({n: n, r: r, isTarget: isTarget}) AS found RETURN size(found) > $countCap AS cutFirst, found[..$countCap] AS nbs }`,
  ];
  if (twoHops && request.second.length > 0) {
    lines.push(
      parts.intermediates,
      `CALL { WITH a, mids UNWIND mids AS n CALL { ${parts.expansions('x, r2')} } WITH n, x, r2 LIMIT $countCap + 1 WITH collect({x: x, m: n, r2: r2}) AS found RETURN size(found) > $countCap AS cutSecond, found[..$countCap] AS second }`,
    );
  } else {
    lines.push('WITH a, nbs, cutFirst, [] AS heavy, false AS stopListed, false AS cutSecond, [] AS second');
  }
  lines.push(
    'WITH a, cutFirst OR cutSecond AS bounded, heavy, stopListed, [e IN nbs WHERE e.isTarget | {x: e.n, hops: 1, m: null, r1: e.r, r2: null}] + [h IN second | {x: h.x, hops: 2, m: h.m, r1: [e IN nbs WHERE e.n = h.m][0].r, r2: h.r2}] AS entries',
    `CALL { WITH entries UNWIND entries AS entry WITH entry ORDER BY entry.hops WITH entry.x AS x, collect(entry)[0] AS best ORDER BY best.hops, x.${quoteName(parts.targetStableId)} LIMIT $limit + 1 RETURN collect(best) AS ms }`,
    'UNWIND CASE WHEN size(ms) = 0 THEN [null] ELSE ms END AS m',
    ...membersOf(allowlist, request),
  );
  return lines.join('\n');
}

/**
 * The statement of the count of a linked-entities run, from the mapping and the request: the matches the run would return (the neighbors of the target's type, and for two hops those reached through a middle entity that is
 * not a supernode and not on a stop-list), each once, streamed and stopped at `$countCap + 1`, counted. The matches of one hop are streamed from the anchor itself, not from the frontier the run keeps (which is cut to the cap, so
 * it could never read more than the cap). For two hops the frontier of middle entities is read with the run's own bound (at most `$countCap + 1` neighbors) and the run's degree check of each middle entity, so it traverses no supernode; it reads no relationship of the matches and orders nothing. One row: the number of matches read, `frontierBounded` (the frontier reached the cap) and `supernodeSkipped` (a middle entity was
 * left out as a supernode or on a stop-list); no row when the anchor is not found. It returns numbers and flags only.
 */
export function linkedEntitiesCountStatementOf(allowlist: SourceAllowlist, request: LinkedEntitiesRequest): string {
  const parts = partsOf(allowlist, request);
  if (request.maxHops === 1 || request.second.length === 0) {
    return [parts.anchorLine, `CALL { WITH a CALL { ${parts.neighbors(true)} } WITH DISTINCT n LIMIT $countCap + 1 RETURN count(n) AS matches }`, 'RETURN matches, false AS frontierBounded, false AS supernodeSkipped'].join('\n');
  }
  return [
    parts.anchorLine,
    `CALL { WITH a CALL { ${parts.neighbors(false)} } WITH n, isTarget LIMIT $countCap + 1 WITH collect({n: n, isTarget: isTarget}) AS found RETURN size(found) > $countCap AS frontierBounded, found[..$countCap] AS nbs }`,
    parts.intermediates,
    `CALL { WITH a, mids CALL { WITH a CALL { ${parts.neighbors(true)} } RETURN n AS x UNION ALL WITH a, mids UNWIND mids AS n CALL { ${parts.expansions('x')} } RETURN x } WITH DISTINCT x LIMIT $countCap + 1 RETURN count(x) AS matches }`,
    'RETURN matches, frontierBounded, size(heavy) > 0 OR stopListed AS supernodeSkipped',
  ].join('\n');
}
