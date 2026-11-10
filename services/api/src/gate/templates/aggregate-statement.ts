import { AppError } from '../../errors.js';
import { quoteName } from '../render.js';
import type { SourceAllowlist } from '../types.js';
import { kindRank, supported, usable } from './expand-statement.js';

export type AggregateForm = 'sample' | 'summary';

/*
 * Measured through the gate on the dev Neo4j 5.26 server with 100,000 members between two nodes (read timeout 5,000 ms): the count with the earliest and latest time 102 to 148 ms, the sample ordered by
 * observed time 159 to 173 ms, the sample with no order 65 to 67 ms, and the sample and the count together through the reader 457 to 641 ms. Neither read is capped: the read timeout bounds them as it does every template.
 */

/** The properties of an aggregate's members that the sample shows: the mapped `filterable` ones other than the stable ID, the observed time (its own field) and the evidence properties (source record IDs, which an aggregate does not list). */
export function sampleProperties(names: readonly string[], row: { readonly stableId?: string | undefined; readonly observedAt?: string | undefined }, evidence: readonly string[]): readonly string[] {
  return names.filter((name) => name !== row.stableId && name !== row.observedAt && !evidence.includes(name));
}

const sampleKey = (index: number): string => `p${index}`;

/** The result key of the observed time in a sampled member, and the prefix of the keys of its properties; the normalizer reads these. */
export const SAMPLE_TIME_KEY = 't';
export const samplePropertyKey = sampleKey;

/**
 * The statement of an aggregate read: both ends are found by their stable IDs (the first node by element ID, as the entity read finds it), then the relationships of the mapping row between them. For a type with a `stable_id` the members are
 * those whose ID cannot be used, as the expansion's aggregate branch reads them. The `sample` form returns one row, both ends and at most `$limit` members as a map of their observed time and the named properties, ordered by the observed
 * time (newest first, values of different kinds never compared, a member with no usable time last, ties by element ID) when the row maps one and in no order the product chose otherwise (the first members the source returns), and never a relationship; the `summary` form returns one row, the count and the
 * earliest and latest observed time of every member. The end references are the parameter `$ends`, a list of two (the row's `from`, then its `to`).
 */
export function aggregateStatementOf(allowlist: SourceAllowlist, type: unknown, from: unknown, to: unknown, form: AggregateForm): string {
  const row = allowlist.relationshipRows.find((candidate) => candidate.type === type && candidate.from === from && candidate.to === to);
  const [fromLabel, toLabel] = [typeof from === 'string' ? allowlist.entityLabels.get(from) : undefined, typeof to === 'string' ? allowlist.entityLabels.get(to) : undefined];
  const [fromId, toId] = [typeof from === 'string' ? allowlist.stableIds.get(from) : undefined, typeof to === 'string' ? allowlist.stableIds.get(to) : undefined];
  if (row === undefined || fromLabel === undefined || toLabel === undefined || fromId === undefined || toId === undefined) throw new AppError('INVALID_REQUEST');
  const members = row.stableId === undefined ? '' : ` WHERE NOT ${usable(`r.${quoteName(row.stableId)}`)}`;
  const pattern = `(a)-[r:${quoteName(row.type)}]->(b)`;
  const anchors = [
    `MATCH (a:${quoteName(fromLabel)}) WHERE a.${quoteName(fromId)} IN [$ends[0].stableId, $ends[0].stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`,
    `MATCH (b:${quoteName(toLabel)}) WHERE b.${quoteName(toId)} IN [$ends[1].stableId, $ends[1].stableInteger] WITH a, b ORDER BY elementId(b) LIMIT 1`,
  ];
  const observed = row.observedAt === undefined ? undefined : `r.${quoteName(row.observedAt)}`;
  if (form === 'summary') {
    const times = observed === undefined ? 'null AS first, null AS last' : `min(CASE WHEN ${supported(observed)} THEN ${observed} END) AS first, max(CASE WHEN ${supported(observed)} THEN ${observed} END) AS last`;
    return [...anchors, `CALL { WITH a, b MATCH ${pattern}${members} RETURN count(r) AS members, ${times} }`, 'RETURN members, first, last'].join('\n');
  }
  const evidence = allowlist.evidenceRows.find((candidate) => candidate.type === row.type && candidate.from === row.from && candidate.to === row.to)?.properties ?? [];
  const shown = sampleProperties(row.filterable ?? [], row, evidence);
  const memberMap = [...(observed === undefined ? [] : [`${SAMPLE_TIME_KEY}: ${observed}`]), ...shown.map((name, index) => `${sampleKey(index)}: r.${quoteName(name)}`)].join(', ');
  const order = observed === undefined ? undefined : `CASE WHEN ${supported(observed)} THEN 0 ELSE 1 END, ${kindRank(observed)}, CASE WHEN ${supported(observed)} THEN ${observed} END DESC, elementId(r)`;
  return [...anchors, `CALL { WITH a, b MATCH ${pattern}${members} WITH r${order === undefined ? '' : ` ORDER BY ${order}`} LIMIT $limit RETURN collect({${memberMap}}) AS sample }`, 'RETURN a, b, sample'].join('\n');
}
