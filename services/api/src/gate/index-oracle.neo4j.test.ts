import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInt, type ProfiledPlan } from 'neo4j-driver';
import { defaultCatalog } from './assemble.js';
import { renderTemplate } from './render.js';
import { prepareParameters } from '../sources/parameters.js';
import { announceServerVersion, NEO4J_SERIES, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { LOOKUP_ALLOWLIST, LOOKUP_INVENTORY, LOOKUP_SEARCHES, LOOKUP_SHAPES } from '../testing/stable-id-lookups.js';

/**
 * Every statement of the catalog, on data built to make the planner pick an index scan on a plain property read, returns what the server's meaning says and expands from its anchor, in four states of the same
 * database: with its indexes just built and no statistics of them, after the statistics were taken, and (the oracle) with every index dropped but the node stable ID indexes that the anchors' hints name, where no
 * plan can start from another index. The rows of the first two states must equal the oracle's. A difference is a fault of the planner on this server series to take to the people who own the product's reads; it is not a
 * test to loosen. The oracle runs the rendered statements on an administrator session of the test database, not through the gate: once the indexes are gone the gate's guard refuses the reads whose indexes are
 * missing. This is the only test file that takes statistics, and it does so for its own database only.
 */
let server: RunningNeo4j;

const allowlist = LOOKUP_ALLOWLIST;
const catalog = defaultCatalog();

/** The inventory of the lookups, and the shapes that add conditions, windows, filters, ranks and searches. */
const CASES: readonly (readonly [string, string, Record<string, unknown>])[] = [...Object.entries(LOOKUP_INVENTORY).map(([id, params]) => [id, id, params] as const), ...LOOKUP_SHAPES, ...LOOKUP_SEARCHES];

beforeAll(async () => {
  server = await startNeo4j();
  await announceServerVersion(server);
  // the node stable ID indexes (the anchors' hints name them), the indexes of the filtered and ranked neighbor properties, the relationship stable ID indexes, the filtered relationship property and the observed time
  for (const [name, label, property] of [['x_maker', 'Maker', 'makerId'], ['x_tool', 'Tool', 'toolId'], ['x_shop', 'Shop', 'shopId'], ['x_region', 'Maker', 'region'], ['x_rank', 'Maker', 'rank'], ['x_kind', 'Tool', 'kind']] as const) {
    await runAdmin(server, `CREATE INDEX ${name} FOR (n:${label}) ON (n.${property})`);
  }
  for (const [name, type, property] of [['x_links', 'LINKS', 'linkId'], ['x_allies', 'ALLIES', 'allyId'], ['x_trusts', 'TRUSTS', 'trustId'], ['x_uses', 'USES_TOOL', 'useId'], ['x_endorses', 'ENDORSES', 'endorseId'], ['x_lane', 'LINKS', 'lane'], ['x_seen', 'LINKS', 'seenAt'], ['x_seen_use', 'USES_TOOL', 'seenAt']] as const) {
    await runAdmin(server, `CREATE INDEX ${name} FOR ()-[r:${type}]-() ON (r.${property})`);
  }
  await runAdmin(server, "UNWIND range(1, 40) AS i CREATE (:Maker {makerId: 'A-' + toString(i), region: CASE WHEN i % 3 = 0 THEN 'south' ELSE 'north' END, rank: i}), (:Tool {toolId: 'D-' + toString(i), kind: 'plain'}), (:Shop {shopId: 'S-' + toString(i)})");
  await runAdmin(server, "UNWIND range(1, 39) AS i MATCH (a:Maker {makerId: 'A-' + toString(i)}), (b:Maker {makerId: 'A-' + toString(i + 1)}), (d:Tool {toolId: 'D-' + toString(i)}), (s:Shop {shopId: 'S-' + toString(i)}) CREATE (a)-[:LINKS {linkId: 'L-' + toString(i), seenAt: datetime('2026-01-15T00:00:00Z'), lane: 'x'}]->(b), (a)-[:USES_TOOL {useId: 'U-' + toString(i), seenAt: datetime('2026-01-15T00:00:00Z')}]->(d), (b)-[:USES_TOOL {useId: 'V-' + toString(i)}]->(d), (d)-[:STOCKED_AT]->(s), (s)-[:ENDORSES {endorseId: 'E-' + toString(i)}]->(a)");
  // the cases of the defect: relationships with no value for an indexed property, an empty text, an integer, a text where a time belongs, parallel relationships and a loop; nodes with no value for an indexed property
  await runAdmin(server, "MATCH (a:Maker {makerId: 'A-1'}), (b:Maker {makerId: 'A-2'}), (c:Maker {makerId: 'A-3'}), (d:Tool {toolId: 'D-1'}) CREATE (a)-[:LINKS {seenAt: datetime('2026-02-01T00:00:00Z')}]->(b), (a)-[:LINKS {linkId: '', seenAt: datetime('2026-02-02T00:00:00Z')}]->(c), (a)-[:LINKS {linkId: 'LL-1'}]->(b), (a)-[:LINKS {linkId: 7, seenAt: 'later', lane: 'y'}]->(c), (a)-[:USES_TOOL {seenAt: datetime('2026-03-01T00:00:00Z')}]->(d), (a)-[:USES_TOOL]->(d), (a)<-[:LINKS {linkId: 'LI-1', seenAt: datetime('2026-02-03T00:00:00Z')}]-(c), (a)-[:LINKS {linkId: 'LOOP-1', seenAt: datetime('2026-02-04T00:00:00Z')}]->(a)");
  await runAdmin(server, "MATCH (b:Maker {makerId: 'A-2'}), (c:Maker {makerId: 'A-3'}) SET b.region = null, c.rank = null");
  await runAdmin(server, "MATCH (a:Maker {makerId: 'A-1'}) CREATE (a)-[:LINKS {linkId: 'NR-1', seenAt: datetime('2026-02-05T00:00:00Z')}]->(:Maker {makerId: 'A-90'}), (a)-[:LINKS]->(:Maker {makerId: 'A-91', region: 'north', rank: 5})");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
}, 600_000);

afterAll(async () => {
  await runAll([() => server?.stop()]);
});

const opsOf = (plan: ProfiledPlan): string[] => [plan.operatorType.replace(/@.*/, ''), ...plan.children.flatMap(opsOf)];
const textOf = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) => (isInt(field) ? field.toString() : field !== null && typeof field === 'object' && 'elementId' in field ? (field as { elementId: string }).elementId : field));

