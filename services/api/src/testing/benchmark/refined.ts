import type { ExpandFilter, ExpandRank } from '@neburyx/contracts';
import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import { performance } from 'node:perf_hooks';
import { allowlistFromMapping } from '../../gate/allowlist.js';
import { defaultCatalog } from '../../gate/assemble.js';
import { renderTemplate } from '../../gate/render.js';
import { EXPAND_COUNT_ID } from '../../gate/templates/expand-count.js';
import { EXPAND_NEIGHBORS_ID } from '../../gate/templates/expand-neighbors.js';
import type { Gate } from '../../gate/types.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../gate.js';
import { sourceFor, type RunningNeo4j } from '../neo4j-server.js';
import { ENTITIES, hubOf, RELATIONSHIPS } from './fixture.js';
import { PAGE, SAMPLES_PER_POSITION, WARM_UP_PAGES } from './plan.js';
import { summarize, type Summary } from './stats.js';

/** One cell of the section on filtered, ranked and counted reads: a read of the dated relationships of one anchor, its time over the timed requests and the server's db hits for it. */
export interface RefinedCell {
  readonly size: number;
  readonly name: string;
  readonly kind: 'page' | 'count';
  readonly time: Summary;
  readonly dbHits: number;
  /** For a count, the number it returned (it is exact); for a page, the rows of the first page. */
  readonly result: number;
}

export interface RefinedRecord {
  readonly date: string;
  readonly commit: string;
  readonly neo4j: { readonly version: string; readonly edition: string };
  readonly cells: readonly RefinedCell[];
}

const score = (value: number, op: 'eq' | 'gte'): ExpandFilter => (op === 'eq' ? { on: 'relationship', property: 'score', op: 'eq', value: { kind: 'number', value } } : { on: 'relationship', property: 'score', op: 'between', from: { kind: 'number', value } });

interface Case {
  readonly name: string;
  readonly kind: 'page' | 'count';
  readonly filters?: readonly ExpandFilter[];
  readonly rank?: ExpandRank;
}

/** The cases, with the unfiltered page of the same relationship type as the baseline to read them against. `score` is `i % 20`, so an equal to 3 keeps 1 in 20 and at least 0 keeps all. */
export const CASES: readonly Case[] = [
  { name: 'no filter, most recent (baseline)', kind: 'page' },
  { name: 'rank by a relationship property, highest first', kind: 'page', rank: { on: 'relationship', property: 'score', order: 'desc' } },
  { name: 'rank by a relationship property, lowest first', kind: 'page', rank: { on: 'relationship', property: 'score', order: 'asc' } },
  { name: 'rank by a neighbor property, highest first', kind: 'page', rank: { on: 'neighbor', property: 'size', order: 'desc' } },
  { name: 'selective filter (1 in 20)', kind: 'page', filters: [score(3, 'eq')] },
  { name: 'loose filter (all)', kind: 'page', filters: [score(0, 'gte')] },
  { name: 'selective filter, ranked by a relationship property', kind: 'page', filters: [score(3, 'eq')], rank: { on: 'relationship', property: 'score', order: 'desc' } },
  { name: 'count, selective filter', kind: 'count', filters: [score(3, 'eq')] },
  { name: 'count, loose filter', kind: 'count', filters: [score(0, 'gte')] },
];

const operators = (plan: ProfiledPlan | false): readonly ProfiledPlan[] => (plan === false ? [] : [plan, ...plan.children.flatMap(operators)]);

function paramsOf(size: number, entry: Case): Record<string, unknown> {
  const base = { entityType: 'hub', stableId: hubOf(size), neighborType: 'leaf', direction: 'both', relTypes: ['LINKED'] };
  return entry.kind === 'count' ? { ...base, filters: entry.filters } : { ...base, sort: 'observed', ...(entry.filters === undefined ? {} : { filters: entry.filters }), ...(entry.rank === undefined ? {} : { rank: entry.rank }) };
}

