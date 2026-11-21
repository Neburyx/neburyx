import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProfiledPlan } from 'neo4j-driver';
import { prepareParameters } from '../sources/parameters.js';
import { announceServerVersion, NEO4J_SERIES, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { patternAllowlist } from '../testing/pattern-fixtures.js';
import { LOOKUP_INVENTORY } from '../testing/stable-id-lookups.js';
import { defaultCatalog } from './assemble.js';
import { renderTemplate } from './render.js';

/**
 * Every statement of the catalog that finds an element by its stable ID, profiled on a database that was just built: its indexes are online and the server has taken no statistics of them (nothing
 * here samples an index). The plan seeks each lookup in the stable ID index; no label, type or index is scanned. The planner's choice does not depend on the statistics because the statement names the index.
 */
let server: RunningNeo4j;
const allowlist = patternAllowlist();
const catalog = defaultCatalog();

beforeAll(async () => {
  server = await startNeo4j();
  await announceServerVersion(server);
  for (const [label, property] of [['Maker', 'makerId'], ['Tool', 'toolId'], ['Shop', 'shopId']] as const) await runAdmin(server, `CREATE INDEX x_${label.toLowerCase()} FOR (n:${label}) ON (n.${property})`);
  for (const [type, property] of [['LINKS', 'linkId'], ['ALLIES', 'allyId'], ['TRUSTS', 'trustId'], ['USES_TOOL', 'useId'], ['ENDORSES', 'endorseId']] as const) {
    await runAdmin(server, `CREATE INDEX x_${type.toLowerCase()} FOR ()-[r:${type}]-() ON (r.${property})`);
  }
  await runAdmin(server, "UNWIND range(1, 40) AS i CREATE (:Maker {makerId: 'A-' + toString(i), region: 'north', rank: i}), (:Tool {toolId: 'D-' + toString(i), kind: 'plain'}), (:Shop {shopId: 'S-' + toString(i)})");
  await runAdmin(server, "UNWIND range(1, 39) AS i MATCH (a:Maker {makerId: 'A-' + toString(i)}), (b:Maker {makerId: 'A-' + toString(i + 1)}), (d:Tool {toolId: 'D-' + toString(i)}), (s:Shop {shopId: 'S-' + toString(i)}) CREATE (a)-[:LINKS {linkId: 'L-' + toString(i), seenAt: datetime('2026-01-15T00:00:00Z'), lane: 'x'}]->(b), (a)-[:USES_TOOL {useId: 'U-' + toString(i), seenAt: datetime('2026-01-15T00:00:00Z')}]->(d), (b)-[:USES_TOOL {useId: 'V-' + toString(i)}]->(d), (d)-[:STOCKED_AT]->(s), (s)-[:ENDORSES {endorseId: 'E-' + toString(i)}]->(a)");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
}, 600_000);

afterAll(async () => {
  await runAll([() => server?.stop()]);
});

function operatorsOf(plan: ProfiledPlan): string[] {
  return [plan.operatorType, ...plan.children.flatMap(operatorsOf)];
}

async function profile(id: string, params: Record<string, unknown>): Promise<ProfiledPlan> {
  const template = catalog.find(id);
  if (template === undefined) throw new Error(`no template ${id}`);
  const rendered = renderTemplate(template, template.paramsSchema.parse(params) as Record<string, unknown>, allowlist, 25, 100);
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters({ ...(rendered.cypher.includes('$cursor') ? { cursor: null } : {}), ...rendered.parameters }, template.integerParameters));
    if (result.summary.profile === false) throw new Error('the server did not profile the statement');
    return result.summary.profile;
  } finally {
    await session.close();
  }
}

describe(`the plan of every lookup by stable ID on a database with no index statistics, on ${NEO4J_SERIES}`, () => {
  it.each(Object.entries(LOOKUP_INVENTORY))('%s seeks each lookup in the stable ID index and scans nothing', async (id, params) => {
    const operators = operatorsOf(await profile(id, params));
    expect(operators.filter((name) => /IndexSeek/.test(name)).length).toBeGreaterThan(0);
    expect(operators.filter((name) => /Scan/.test(name))).toEqual([]);
  });
});