interface Outcome {
  /** Whether the statement orders its rows last, so that the order is part of the answer. */
  readonly ordered: boolean;
  readonly rows: readonly string[];
  readonly operators: readonly string[];
}

async function run(phase: 'profile' | 'plain'): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  for (const [name, id, params] of CASES) {
    const template = catalog.find(id);
    if (template === undefined) throw new Error(`no template ${id}`);
    const rendered = renderTemplate(template, template.paramsSchema.parse(params) as Record<string, unknown>, allowlist, 25, 100);
    const parameters = prepareParameters({ ...(rendered.cypher.includes('$cursor') ? { cursor: null } : {}), ...rendered.parameters }, template.integerParameters);
    const session = server.admin.session({ database: server.database });
    try {
      const result = await session.run(`${phase === 'profile' ? 'PROFILE ' : ''}${rendered.cypher}`, parameters);
      const rows = result.records.map((record) => textOf(record.toObject()));
      outcomes.set(name, { ordered: /\bORDER BY\b/.test(rendered.cypher.slice(rendered.cypher.lastIndexOf('RETURN '))), rows, operators: phase === 'profile' && result.summary.profile !== false ? opsOf(result.summary.profile as ProfiledPlan) : [] });
    } finally {
      await session.close();
    }
  }
  return outcomes;
}

/** The indexes the data was built with, and the count of the elements that hold a value for each: what the server's statistics must show once they were taken. */
const INDEXES: readonly (readonly [string, string, string])[] = [
  ['x_maker', 'Maker', 'makerId'], ['x_tool', 'Tool', 'toolId'], ['x_shop', 'Shop', 'shopId'], ['x_region', 'Maker', 'region'], ['x_rank', 'Maker', 'rank'], ['x_kind', 'Tool', 'kind'],
  ['x_links', 'LINKS', 'linkId'], ['x_allies', 'ALLIES', 'allyId'], ['x_trusts', 'TRUSTS', 'trustId'], ['x_uses', 'USES_TOOL', 'useId'], ['x_endorses', 'ENDORSES', 'endorseId'], ['x_lane', 'LINKS', 'lane'], ['x_seen', 'LINKS', 'seenAt'], ['x_seen_use', 'USES_TOOL', 'seenAt'],
];
const NODE_LABELS = new Set(['Maker', 'Tool', 'Shop']);

async function scalar(cypher: string): Promise<number> {
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(cypher);
    return Number(String(result.records[0]?.get('c')));
  } finally {
    await session.close();
  }
}

/**
 * Waits for the server to have taken the statistics of every index the test built: each of the named indexes is in the server's graph counts with no updates since its last estimation and a total size that equals
 * the number of elements holding a value for its property, which the test counts itself. An index missing from the answer, or an answer with no index, is not "taken": the wait ends in an error.
 */
