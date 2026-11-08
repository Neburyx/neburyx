import type { ExpandFilter, ExpandRank, FilterKind } from '@neburyx/contracts';
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

const KIND_TYPE: Readonly<Record<FilterKind, string>> = { text: 'STRING', number: 'FLOAT', boolean: 'BOOLEAN', date: 'DATE', dateTime: 'ZONED DATETIME', localDateTime: 'LOCAL DATETIME', time: 'ZONED TIME', localTime: 'LOCAL TIME' };
const KIND_FUNCTION: Readonly<Record<FilterKind, string | undefined>> = { text: undefined, number: undefined, boolean: undefined, date: 'date', dateTime: 'datetime', localDateTime: 'localdatetime', time: 'time', localTime: 'localtime' };

/** True when the stored value is of the kind the filter compares with: a value of another kind never matches, and is never an error. */
const kindGuard = (kind: FilterKind, stored: string): string => (kind === 'number' ? `(${stored} IS :: INTEGER NOT NULL OR ${stored} IS :: FLOAT NOT NULL)` : `${stored} IS :: ${KIND_TYPE[kind]} NOT NULL`);
const kindValue = (kind: FilterKind, parameter: string): string => (KIND_FUNCTION[kind] === undefined ? parameter : `${KIND_FUNCTION[kind]}(${parameter})`);

/** The properties a branch's rows must declare `filterable` for the filters to apply: the neighbor type's, and the mapping row's (its `observed_at` is declared without being listed). */
export function undeclaredFilter(allowlist: SourceAllowlist, neighborType: string, branches: readonly ExpandBranch[], filters: readonly ExpandFilter[]): ExpandFilter | undefined {
  return filters.find((filter) => {
    if (filter.on === 'neighbor') return allowlist.filterableProperties?.get(neighborType)?.includes(filter.property) !== true;
    return !branches.every((branch) => {
      const row = allowlist.relationshipRows.find((candidate) => candidate.type === branch.type && candidate.from === branch.from && candidate.to === branch.to);
      return row !== undefined && (row.filterable?.includes(filter.property) === true || row.observedAt === filter.property);
    });
  });
}

/** The rank, when it names a property that the mapping does not declare sortable for the neighbor type, or for a row read (a row's observed time is declared). */
export function undeclaredRank(allowlist: SourceAllowlist, neighborType: string, branches: readonly ExpandBranch[], rank: ExpandRank): boolean {
  if (rank.on === 'neighbor') return allowlist.sortableProperties?.get(neighborType)?.includes(rank.property) !== true;
  return !branches.every((branch) => {
    const row = allowlist.relationshipRows.find((candidate) => candidate.type === branch.type && candidate.from === branch.from && candidate.to === branch.to);
    return row !== undefined && (row.sortable?.includes(rank.property) === true || row.observedAt === rank.property);
  });
}

/**
 * The condition of one filter on one row of a branch, written from the property the mapping declares and a fixed operator; every value stays a parameter, read from `$filters` by the position of the
 * filter in the request. A stored value of another kind than the filter's makes the condition false.
 */
function predicateOf(filter: ExpandFilter, index: number): string {
  const stored = `${filter.on === 'neighbor' ? 'm' : 'r'}.${quoteName(filter.property)}`;
  const at = `$filters[${index}]`;
  if (filter.op === 'eq') return `(${kindGuard(filter.value.kind, stored)} AND ${stored} = ${kindValue(filter.value.kind, `${at}.value.value`)})`;
  if (filter.op === 'in') return `(${kindGuard(filter.values[0]?.kind ?? 'text', stored)} AND ${stored} IN [v IN ${at}.values | ${kindValue(filter.values[0]?.kind ?? 'text', 'v.value')}])`;
  const kind = (filter.from ?? filter.to)?.kind ?? 'text';
  return `(${[kindGuard(kind, stored), ...(filter.from === undefined ? [] : [`${stored} >= ${kindValue(kind, `${at}.from.value`)}`]), ...(filter.to === undefined ? [] : [`${stored} <= ${kindValue(kind, `${at}.to.value`)}`])].join(' AND ')})`;
}

const predicatesOf = (filters: readonly ExpandFilter[]): string[] => filters.map(predicateOf);

const COLUMNS = ['phase', 'tk', 'ts', 'id', 'rtype', 'dir', 'ntype', 'flag', 'members', 'first', 'rel', 'm'] as const;
/** The columns of a ranked read: the kind and value that order the rows are `sk` and `sv`, and `ts` and `first` stay the observed times that an aggregate reports as its last and earliest. */
const RANKED_COLUMNS = ['phase', 'sk', 'sv', 'ts', 'id', 'rtype', 'dir', 'ntype', 'flag', 'members', 'first', 'rel', 'm'] as const;
type Column = (typeof RANKED_COLUMNS)[number] | (typeof COLUMNS)[number];

