import { AppError } from '../../errors.js';
import { quoteName } from '../render.js';
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

/**
 * The statement of a shared-attribute run, from the mapping: the anchor (the first node by element ID with the stable ID), whether it holds a stop-listed attribute node, its attribute nodes (at most `$countCap + 1` of them), the
 * pairs of another node of the anchor's type and one of those attribute nodes (at most `$countCap + 1`), then the other nodes that share at least `$minShared` of them, at most `$limit + 1`, each with the first
 * relationship of each side for at most `EVIDENCE_NODES_PER_MATCH` of the shared nodes. The result is one row for each match, or one row with no match, each row holding the flags of the read.
 */
export function sharedAttributeStatementOf(allowlist: SourceAllowlist, request: SharedAttributeRequest): string {
  const [anchorLabel, attributeLabel] = [allowlist.entityLabels.get(request.anchor), allowlist.entityLabels.get(request.attribute)];
  const stableId = allowlist.stableIds.get(request.anchor);
  if (anchorLabel === undefined || attributeLabel === undefined || stableId === undefined) throw new AppError('INVALID_REQUEST');
  const [anchor, attribute, via] = [quoteName(anchorLabel), quoteName(attributeLabel), quoteName(request.via)];
  const time = request.observedAt === undefined ? '' : quoteName(request.observedAt);
  const instant = (variable: string): string =>
    `CASE WHEN ${variable}.${time} IS :: ZONED DATETIME THEN ${variable}.${time} WHEN ${variable}.${time} IS :: LOCAL DATETIME THEN datetime({datetime: ${variable}.${time}, timezone: 'UTC'}) WHEN ${variable}.${time} IS :: DATE THEN datetime({date: ${variable}.${time}, timezone: 'UTC'}) END`;
  const inWindow = (variable: string): readonly string[] => (request.windowed ? [`${instant(variable)} >= datetime($windowFrom)`, `${instant(variable)} < datetime($windowTo)`] : []);
  const stopFree = (variable: string): readonly string[] => request.stopListProperties.map((property) => `coalesce(${variable}.${quoteName(property)}, false) <> true`);
  const stopListed = request.stopListProperties.map((property) => `coalesce(s.${quoteName(property)}, false) = true`).join(' OR ');
  const skipped =
    request.stopListProperties.length === 0
      ? 'WITH a, false AS skipped'
      : `CALL { WITH a OPTIONAL MATCH (a)-[:${via}]->(s:${attribute}) WHERE ${stopListed} WITH s LIMIT 1 RETURN count(s) > 0 AS skipped }`;
  return [
    `MATCH (a:${anchor}) WHERE a.${quoteName(stableId)} IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`,
    skipped,
    `CALL { WITH a MATCH (a)-[ra:${via}]->(x:${attribute})${where([...stopFree('x'), ...inWindow('ra')])} WITH DISTINCT x LIMIT $countCap + 1 WITH collect(x) AS mine RETURN size(mine) > $countCap AS anchorBounded, mine[..$countCap] AS xs }`,
    `CALL { WITH a, xs UNWIND xs AS x MATCH (x)<-[rb:${via}]-(b:${anchor})${where(['b <> a', ...inWindow('rb')])} WITH DISTINCT b, x LIMIT $countCap + 1 WITH collect({b: b, x: x}) AS pairs RETURN size(pairs) > $countCap AS pairsBounded, pairs[..$countCap] AS kept }`,
    [
      'CALL { WITH a, kept UNWIND kept AS q WITH a, q.b AS b, collect(q.x) AS xs WHERE size(xs) >= $minShared WITH a, b, xs ORDER BY elementId(b) LIMIT $limit + 1',
      `CALL { WITH a, b, xs UNWIND xs[..${EVIDENCE_NODES_PER_MATCH}] AS x`,
      `CALL { WITH a, x MATCH (a)-[ra:${via}]->(x)${where(inWindow('ra'))} RETURN ra LIMIT 1 }`,
      `CALL { WITH b, x MATCH (b)-[rb:${via}]->(x)${where(inWindow('rb'))} RETURN rb LIMIT 1 }`,
      `RETURN collect(x) AS shown, collect(ra) AS ras, collect(rb) AS rbs }`,
      `RETURN collect({b: b, shown: shown, ras: ras, rbs: rbs, shared: size(xs), cut: size(xs) > ${EVIDENCE_NODES_PER_MATCH}}) AS ms }`,
    ].join(' '),
    'UNWIND CASE WHEN size(ms) = 0 THEN [null] ELSE ms END AS m',
    'RETURN a, skipped, anchorBounded OR pairsBounded AS bounded, m.b AS b, m.shown AS xs, m.ras AS ras, m.rbs AS rbs, m.shared AS shared, m.cut AS evidenceCut',
  ].join('\n');
}