async function statisticsTaken(): Promise<void> {
  const expected = new Map<string, number>();
  for (const [name, target, property] of INDEXES) {
    expected.set(name, await scalar(NODE_LABELS.has(target) ? `MATCH (n:${target}) WHERE n.${property} IS NOT NULL RETURN count(n) AS c` : `MATCH ()-[r:${target}]->() WHERE r.${property} IS NOT NULL RETURN count(r) AS c`));
  }
  const deadline = Date.now() + 120_000;
  for (;;) {
    const session = server.admin.session({ database: server.database });
    let waiting = 'no answer';
    try {
      const result = await session.run("CALL db.stats.retrieve('GRAPH COUNTS') YIELD data RETURN data.indexes AS indexes");
      const indexes = (result.records[0]?.get('indexes') ?? []) as { labels?: string[]; relationshipTypes?: string[]; properties: string[]; updatesSinceEstimation: unknown; totalSize: unknown }[];
      const pending = INDEXES.filter(([name, target, property]) => {
        const entry = indexes.find((index) => (index.labels?.[0] ?? index.relationshipTypes?.[0]) === target && index.properties[0] === property);
        return entry === undefined || Number(String(entry.updatesSinceEstimation)) !== 0 || Number(String(entry.totalSize)) !== expected.get(name);
      });
      if (pending.length === 0) return;
      waiting = pending.map(([name]) => name).join(', ');
    } finally {
      await session.close();
    }
    if (Date.now() > deadline) throw new Error(`the statistics were not taken for: ${waiting}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const states: Record<string, Map<string, Outcome>> = {};
/** Each statement whose plan holds a scan, with the operators, so that a failure names all of them. */
const scansOf = (outcomes: Map<string, Outcome> | undefined): string[] => [...(outcomes ?? [])].flatMap(([name, outcome]) => (outcome.operators.some((operator) => /Scan/.test(operator)) ? [`${name}: ${[...new Set(outcome.operators.filter((operator) => /Scan/.test(operator)))].join(', ')}`] : []));

describe(`every template returns the rows of the oracle and expands from its anchor, with and without statistics, on ${NEO4J_SERIES}`, () => {
  it('has a case for each template of the lookup inventory, and for the shapes that add conditions, windows, filters and ranks', () => {
    // the related-records and facet statements are not in the oracle: they need reference properties and facet targets that the fixture mapping does not declare (a residual risk the docs name)
    expect(new Set(CASES.map(([, id]) => id))).toEqual(new Set([...Object.keys(LOOKUP_INVENTORY), ...LOOKUP_SEARCHES.map(([, id]) => id)]));
    expect(CASES.length).toBeGreaterThan(Object.keys(LOOKUP_INVENTORY).length + 15);
  });

  it('plans every statement with no scan on a database whose indexes were just built', async () => {
    states['fresh'] = await run('profile');
    expect(scansOf(states['fresh'])).toEqual([]);
  });

  it('plans every statement with no scan after the statistics were taken, the plan cache cleared first', async () => {
    for (const name of ['x_maker', 'x_tool', 'x_shop', 'x_region', 'x_rank', 'x_kind', 'x_links', 'x_allies', 'x_trusts', 'x_uses', 'x_endorses', 'x_lane', 'x_seen', 'x_seen_use']) await runAdmin(server, `CALL db.resampleIndex('${name}')`);
    await statisticsTaken();
    await runAdmin(server, 'CALL db.clearQueryCaches()');
    states['sampled'] = await run('profile');
    expect(scansOf(states['sampled'])).toEqual([]);
  });

  it('answers each statement as the oracle does, in both states: no index but the anchors’ stable ID indexes, so that no plan can start from another', async () => {
    for (const name of ['x_region', 'x_rank', 'x_kind', 'x_links', 'x_allies', 'x_trusts', 'x_uses', 'x_endorses', 'x_lane', 'x_seen', 'x_seen_use']) await runAdmin(server, `DROP INDEX ${name}`);
    await runAdmin(server, 'CALL db.clearQueryCaches()');
    const oracle = await run('plain');
    // as sets, and in order where the statement orders its rows
    const shaped = (outcome: Outcome | undefined) => (outcome?.ordered === true ? outcome.rows : [...(outcome?.rows ?? [])].sort());
    const differences = CASES.flatMap(([name]) => {
      const expected = shaped(oracle.get(name));
      return (['fresh', 'sampled'] as const).flatMap((state) => {
        const got = shaped(states[state]?.get(name));
        return JSON.stringify(got) === JSON.stringify(expected) ? [] : [`${name}, ${state}: ${got.length} rows, the oracle ${expected.length}`];
      });
    });
    expect(differences).toEqual([]);
  });
});
