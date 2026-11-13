import { AppError } from '../../errors.js';
import { quoteName } from '../render.js';
import { inWindow } from './window-condition.js';
import type { Params, SourceAllowlist } from '../types.js';

/** The attribute nodes shown for one match; a match that shares more says so with a notice. */
export const EVIDENCE_NODES_PER_MATCH = 5;

export interface SharedAttributeRequest {
  readonly anchor: string;
  readonly attribute: string;
  readonly via: string;
  readonly observedAt: string | undefined;
  readonly stopListProperties: readonly string[];
  readonly windowed: boolean;
}

/** What the request names, checked against the mapping: both entity types, and the row that joins the anchor's type to the attribute's type by the relationship type in that direction. */
export function sharedAttributeRequestOf(allowlist: SourceAllowlist, params: Params): SharedAttributeRequest {
  const [anchor, attribute, via] = [params['entityType'], params['attributeType'], params['via']];
  if (typeof anchor !== 'string' || typeof attribute !== 'string' || typeof via !== 'string') throw new AppError('INVALID_REQUEST');
  const row = allowlist.relationshipRows.find((candidate) => candidate.type === via && candidate.from === anchor && candidate.to === attribute);
  if (row === undefined) throw new AppError('INVALID_REQUEST');
  const windowed = params['windowFrom'] !== undefined;
  if (windowed && row.observedAt === undefined) throw new AppError('INVALID_REQUEST');
  const stopListProperties = (allowlist.derivedRules ?? [])
    .filter((rule) => rule.from === anchor && rule.to === anchor && rule.via.length === 3 && rule.via[0] === via && rule.via[1] === attribute && rule.via[2] === via)
    .flatMap((rule) => (rule.stopListProperty === undefined ? [] : [rule.stopListProperty]));
  return { anchor, attribute, via, observedAt: row.observedAt, stopListProperties, windowed };
}

