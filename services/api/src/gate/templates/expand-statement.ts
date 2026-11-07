import { AppError } from '../../errors.js';
import { quoteName } from '../render.js';
import type { SourceAllowlist } from '../types.js';

export type ExpandDirection = 'out' | 'in' | 'both';

/** The four phases of one neighbor type's order: every undated row comes after every dated one, and stored rows before aggregates within each. */
export const PHASE = { storedDated: 0, aggregateDated: 1, storedUndated: 2, aggregateUndated: 3 } as const;

export const FLAG_NO_STABLE_ID = 'no-stable-id';

export interface ExpandBranch {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly stableId: string | undefined;
  readonly observedAt: string | undefined;
  readonly direction: 'out' | 'in';
  /** True when the row joins the entity type to itself and both directions are read, so a relationship from the node to itself is read once, as `out`. */
  readonly excludesLoops: boolean;
}

/**
 * The mapping rows that join the node's entity type to the neighbor type, one branch for each row and direction asked: a row leaves the node when the type is its `from` and enters it when the type is
 * its `to`. `relTypes`, when given, keeps only the rows of those relationship types.
 */
export function expandBranchesOf(allowlist: SourceAllowlist, anchorType: string, neighborType: string, relTypes: readonly string[] | undefined, direction: ExpandDirection): readonly ExpandBranch[] {
  const branches: ExpandBranch[] = [];
  for (const row of allowlist.relationshipRows) {
    if (relTypes !== undefined && !relTypes.includes(row.type)) continue;
    const out = direction !== 'in' && row.from === anchorType && row.to === neighborType;
    const into = direction !== 'out' && row.to === anchorType && row.from === neighborType;
    const base = { type: row.type, from: row.from, to: row.to, stableId: row.stableId, observedAt: row.observedAt };
    const both = out && into && row.from === row.to;
    if (out) branches.push({ ...base, direction: 'out', excludesLoops: false });
    if (into) branches.push({ ...base, direction: 'in', excludesLoops: both });
  }
  return branches;
}

const COLUMNS = ['phase', 'tk', 'ts', 'id', 'rtype', 'dir', 'ntype', 'flag', 'members', 'first', 'rel', 'm'] as const;

/** The kinds of sort value that the order can compare, and the rank each has: values of different kinds are never compared, the kind's rank orders them. Any other value is read as no sort value. */
const supported = (value: string): string =>
  `(${['ZONED DATETIME', 'LOCAL DATETIME', 'DATE', 'ZONED TIME', 'LOCAL TIME', 'INTEGER', 'FLOAT', 'STRING'].map((kind) => `${value} IS :: ${kind} NOT NULL`).join(' OR ')})`;

const kindRank = (value: string): string =>
  `CASE WHEN ${value} IS :: ZONED DATETIME NOT NULL THEN 1 WHEN ${value} IS :: LOCAL DATETIME NOT NULL THEN 2 WHEN ${value} IS :: DATE NOT NULL THEN 3 WHEN ${value} IS :: ZONED TIME NOT NULL THEN 4 WHEN ${value} IS :: LOCAL TIME NOT NULL THEN 5 WHEN ${value} IS :: INTEGER NOT NULL OR ${value} IS :: FLOAT NOT NULL THEN 6 ELSE 7 END`;

const SORT_VALUE_OF_CURSOR =
  "CASE $cursor.tk WHEN 1 THEN datetime($cursor.ts) WHEN 2 THEN localdatetime($cursor.ts) WHEN 3 THEN date($cursor.ts) WHEN 4 THEN time($cursor.ts) WHEN 5 THEN localtime($cursor.ts) WHEN 6 THEN CASE WHEN $cursor.ts IS :: STRING NOT NULL THEN toInteger($cursor.ts) ELSE $cursor.ts END ELSE $cursor.ts END";

/** The rows of one phase that come after the cursor: any row of a later phase, and in the same phase the rows after it in the order (kind rank ascending for dated rows, then sort value, ID text, relationship type and direction, descending). */
function afterCursor(phase: number, dated: boolean, sort: string, id: string, rtype: string, direction: string): string {
  const tie = `(${id} < $cursor.id OR (${id} = $cursor.id AND (${rtype} < $cursor.rtype OR (${rtype} = $cursor.rtype AND ${direction} < $cursor.dir))))`;
  const same = dated ? `(${kindRank(sort)} > $cursor.tk OR (${kindRank(sort)} = $cursor.tk AND (${sort} < ${SORT_VALUE_OF_CURSOR} OR (${sort} = ${SORT_VALUE_OF_CURSOR} AND ${tie}))))` : tie;
  return `($cursor IS NULL OR ${phase} > $cursor.phase OR (${phase} = $cursor.phase AND ${same}))`;
}

const usable = (id: string): string => `((${id} IS :: STRING NOT NULL AND ${id} <> '') OR ${id} IS :: INTEGER NOT NULL)`;

const patternOf = (branch: ExpandBranch, neighborLabel: string): string =>
  branch.direction === 'out' ? `(a)-[r:${quoteName(branch.type)}]->(m:${quoteName(neighborLabel)})` : `(a)<-[r:${quoteName(branch.type)}]-(m:${quoteName(neighborLabel)})`;

const returnOf = (values: Readonly<Record<(typeof COLUMNS)[number], string>>): string => `RETURN ${COLUMNS.map((column) => `${values[column]} AS ${column}`).join(', ')}`;