/** How the rows of one read are ordered: by the observed time of the mapping row, newest first (no rank), or by the property a rank names, in its order. */
interface Order {
  readonly rank: ExpandRank | undefined;
  /** The comparison that keeps the rows after the cursor in the order of the sort value. */
  readonly after: '<' | '>';
  readonly direction: 'DESC' | 'ASC';
  /** The names of the columns that hold the kind and the value of the sort. */
  readonly kind: 'tk' | 'sk';
  readonly value: 'ts' | 'sv';
}
const orderOf = (rank: ExpandRank | undefined): Order =>
  rank === undefined ? { rank, after: '<', direction: 'DESC', kind: 'tk', value: 'ts' } : { rank, after: rank.order === 'asc' ? '>' : '<', direction: rank.order === 'asc' ? 'ASC' : 'DESC', kind: 'sk', value: 'sv' };

/** The kinds of sort value that the order can compare, and the rank each has: values of different kinds are never compared, the kind's rank orders them. Any other value is read as no sort value. */
const supported = (value: string): string =>
  `(${['ZONED DATETIME', 'LOCAL DATETIME', 'DATE', 'ZONED TIME', 'LOCAL TIME', 'INTEGER', 'FLOAT', 'STRING'].map((kind) => `${value} IS :: ${kind} NOT NULL`).join(' OR ')})`;

const kindRank = (value: string): string =>
  `CASE WHEN ${value} IS :: ZONED DATETIME NOT NULL THEN 1 WHEN ${value} IS :: LOCAL DATETIME NOT NULL THEN 2 WHEN ${value} IS :: DATE NOT NULL THEN 3 WHEN ${value} IS :: ZONED TIME NOT NULL THEN 4 WHEN ${value} IS :: LOCAL TIME NOT NULL THEN 5 WHEN ${value} IS :: INTEGER NOT NULL OR ${value} IS :: FLOAT NOT NULL THEN 6 ELSE 7 END`;

const SORT_VALUE_OF_CURSOR =
  "CASE $cursor.tk WHEN 1 THEN datetime($cursor.ts) WHEN 2 THEN localdatetime($cursor.ts) WHEN 3 THEN date($cursor.ts) WHEN 4 THEN time($cursor.ts) WHEN 5 THEN localtime($cursor.ts) WHEN 6 THEN CASE WHEN $cursor.ts IS :: STRING NOT NULL THEN toInteger($cursor.ts) ELSE $cursor.ts END ELSE $cursor.ts END";

/** The rows of one phase that come after the cursor: any row of a later phase, and in the same phase the rows after it in the order (kind rank ascending for dated rows, then sort value, ID text, relationship type and direction, descending). */
function afterCursor(phase: number, dated: boolean, sort: string, id: string, rtype: string, direction: string, order: Order): string {
  const tie = `(${id} < $cursor.id OR (${id} = $cursor.id AND (${rtype} < $cursor.rtype OR (${rtype} = $cursor.rtype AND ${direction} < $cursor.dir))))`;
  const same = dated ? `(${kindRank(sort)} > $cursor.tk OR (${kindRank(sort)} = $cursor.tk AND (${sort} ${order.after} ${SORT_VALUE_OF_CURSOR} OR (${sort} = ${SORT_VALUE_OF_CURSOR} AND ${tie}))))` : tie;
  return `($cursor IS NULL OR ${phase} > $cursor.phase OR (${phase} = $cursor.phase AND ${same}))`;
}

const usable = (id: string): string => `((${id} IS :: STRING NOT NULL AND ${id} <> '') OR ${id} IS :: INTEGER NOT NULL)`;

const patternOf = (branch: ExpandBranch, neighborLabel: string): string =>
  branch.direction === 'out' ? `(a)-[r:${quoteName(branch.type)}]->(m:${quoteName(neighborLabel)})` : `(a)<-[r:${quoteName(branch.type)}]-(m:${quoteName(neighborLabel)})`;

const returnOf = (values: Readonly<Partial<Record<Column, string>>>, order: Order): string =>
  `RETURN ${(order.rank === undefined ? COLUMNS : RANKED_COLUMNS).map((column) => `${values[column] ?? 'null'} AS ${column}`).join(', ')}`;

/** The property a rank orders by, read from the neighbor or from the relationship. */
const rankedValue = (rank: ExpandRank): string => `${rank.on === 'neighbor' ? 'm' : 'r'}.${quoteName(rank.property)}`;

