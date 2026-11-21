import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInt, type ProfiledPlan } from 'neo4j-driver';
import { allowlistFromMapping } from './allowlist.js';
import { defaultCatalog } from './assemble.js';
import { renderTemplate } from './render.js';
import { prepareParameters } from '../sources/parameters.js';
import { DERIVED_RULE } from '../testing/derived-fixtures.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { announceServerVersion, NEO4J_SERIES, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, patternParams, step } from '../testing/pattern-fixtures.js';
import { LOOKUP_INVENTORY } from '../testing/stable-id-lookups.js';

/**
 * Every statement of the catalog, on data built to make the planner pick an index scan on a plain property read, returns what the server's meaning says and expands from its anchor, in four states of the same
 * database: with its indexes just built and no statistics of them, after the statistics were taken, and (the oracle) with every index dropped but the node stable ID indexes that the anchors' hints name, where no
 * plan can start from another index. The rows of the first two states must equal the oracle's. A difference is a fault of the planner on this server series to take to the people who own the product's reads; it is not a
 * test to loosen. The oracle runs the rendered statements on an administrator session of the test database, not through the gate: once the indexes are gone the gate's guard refuses the reads whose indexes are
 * missing. This is the only test file that takes statistics, and it does so for its own database only.
 */
let server: RunningNeo4j;

const mapping = linkedMappingOf({
  entities: PATTERN_ENTITIES.map((entity) => (entity.type === 'maker' ? { ...entity, sortable: ['rank'] } : entity)),
  relationships: PATTERN_RELATIONSHIPS.map((row) => (row.type === 'USES_TOOL' ? { ...row, observed_at: 'seenAt' } : row)),
  derived: [DERIVED_RULE],
  patterns: [],
});
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const allowlist = allowlistFromMapping(source);
const catalog = defaultCatalog();

const WINDOW = { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-12-31T00:00:00Z' };
const regionIs = { on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'north' } };
const rankBetween = { on: 'neighbor', property: 'rank', op: 'between', from: { kind: 'number', value: 2 }, to: { kind: 'number', value: 9 } };
const laneIs = { on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'x' } };
const maker = (stableId: string) => ({ sourceId: 'demo', entityType: 'maker', stableId });
const EXPAND = { entityType: 'maker', stableId: 'A-1', neighborType: 'maker', direction: 'both', sort: 'observed' };
const COUNT = { entityType: 'maker', stableId: 'A-1', neighborType: 'maker', direction: 'both' };

/** The inventory of the lookups, and the shapes of expand, pattern, shared-attribute and linked-entities that add conditions, windows, filters and ranks. */
const CASES: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ...Object.entries(LOOKUP_INVENTORY).map(([id, params]) => [id, id, params] as const),
  ['expand out', 'expand-neighbors', { ...EXPAND, direction: 'out' }],
  ['expand in', 'expand-neighbors', { ...EXPAND, direction: 'in' }],
  ['expand to the other type', 'expand-neighbors', { ...EXPAND, neighborType: 'tool' }],
  ['expand windowed', 'expand-neighbors', { ...EXPAND, ...WINDOW }],
  ['expand filtered by a neighbor value', 'expand-neighbors', { ...EXPAND, filters: [regionIs] }],
  ['expand filtered by a neighbor range', 'expand-neighbors', { ...EXPAND, filters: [rankBetween] }],
  ['expand filtered by a relationship value', 'expand-neighbors', { ...EXPAND, relTypes: ['LINKS'], filters: [laneIs] }],
  ['expand ranked by the neighbor, descending', 'expand-neighbors', { ...EXPAND, rank: { on: 'neighbor', property: 'rank', order: 'desc' } }],
  ['expand ranked by the observed time, ascending', 'expand-neighbors', { ...EXPAND, relTypes: ['LINKS'], rank: { on: 'relationship', property: 'seenAt', order: 'asc' } }],
  ['expand count windowed', 'expand-count', { ...COUNT, ...WINDOW }],
  ['expand count filtered', 'expand-count', { ...COUNT, filters: [regionIs] }],
  ['aggregate sample of a type with an ID', 'aggregate-sample', { type: 'LINKS', ends: [maker('A-1'), maker('A-2')] }],
  ['aggregate summary of a type with an ID', 'aggregate-summary', { type: 'LINKS', ends: [maker('A-1'), maker('A-2')] }],
  ['aggregate summary of the pair with no ID on a member', 'aggregate-summary', { type: 'USES_TOOL', ends: [maker('A-1'), { sourceId: 'demo', entityType: 'tool', stableId: 'D-1' }] }],
  ['pattern with a neighbor condition', 'pattern', patternParams([step({ conditions: [regionIs] })])],
  ['pattern with a relationship condition', 'pattern', patternParams([step({ conditions: [laneIs] })])],
  ['pattern with a window', 'pattern', patternParams([step({ ...WINDOW })])],
  ['pattern count with a neighbor condition', 'pattern-count', patternParams([step({ conditions: [regionIs] })])],
  ['shared attribute with a window', 'shared-attribute', { ...LOOKUP_INVENTORY['shared-attribute'], ...WINDOW }],
  ['linked entities with a window', 'linked-entities', { ...LOOKUP_INVENTORY['linked-entities'], ...WINDOW }],
];

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
      outcomes.set(name, { rows, operators: phase === 'profile' && result.summary.profile !== false ? opsOf(result.summary.profile as ProfiledPlan) : [] });
    } finally {
      await session.close();
    }
  }
  return outcomes;
}

/** Waits for the server to have taken the statistics of every property index: no index is left with updates since its last estimation. */
async function statisticsTaken(): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const session = server.admin.session({ database: server.database });
    try {
      const result = await session.run("CALL db.stats.retrieve('GRAPH COUNTS') YIELD data RETURN data.indexes AS indexes");
      const indexes = (result.records[0]?.get('indexes') ?? []) as { indexType: string; updatesSinceEstimation: unknown }[];
      if (indexes.filter((index) => index.indexType !== 'LOOKUP').every((index) => Number(String(index.updatesSinceEstimation)) === 0)) return;
    } finally {
      await session.close();
    }
    if (Date.now() > deadline) throw new Error('the statistics were not taken');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const states: Record<string, Map<string, Outcome>> = {};
/** Each statement whose plan holds a scan, with the operators, so that a failure names all of them. */
const scansOf = (outcomes: Map<string, Outcome> | undefined): string[] => [...(outcomes ?? [])].flatMap(([name, outcome]) => (outcome.operators.some((operator) => /Scan/.test(operator)) ? [`${name}: ${[...new Set(outcome.operators.filter((operator) => /Scan/.test(operator)))].join(', ')}`] : []));

describe(`every template returns the rows of the oracle and expands from its anchor, with and without statistics, on ${NEO4J_SERIES}`, () => {
  it('has a case for each template of the lookup inventory, and for the shapes that add conditions, windows, filters and ranks', () => {
    expect(new Set(CASES.map(([, id]) => id))).toEqual(new Set(Object.keys(LOOKUP_INVENTORY)));
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
    const sorted = (rows: readonly string[]) => [...rows].sort();
    const differences = CASES.flatMap(([name]) => {
      const expected = sorted(oracle.get(name)?.rows ?? []);
      return (['fresh', 'sampled'] as const).flatMap((state) => {
        const got = sorted(states[state]?.get(name)?.rows ?? []);
        return JSON.stringify(got) === JSON.stringify(expected) ? [] : [`${name}, ${state}: ${got.length} rows, the oracle ${expected.length}`];
      });
    });
    expect(differences).toEqual([]);
  });
});