async function dbHitsOf(server: RunningNeo4j, size: number, entry: Case): Promise<number> {
  const template = defaultCatalog().find(entry.kind === 'count' ? EXPAND_COUNT_ID : EXPAND_NEIGHBORS_ID);
  if (template === undefined) throw new Error('the template is not in the catalog');
  const allowlist = allowlistFromMapping(sourceFor(server, { entities: ENTITIES, relationships: RELATIONSHIPS }));
  const rendered = renderTemplate(template, template.paramsSchema.parse(paramsOf(size, entry)) as Record<string, unknown>, allowlist, entry.kind === 'count' ? 1 : PAGE, 0);
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(entry.kind === 'count' ? 1 : PAGE), cursor: null });
    return operators(result.summary.profile).reduce((sum, operator) => sum + Number(operator.dbHits), 0);
  } finally {
    await session.close();
  }
}

/** Measures every case at one size: the warm-up reads, then the timed ones, then the db hits of one profiled run. A read that fails stops the measurement: these cells have no failure to count. */
export async function measureRefined(server: RunningNeo4j, gate: Gate, size: number): Promise<RefinedCell[]> {
  const cells: RefinedCell[] = [];
  for (const entry of CASES) {
    const run = () => gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: entry.kind === 'count' ? EXPAND_COUNT_ID : EXPAND_NEIGHBORS_ID, params: paramsOf(size, entry), limit: entry.kind === 'count' ? 1 : PAGE }));
    for (let warm = 0; warm < WARM_UP_PAGES; warm += 1) await run();
    const times: number[] = [];
    let result = 0;
    for (let sample = 0; sample < SAMPLES_PER_POSITION; sample += 1) {
      const started = performance.now();
      const answer = await run();
      times.push(performance.now() - started);
      const item = answer.items[0] as { total?: number; returned?: number } | undefined;
      result = entry.kind === 'count' ? (item?.total ?? -1) : (item?.returned ?? 0);
    }
    cells.push({ size, name: entry.name, kind: entry.kind, time: summarize(times), dbHits: await dbHitsOf(server, size, entry), result });
    process.stdout.write(`${size} ${entry.name}: p95 ${cells.at(-1)?.time.p95.toFixed(0)} ms\n`);
  }
  return cells;
}

const ms = (value: number): string => value.toFixed(0);

/** The section of the record on filtered, ranked and counted reads; the rest of the record is as the run that made it left it. */
export function refinedLines(refined: RefinedRecord): string[] {
  const lines = [
    '',
    '## Filtered, ranked and counted reads',
    '',
    `Run on the code of commit ${refined.commit} on ${refined.date}, on Neo4j ${refined.neo4j.version} (${refined.neo4j.edition}), by \`refined.benchmark.test.ts\`, apart from the run of the rest of this record, which is as it was. The anchors are the dated relationships (\`LINKED\`) of the sizes below; each carries \`score\` (\`i % 20\`) and its neighbor \`band\` and \`size\`. Each cell is the first page of ${PAGE} (a page at any depth reads the same relationships), ${SAMPLES_PER_POSITION} timed reads after ${WARM_UP_PAGES} untimed, through the gate; db hits are those of the server's plan for one profiled run. The count has no cap and is exact.`,
    '',
    'A page still matches every relationship of the type on the node before it sorts and cuts, whatever the filter or the rank; a condition reads its property on every relationship, so a filter that keeps nearly everything costs more than no filter and a selective one costs less, a rank by a neighbor property reads one more property for each candidate, and the count reads the relationships without sorting or returning rows. No index is used or needed.',
    '',
    '| Relationships | Read | Result | p50 (ms) | p95 (ms) | max (ms) | db hits |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const cell of refined.cells) lines.push(`| ${cell.size.toLocaleString('en-US')} | ${cell.name} | ${cell.kind === 'count' ? `${cell.result.toLocaleString('en-US')} (exact)` : `${cell.result} rows`} | ${ms(cell.time.p50)} | ${ms(cell.time.p95)} | ${ms(cell.time.max)} | ${cell.dbHits.toLocaleString('en-US')} |`);
  return lines;
}