function storedBranch(branch: ExpandBranch, neighborLabel: string, stableId: string, dated: boolean): string {
  const id = `r.${quoteName(stableId)}`;
  const sort = branch.observedAt === undefined ? 'null' : `r.${quoteName(branch.observedAt)}`;
  const phase = dated ? PHASE.storedDated : PHASE.storedUndated;
  const where = [usable(id), ...(branch.observedAt === undefined ? [] : [dated ? supported(sort) : `NOT coalesce(${supported(sort)}, false)`]), ...(branch.excludesLoops ? ['m <> a'] : []), afterCursor(phase, dated, sort, `toString(${id})`, 'type(r)', `'${branch.direction}'`)];
  return [
    `WITH a MATCH ${patternOf(branch, neighborLabel)} WHERE ${where.join(' AND ')}`,
    `WITH a, r, m ORDER BY ${dated ? `${kindRank(sort)}, ${sort} DESC, ` : ''}toString(${id}) DESC LIMIT $limit + 1`,
    returnOf({ phase: String(phase), tk: dated ? kindRank(sort) : 'null', ts: dated ? sort : 'null', id: `toString(${id})`, rtype: 'type(r)', dir: `'${branch.direction}'`, ntype: 'null', flag: 'null', members: 'null', first: 'null', rel: 'r', m: 'm' }),
  ].join(' ');
}

function aggregateBranch(branch: ExpandBranch, neighborLabel: string, neighborStableId: string, dated: boolean, fallbackForId: string | undefined): string {
  const sort = branch.observedAt === undefined ? 'null' : `r.${quoteName(branch.observedAt)}`;
  const phase = dated ? PHASE.aggregateDated : PHASE.aggregateUndated;
  const members = [...(fallbackForId === undefined ? [] : [`NOT ${usable(`r.${quoteName(fallbackForId)}`)}`]), ...(branch.excludesLoops ? ['m <> a'] : [])];
  const id = `coalesce(toString(m.${quoteName(neighborStableId)}), '')`;
  return [
    `WITH a MATCH ${patternOf(branch, neighborLabel)}${members.length === 0 ? '' : ` WHERE ${members.join(' AND ')}`}`,
    `WITH a, m, type(r) AS rtype, count(r) AS members, ${branch.observedAt === undefined ? 'null' : `max(CASE WHEN ${supported(sort)} THEN ${sort} END)`} AS ts, ${branch.observedAt === undefined ? 'null' : `min(CASE WHEN ${supported(sort)} THEN ${sort} END)`} AS first, ${id} AS id`,
    `WHERE ts IS ${dated ? 'NOT ' : ''}NULL AND ${afterCursor(phase, dated, 'ts', 'id', 'rtype', `'${branch.direction}'`)}`,
    `WITH a, m, rtype, members, ts, first, id ORDER BY ${dated ? `${kindRank('ts')}, ts DESC, ` : ''}id DESC LIMIT $limit + 1`,
    returnOf({
      phase: String(phase),
      tk: dated ? kindRank('ts') : 'null',
      ts: dated ? 'ts' : 'null',
      id: 'id',
      rtype: 'rtype',
      dir: `'${branch.direction}'`,
      ntype: '$neighborType',
      flag: fallbackForId === undefined ? 'null' : `'${FLAG_NO_STABLE_ID}'`,
      members: 'members',
      first: 'first',
      rel: 'null',
      m: 'm',
    }),
  ].join(' ');
}

/** The statement of one page of one neighbor type: the anchor, then the union of the branches, then the order and the cut of the whole page. */
export function expandStatementOf(allowlist: SourceAllowlist, anchorType: string, neighborType: string, branches: readonly ExpandBranch[]): string {
  const anchorLabel = allowlist.entityLabels.get(anchorType);
  const anchorId = allowlist.stableIds.get(anchorType);
  const neighborLabel = allowlist.entityLabels.get(neighborType);
  const neighborId = allowlist.stableIds.get(neighborType);
  if (anchorLabel === undefined || anchorId === undefined || neighborLabel === undefined || neighborId === undefined || branches.length === 0) throw new AppError('INVALID_REQUEST');
  const parts = branches.flatMap((branch) => {
    const dated = branch.observedAt !== undefined;
    if (branch.stableId === undefined) return [...(dated ? [aggregateBranch(branch, neighborLabel, neighborId, true, undefined)] : []), aggregateBranch(branch, neighborLabel, neighborId, false, undefined)];
    return [
      ...(dated ? [storedBranch(branch, neighborLabel, branch.stableId, true)] : []),
      storedBranch(branch, neighborLabel, branch.stableId, false),
      ...(dated ? [aggregateBranch(branch, neighborLabel, neighborId, true, branch.stableId)] : []),
      aggregateBranch(branch, neighborLabel, neighborId, false, branch.stableId),
    ];
  });
  return [
    `MATCH (a:${quoteName(anchorLabel)}) WHERE a.${quoteName(anchorId)} IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`,
    `OPTIONAL CALL { ${parts.join(' UNION ALL ')} }`,
    `RETURN a, ${COLUMNS.join(', ')} ORDER BY phase, tk, ts DESC, id DESC, rtype DESC, dir DESC LIMIT $limit + 1`,
  ].join('\n');
}