/** What a branch orders by: the property of the rank, or the observed time of its mapping row; `undefined` when the branch has nothing to order by, and every row of it is then undated. */
const sortOf = (branch: ExpandBranch, order: Order): string | undefined =>
  order.rank !== undefined ? rankedValue(order.rank) : branch.observedAt === undefined ? undefined : `r.${quoteName(branch.observedAt)}`;

function storedBranch(branch: ExpandBranch, neighborLabel: string, stableId: string, dated: boolean, filters: readonly ExpandFilter[], order: Order): string {
  const id = `r.${quoteName(stableId)}`;
  const given = sortOf(branch, order);
  const sort = given ?? 'null';
  const phase = dated ? PHASE.storedDated : PHASE.storedUndated;
  const where = [usable(id), ...(given === undefined ? [] : [dated ? supported(sort) : `NOT coalesce(${supported(sort)}, false)`]), ...(branch.excludesLoops ? ['m <> a'] : []), ...predicatesOf(filters), afterCursor(phase, dated, sort, `toString(${id})`, 'type(r)', `'${branch.direction}'`, order)];
  return [
    `WITH a MATCH ${patternOf(branch, neighborLabel)} WHERE ${where.join(' AND ')}`,
    `WITH a, r, m ORDER BY ${dated ? `${kindRank(sort)}, ${sort} ${order.direction}, ` : ''}toString(${id}) DESC LIMIT $limit + 1`,
    returnOf({ phase: String(phase), [order.kind]: dated ? kindRank(sort) : 'null', [order.value]: dated ? sort : 'null', id: `toString(${id})`, rtype: 'type(r)', dir: `'${branch.direction}'`, ntype: 'null', flag: 'null', members: 'null', first: 'null', rel: 'r', m: 'm' }, order),
  ].join(' ');
}

function aggregateBranch(branch: ExpandBranch, neighborLabel: string, neighborStableId: string, dated: boolean, fallbackForId: string | undefined, filters: readonly ExpandFilter[], order: Order): string {
  const observed = branch.observedAt === undefined ? 'null' : `r.${quoteName(branch.observedAt)}`;
  const phase = dated ? PHASE.aggregateDated : PHASE.aggregateUndated;
  const members = [...(fallbackForId === undefined ? [] : [`NOT ${usable(`r.${quoteName(fallbackForId)}`)}`]), ...(branch.excludesLoops ? ['m <> a'] : []), ...predicatesOf(filters)];
  const id = `coalesce(toString(m.${quoteName(neighborStableId)}), '')`;
  const observedTimes = `${branch.observedAt === undefined ? 'null' : `max(CASE WHEN ${supported(observed)} THEN ${observed} END)`} AS ts, ${branch.observedAt === undefined ? 'null' : `min(CASE WHEN ${supported(observed)} THEN ${observed} END)`} AS first`;
  if (order.rank === undefined) {
    return [
      `WITH a MATCH ${patternOf(branch, neighborLabel)}${members.length === 0 ? '' : ` WHERE ${members.join(' AND ')}`}`,
      `WITH a, m, type(r) AS rtype, count(r) AS members, ${observedTimes}, ${id} AS id`,
      `WHERE ts IS ${dated ? 'NOT ' : ''}NULL AND ${afterCursor(phase, dated, 'ts', 'id', 'rtype', `'${branch.direction}'`, order)}`,
      `WITH a, m, rtype, members, ts, first, id ORDER BY ${dated ? `${kindRank('ts')}, ts DESC, ` : ''}id DESC LIMIT $limit + 1`,
      returnOf({ phase: String(phase), tk: dated ? kindRank('ts') : 'null', ts: dated ? 'ts' : 'null', id: 'id', rtype: 'rtype', dir: `'${branch.direction}'`, ntype: '$neighborType', flag: fallbackForId === undefined ? 'null' : `'${FLAG_NO_STABLE_ID}'`, members: 'members', first: 'first', rel: 'null', m: 'm' }, order),
    ].join(' ');
  }
  // a ranked aggregate is ordered by the largest (descending) or smallest (ascending) comparable value among its matching relationships, or by the neighbor's own value
  const ranked = rankedValue(order.rank);
  const reduce = order.rank.order === 'asc' ? 'min' : 'max';
  const sortValue = order.rank.on === 'neighbor' ? `CASE WHEN ${supported(ranked)} THEN ${ranked} END` : `${reduce}(CASE WHEN ${supported(ranked)} THEN ${ranked} END)`;
  return [
    `WITH a MATCH ${patternOf(branch, neighborLabel)}${members.length === 0 ? '' : ` WHERE ${members.join(' AND ')}`}`,
    `WITH a, m, type(r) AS rtype, count(r) AS members, ${observedTimes}, ${sortValue} AS sv, ${id} AS id`,
    `WHERE sv IS ${dated ? 'NOT ' : ''}NULL AND ${afterCursor(phase, dated, 'sv', 'id', 'rtype', `'${branch.direction}'`, order)}`,
    `WITH a, m, rtype, members, ts, first, sv, id ORDER BY ${dated ? `${kindRank('sv')}, sv ${order.direction}, ` : ''}id DESC LIMIT $limit + 1`,
    returnOf({ phase: String(phase), sk: dated ? kindRank('sv') : 'null', sv: dated ? 'sv' : 'null', ts: 'ts', id: 'id', rtype: 'rtype', dir: `'${branch.direction}'`, ntype: '$neighborType', flag: fallbackForId === undefined ? 'null' : `'${FLAG_NO_STABLE_ID}'`, members: 'members', first: 'first', rel: 'null', m: 'm' }, order),
  ].join(' ');
}