const where = (conditions: readonly string[]): string => (conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`);

interface Pieces {
  readonly anchor: string;
  readonly attribute: string;
  readonly via: string;
  readonly within: (variable: string) => readonly string[];
  readonly stopFree: (variable: string) => readonly string[];
  /** The three clauses both the run and its count read begin with: the anchor, whether it holds a stop-listed attribute node, and its attribute nodes (at most `$countCap + 1` of them, kept to the cap). */
  readonly head: readonly string[];
}

function piecesOf(allowlist: SourceAllowlist, request: SharedAttributeRequest): Pieces {
  const [anchorLabel, attributeLabel] = [allowlist.entityLabels.get(request.anchor), allowlist.entityLabels.get(request.attribute)];
  const stableId = allowlist.stableIds.get(request.anchor);
  if (anchorLabel === undefined || attributeLabel === undefined || stableId === undefined) throw new AppError('INVALID_REQUEST');
  const [anchor, attribute, via] = [quoteName(anchorLabel), quoteName(attributeLabel), quoteName(request.via)];
  const time = request.observedAt === undefined ? '' : quoteName(request.observedAt);
  const withinWindow = (variable: string): readonly string[] => (request.windowed ? inWindow(variable, time) : []);
  const stopFree = (variable: string): readonly string[] => request.stopListProperties.map((property) => `coalesce(${variable}.${quoteName(property)}, false) <> true`);
  const stopListed = request.stopListProperties.map((property) => `coalesce(s.${quoteName(property)}, false) = true`).join(' OR ');
  const skipped =
    request.stopListProperties.length === 0
      ? 'WITH a, false AS skipped'
      : `CALL { WITH a OPTIONAL MATCH (a)-[:${via}]->(s:${attribute}) WHERE ${stopListed} WITH s LIMIT 1 RETURN count(s) > 0 AS skipped }`;
  const head = [
    `MATCH (a:${anchor}) WHERE a.${quoteName(stableId)} IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`,
    skipped,
    `CALL { WITH a MATCH (a)-[ra:${via}]->(x:${attribute})${where([...stopFree('x'), ...withinWindow('ra')])} WITH DISTINCT x LIMIT $countCap + 1 WITH collect(x) AS mine RETURN size(mine) > $countCap AS anchorBounded, mine[..$countCap] AS xs }`,
  ];
  return { anchor, attribute, via, within: withinWindow, stopFree, head };
}

/** The clauses the statement of a run and the statement of its count share (one text, so the two cannot drift): the anchor, the stop-list check and the anchor's attribute nodes. */
export function sharedAttributeHeadOf(allowlist: SourceAllowlist, request: SharedAttributeRequest): readonly string[] {
  return piecesOf(allowlist, request).head;
}

/**
 * The statement of a shared-attribute run, from the mapping: the anchor (the first node by element ID with the stable ID), whether it holds a stop-listed attribute node, its attribute nodes (at most `$countCap + 1` of them), the
 * pairs of another node of the anchor's type and one of those attribute nodes (at most `$countCap + 1`), then the other nodes that share at least `$minShared` of them, at most `$limit + 1`, each with the first
 * relationship of each side for at most `EVIDENCE_NODES_PER_MATCH` of the shared nodes. The result is one row for each match, or one row with no match, each row holding the flags of the read.
 */
export function sharedAttributeStatementOf(allowlist: SourceAllowlist, request: SharedAttributeRequest): string {
  const { anchor, via, within, head } = piecesOf(allowlist, request);
  return [
    ...head,
    `CALL { WITH a, xs UNWIND xs AS x MATCH (x)<-[rb:${via}]-(b:${anchor})${where(['b <> a', ...within('rb')])} WITH DISTINCT b, x LIMIT $countCap + 1 WITH collect({b: b, x: x}) AS pairs RETURN size(pairs) > $countCap AS pairsBounded, pairs[..$countCap] AS kept }`,
    [
      'CALL { WITH a, kept UNWIND kept AS q WITH a, q.b AS b, collect(q.x) AS xs WHERE size(xs) >= $minShared WITH a, b, xs ORDER BY elementId(b) LIMIT $limit + 1',
      `CALL { WITH a, b, xs UNWIND xs[..${EVIDENCE_NODES_PER_MATCH}] AS x`,
      `CALL { WITH a, x MATCH (a)-[ra:${via}]->(x)${where(within('ra'))} RETURN ra LIMIT 1 }`,
      `CALL { WITH b, x MATCH (b)-[rb:${via}]->(x)${where(within('rb'))} RETURN rb LIMIT 1 }`,
      `RETURN collect(x) AS shown, collect(ra) AS ras, collect(rb) AS rbs }`,
      `RETURN collect({b: b, shown: shown, ras: ras, rbs: rbs, shared: size(xs), cut: size(xs) > ${EVIDENCE_NODES_PER_MATCH}}) AS ms }`,
    ].join(' '),
    'UNWIND CASE WHEN size(ms) = 0 THEN [null] ELSE ms END AS m',
    'RETURN a, skipped, anchorBounded OR pairsBounded AS bounded, m.b AS b, m.shown AS xs, m.ras AS ras, m.rbs AS rbs, m.shared AS shared, m.cut AS evidenceCut',
  ].join('\n');
}

/**
 * The statement of the count of a shared-attribute run, from the mapping: the same first clauses as the run, then the distinct other nodes that hold at least `$minShared` attribute nodes of the anchor's (found again from each candidate through the anchor, and read only as far as `$minShared` of them, so the candidate's own check stops there), streamed and
 * stopped at `$countCap + 1` (the count's own read, not the run's pair read, which is kept to the cap), counted. One row: the number of matches read, `anchorBounded` and `skipped`; no row when the anchor is not found.
 * A count of `$countCap + 1` means the run would return more than the threshold. It returns numbers and flags, never a node or a relationship.
 */
export function sharedAttributeCountStatementOf(allowlist: SourceAllowlist, request: SharedAttributeRequest): string {
  const { anchor, attribute, via, within, stopFree, head } = piecesOf(allowlist, request);
  const shares = `MATCH (b)-[rc:${via}]->(y:${attribute})<-[ra:${via}]-(a)${where([...stopFree('y'), ...within('rc'), ...within('ra')])}`;
  return [
    ...head,
    `CALL { WITH a, xs UNWIND xs AS x MATCH (x)<-[rb:${via}]-(b:${anchor})${where(['b <> a', ...within('rb')])} WITH DISTINCT a, b CALL { WITH a, b ${shares} WITH DISTINCT y LIMIT $minShared RETURN count(y) AS shared } WITH b, shared WHERE shared >= $minShared WITH b LIMIT $countCap + 1 RETURN count(b) AS matches }`,
    'RETURN matches, anchorBounded, skipped',
  ].join('\n');
}
