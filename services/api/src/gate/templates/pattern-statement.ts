import { AppError } from '../../errors.js';
import { quoteName } from '../render.js';
import type { SourceAllowlist } from '../types.js';
import { conditionPredicateOf, type ExpandBranch } from './expand-statement.js';
import type { PatternRequest, PatternStepRequest } from './pattern-request.js';
import { inWindow } from './window-condition.js';

const where = (conditions: readonly string[]): string => (conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`);
const union = (branches: readonly string[]): string => branches.join(' UNION ALL ');
const range = (count: number): readonly number[] => Array.from({ length: count }, (_unused, index) => index + 1);

/** The branches of a step that cross the same way (direction) and read the same time property (or none): they are read by one `MATCH` over their relationship types. */
function groupsOf(step: PatternStepRequest): readonly { readonly direction: 'out' | 'in'; readonly observedAt: string | undefined; readonly types: readonly string[] }[] {
  const groups: { direction: 'out' | 'in'; observedAt: string | undefined; types: string[] }[] = [];
  for (const branch of step.branches) {
    const known = groups.find((group) => group.direction === branch.direction && group.observedAt === branch.observedAt);
    if (known === undefined) groups.push({ direction: branch.direction, observedAt: branch.observedAt, types: [branch.type] });
    else if (!known.types.includes(branch.type)) known.types.push(branch.type);
  }
  return groups;
}

const typesOf = (types: readonly string[]): string => types.map((type) => quoteName(type)).join('|');

function labelOf(allowlist: SourceAllowlist, type: string): string {
  const label = allowlist.entityLabels.get(type);
  if (label === undefined) throw new AppError('INVALID_REQUEST');
  return quoteName(label);
}

function stableIdOf(allowlist: SourceAllowlist, type: string): string {
  const property = allowlist.stableIds.get(type);
  if (property === undefined) throw new AppError('INVALID_REQUEST');
  return quoteName(property);
}

/** The conditions a step's rows must meet beyond the crossing: a node differing from every node earlier on the path, the step's conditions (read by position) and, for a branch with a time property, the step's window. */
function conditionsOf(request: PatternRequest, index: number, branchObservedAt: string | undefined): string[] {
  const step = request.steps[index - 1];
  if (step === undefined) throw new AppError('INVALID_REQUEST');
  const earlier = ['a', ...range(index - 1).map((hop) => `n${hop}`)];
  const at = `$steps[${index - 1}]`;
  const variables = { neighbor: `n${index}`, relationship: `r${index}` };
  return [
    ...earlier.map((name) => `n${index} <> ${name}`),
    ...step.conditions.map((condition, position) => conditionPredicateOf(condition, variables, `${at}.conditions[${position}]`)),
    ...(step.windowed && branchObservedAt !== undefined ? inWindow(`r${index}`, quoteName(branchObservedAt), `${at}.windowFrom`, `${at}.windowTo`) : []),
  ];
}

/** The reads of one step from the previous node (`a` for the first step): one `MATCH` for each way of crossing, joined by `UNION ALL`, each returning the arrived node and the relationship. */
function stepRead(allowlist: SourceAllowlist, request: PatternRequest, index: number): string {
  const step = request.steps[index - 1];
  if (step === undefined) throw new AppError('INVALID_REQUEST');
  const from = index === 1 ? 'a' : `n${index - 1}`;
  const imports = ['a', ...range(index - 1).map((hop) => `n${hop}`)].join(', ');
  const label = labelOf(allowlist, step.arrivesAt);
  return union(
    groupsOf(step).map((group) => {
      const relationship = `[r${index}:${typesOf(group.types)}]`;
      const shape = group.direction === 'out' ? `(${from})-${relationship}->(n${index}:${label})` : `(${from})<-${relationship}-(n${index}:${label})`;
      return `WITH ${imports} MATCH ${shape}${where(conditionsOf(request, index, group.observedAt))} RETURN n${index}, r${index}`;
    }),
  );
}

/** The relationships a node has over the next step's types, one `MATCH` for each direction the step crosses, each read as a hit: counted with the bound of the count cap, whatever the step's conditions. */
function degreeRead(request: PatternRequest, next: number): string {
  const step = request.steps[next - 1];
  if (step === undefined) throw new AppError('INVALID_REQUEST');
  const directions = (['out', 'in'] as const).flatMap((direction) => {
    const types = [...new Set(step.branches.filter((branch: ExpandBranch) => branch.direction === direction).map((branch) => branch.type))];
    if (types.length === 0) return [];
    const relationship = `[:${typesOf(types)}]`;
    return [`WITH n MATCH ${direction === 'out' ? `(n)-${relationship}->()` : `(n)<-${relationship}-()`} RETURN 1 AS hit`];
  });
  return union(directions);
}

/** Whether a node between steps is on a stop-list: one of its type's stop-list properties is true. */
function stopCondition(request: PatternRequest, type: string): string {
  const properties = request.stopListed.get(type) ?? [];
  return properties.length === 0 ? 'false' : properties.map((property) => `coalesce(n.${quoteName(property)}, false) = true`).join(' OR ');
}

const firstHop = (allowlist: SourceAllowlist, request: PatternRequest): string =>
  `CALL { WITH a CALL { ${stepRead(allowlist, request, 1)} } WITH n1, r1 LIMIT $countCap + 1 WITH collect({n1: n1, r1: r1}) AS found RETURN size(found) > $countCap AS cut1, found[..$countCap] AS f1 }`;

/** The check before a step reads from the nodes the previous step reached: each distinct node's relationships over the step's types are counted with the bound of the count cap; above it the node is a supernode, which is not traversed, and a node on a stop-list is not traversed either. */
function checkBefore(request: PatternRequest, index: number): string {
  const previous = request.steps[index - 2];
  if (previous === undefined) throw new AppError('INVALID_REQUEST');
  const frontier = `f${index - 1}`;
  return `CALL { WITH ${frontier} UNWIND ${frontier} AS e WITH DISTINCT e.n${index - 1} AS n CALL { WITH n CALL { ${degreeRead(request, index)} } WITH hit LIMIT $countCap + 1 RETURN count(*) AS degree } WITH collect({n: n, degree: degree, stopped: ${stopCondition(request, previous.arrivesAt)}}) AS checked RETURN [c IN checked WHERE c.degree > $countCap | c.n] AS heavy${index}, [c IN checked WHERE c.degree <= $countCap AND NOT c.stopped | c.n] AS mids${index}, any(c IN checked WHERE c.stopped) AS stopped${index} }`;
}

function laterHop(allowlist: SourceAllowlist, request: PatternRequest, index: number): string {
  const earlier = range(index - 1).map((hop) => `n${hop}`);
  const bound = earlier.map((name) => `e.${name} AS ${name}`).join(', ');
  return `CALL { WITH a, f${index - 1}, mids${index} UNWIND f${index - 1} AS e WITH a, e, mids${index} WHERE e.n${index - 1} IN mids${index} WITH a, e, ${bound} CALL { ${stepRead(allowlist, request, index)} } WITH e, n${index}, r${index} LIMIT $countCap + 1 WITH collect(e{.*, n${index}: n${index}, r${index}: r${index}}) AS found RETURN size(found) > $countCap AS cut${index}, found[..$countCap] AS f${index} }`;
}

/** The members of the stored edges of the shown path for a hop whose relationship rows have no stable ID: every relationship of the type between the two ends, at most `$countCap + 1` of them for each edge. */
function membersOf(request: PatternRequest): { readonly reads: readonly string[]; readonly names: readonly string[] } {
  const reads: string[] = [];
  const names: string[] = [];
  request.steps.forEach((step, offset) => {
    const types = [...new Set(step.branches.filter((branch) => branch.stableId === undefined).map((branch) => quoteName(branch.type)))];
    if (types.length === 0) return;
    const edge = `r${offset + 1}`;
    names.push(`members${offset + 1}`);
    reads.push(`CALL { WITH m WITH m, startNode(m.${edge}) AS s, endNode(m.${edge}) AS e OPTIONAL MATCH (s)-[rr:${types.join('|')}]->(e) WHERE type(rr) = type(m.${edge}) WITH rr LIMIT $countCap + 1 RETURN collect(rr) AS members${offset + 1} }`);
  });
  return { reads, names };
}

/**
 * The statement of a pattern run, from the mapping and the request. The anchor is the first node by element ID with the stable ID. Each step reads, from the nodes the previous step reached, the relationships over its listed types
 * in its direction to nodes of its arrival type that meet its conditions and its window, at most `$countCap + 1` rows for the step, each row carrying its whole path. A node on the path never appears twice on it. Before a step reads from the
 * nodes the previous one reached, a node with more relationships over the step's types than `$countCap` is a supernode and is not traversed, and a node of a type on a stop-list that is on it is not traversed either. The matches are the
 * nodes the last step reached, once each by the first path to them in the order of the stable IDs along the path, ordered by their stable ID, at most `$limit + 1`. Every name comes from the allowlist and every request value is a parameter.
 */
export function patternStatementOf(allowlist: SourceAllowlist, request: PatternRequest): string {
  const count = request.steps.length;
  const anchorLabel = labelOf(allowlist, request.anchor);
  const anchorId = stableIdOf(allowlist, request.anchor);
  const lines = [`MATCH (a:${anchorLabel}) WHERE a.${anchorId} IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`, firstHop(allowlist, request)];
  for (const index of range(count).slice(1)) lines.push(checkBefore(request, index), laterHop(allowlist, request, index));
  const hops = range(count);
  const later = hops.slice(1);
  const bounded = hops.map((index) => `cut${index}`).join(' OR ');
  const heavy = later.length === 0 ? '[]' : later.map((index) => `heavy${index}`).join(' + ');
  const stopped = later.length === 0 ? 'false' : later.map((index) => `stopped${index}`).join(' OR ');
  const order = [`p.n${count}.${stableIdOf(allowlist, request.steps[count - 1]?.arrivesAt ?? '')}`, ...hops.slice(0, -1).map((index) => `p.n${index}.${stableIdOf(allowlist, request.steps[index - 1]?.arrivesAt ?? '')}`)].join(', ');
  const endId = `x.${stableIdOf(allowlist, request.steps[count - 1]?.arrivesAt ?? '')}`;
  lines.push(
    `WITH a, ${bounded} AS bounded, ${heavy} AS heavy, ${stopped} AS stopListed, f${count} AS paths`,
    `CALL { WITH paths UNWIND paths AS p WITH p ORDER BY ${order} WITH p.n${count} AS x, collect(p)[0] AS best ORDER BY ${endId} LIMIT $limit + 1 RETURN collect(best) AS ms }`,
    'UNWIND CASE WHEN size(ms) = 0 THEN [null] ELSE ms END AS m',
  );
  const members = membersOf(request);
  lines.push(...members.reads);
  const mids = `[${hops.slice(0, -1).map((index) => `m.n${index}`).join(', ')}]`;
  const rels = hops.map((index) => `m.r${index} AS r${index}`).join(', ');
  const cut = members.names.length === 0 ? '' : `, ${members.names.join(', ')}, ${members.names.map((name) => `size(${name}) > $countCap`).join(' OR ')} AS membersCut`;
  lines.push(`RETURN a, bounded, heavy[..$limit] AS heavy, stopListed, m.n${count} AS x, ${mids} AS mid, ${rels}, ${count} AS hops${cut}`);
  return lines.join('\n');
}