/** The statement of one page of one neighbor type: the anchor, then the union of the branches, then the order and the cut of the whole page. */
export function expandStatementOf(allowlist: SourceAllowlist, anchorType: string, neighborType: string, branches: readonly ExpandBranch[], filters: readonly ExpandFilter[] = [], rank?: ExpandRank): string {
  const order = orderOf(rank);
  const anchorLabel = allowlist.entityLabels.get(anchorType);
  const anchorId = allowlist.stableIds.get(anchorType);
  const neighborLabel = allowlist.entityLabels.get(neighborType);
  const neighborId = allowlist.stableIds.get(neighborType);
  if (anchorLabel === undefined || anchorId === undefined || neighborLabel === undefined || neighborId === undefined || branches.length === 0) throw new AppError('INVALID_REQUEST');
  const parts = branches.flatMap((branch) => {
    const dated = rank !== undefined || branch.observedAt !== undefined;
    if (branch.stableId === undefined) return [...(dated ? [aggregateBranch(branch, neighborLabel, neighborId, true, undefined, filters, order)] : []), aggregateBranch(branch, neighborLabel, neighborId, false, undefined, filters, order)];
    return [
      ...(dated ? [storedBranch(branch, neighborLabel, branch.stableId, true, filters, order)] : []),
      storedBranch(branch, neighborLabel, branch.stableId, false, filters, order),
      ...(dated ? [aggregateBranch(branch, neighborLabel, neighborId, true, branch.stableId, filters, order)] : []),
      aggregateBranch(branch, neighborLabel, neighborId, false, branch.stableId, filters, order),
    ];
  });
  return [
    `MATCH (a:${quoteName(anchorLabel)}) WHERE a.${quoteName(anchorId)} IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`,
    `OPTIONAL CALL { ${parts.join(' UNION ALL ')} }`,
    `RETURN a, ${(rank === undefined ? COLUMNS : RANKED_COLUMNS).join(', ')} ORDER BY phase, ${order.kind}, ${order.value} ${order.direction}, id DESC, rtype DESC, dir DESC LIMIT $limit + 1`,
  ].join('\n');
}

/**
 * The statement of the count that goes with a filtered expansion: how many relationships the branches match for the filters, one number, read from the same anchor with the same conditions and no
 * cursor, order or limit. It reads what a page reads, so it is bounded by the same transaction timeout, and it is exact or it fails; it is never cut short.
 */
export function expandCountStatementOf(allowlist: SourceAllowlist, anchorType: string, neighborType: string, branches: readonly ExpandBranch[], filters: readonly ExpandFilter[]): string {
  const anchorLabel = allowlist.entityLabels.get(anchorType);
  const anchorId = allowlist.stableIds.get(anchorType);
  const neighborLabel = allowlist.entityLabels.get(neighborType);
  if (anchorLabel === undefined || anchorId === undefined || neighborLabel === undefined || branches.length === 0 || filters.length === 0) throw new AppError('INVALID_REQUEST');
  const parts = branches.map((branch) => {
    const where = [...(branch.excludesLoops ? ['m <> a'] : []), ...predicatesOf(filters)];
    return `WITH a MATCH ${patternOf(branch, neighborLabel)} WHERE ${where.join(' AND ')} RETURN count(r) AS c`;
  });
  return [
    `MATCH (a:${quoteName(anchorLabel)}) WHERE a.${quoteName(anchorId)} IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`,
    `CALL { ${parts.join(' UNION ALL ')} }`,
    'RETURN sum(c) AS total',
  ].join('\n');
}
