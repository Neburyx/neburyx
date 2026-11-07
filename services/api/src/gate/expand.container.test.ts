import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { parseMapping } from '../mapping/load.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { allowlistFromMapping } from './allowlist.js';
import { defaultCatalog } from './assemble.js';
import { renderTemplate } from './render.js';
import { EXPAND_NEIGHBORS_ID } from './templates/expand-neighbors.js';

const run = promisify(execFile);

// A plan check on a Neo4j image you name, for the series the dev server does not run. It starts one Community container with `docker run`, makes a small graph in it and removes
// the container again. It is skipped unless NBX_PLAN_IMAGE names an image (for example neo4j:2026), and no CI job runs it.
const IMAGE = process.env['NBX_PLAN_IMAGE'];
const RELATIONSHIPS = 5_000;
const PAGE = 25;
const START_LIMIT_MS = 240_000;

async function waitUntilReady(driver: ReturnType<typeof neo4j.driver>): Promise<void> {
  const until = Date.now() + START_LIMIT_MS;
  for (;;) {
    try {
      await driver.verifyConnectivity();
      return;
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

describe.skipIf(IMAGE === undefined)('the expansion read on a server of another series', () => {
  it('anchors on the stable ID index and returns at most a page and one row for each branch, from the first page and from a cursor', async () => {
    const password = randomBytes(12).toString('hex');
    const { stdout } = await run('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::7687', '-e', `NEO4J_AUTH=neo4j/${password}`, IMAGE ?? '']);
    const container = stdout.trim();
    try {
      const { stdout: mapped } = await run('docker', ['port', container, '7687/tcp']);
      const port = /:(\d+)\s*$/m.exec(mapped.trim())?.[1];
      const driver = neo4j.driver(`bolt://127.0.0.1:${port ?? ''}`, neo4j.auth.basic('neo4j', password));
      try {
        await waitUntilReady(driver);
        const session = driver.session();
        try {
          await session.run('CREATE (:PlanHub {hubId: $id})', { id: 'big' });
          await session.run('CREATE INDEX plan_hub FOR (n:PlanHub) ON (n.hubId)');
          await session.run("MATCH (h:PlanHub {hubId: 'big'}) UNWIND range(1, $n) AS i CREATE (h)-[:PLAN_LINKED {relId: 'b' + toString(i), seenAt: datetime('2026-01-01T00:00:00Z') + duration({seconds: i})}]->(:PlanLeaf {leafId: 'b' + toString(i)})", { n: neo4j.int(RELATIONSHIPS) });
          await session.run("MATCH (h:PlanHub {hubId: 'big'}) UNWIND range(1, 500) AS i MATCH (l:PlanLeaf {leafId: 'b' + toString(i)}) CREATE (h)-[:PLAN_NOTED]->(l)");
          await session.run('CALL db.awaitIndexes(120)');
          const mapping = parseMapping(
            fileOf(
              baseSource({
                id: 'plan',
                entities: [{ type: 'hub', label: 'PlanHub', stable_id: 'hubId' }, { type: 'leaf', label: 'PlanLeaf', stable_id: 'leafId' }],
                relationships: [{ type: 'PLAN_LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt' }, { type: 'PLAN_NOTED', from: 'hub', to: 'leaf' }],
              }),
            ),
            'neburyx.yaml',
          );
          const [source] = mapping.sources;
          if (source === undefined) throw new Error('the mapping has no source');
          const template = defaultCatalog().find(EXPAND_NEIGHBORS_ID);
          if (template === undefined) throw new Error('no template');
          const version = (await session.run('CALL dbms.components() YIELD versions RETURN versions[0] AS version')).records[0]?.get('version');
          for (const cursor of [null, { phase: 0, ts: '2026-01-01T01:00:00Z', tk: 1, id: 'b3000', rtype: 'PLAN_LINKED', dir: 'out', nType: null }, { phase: 1, ts: null, tk: null, id: 'b100', rtype: 'PLAN_NOTED', dir: 'out', nType: 'leaf' }]) {
            const rendered = renderTemplate(template, { entityType: 'hub', stableId: 'big', stableInteger: null, neighborType: 'leaf', direction: 'both', sort: 'observed' }, allowlistFromMapping(source), PAGE, 500);
            const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(PAGE), cursor });
            const operators = (plan: ProfiledPlan | false): ProfiledPlan[] => (plan === false ? [] : [plan, ...plan.children.flatMap(operators)]);
            const all = operators(result.summary.profile);
            const rows = all[0]?.arguments['Rows'];
            process.stderr.write(`expansion plan on ${String(version)}: ${result.records.length} rows, root rows ${String(neo4j.isInt(rows) ? rows.toNumber() : rows)}\n`);
            expect(all.some((operator) => /IndexSeek/.test(operator.operatorType))).toBe(true);
            expect(result.records.length).toBeLessThanOrEqual(PAGE + 1);
            expect(neo4j.isInt(rows) ? rows.toNumber() : Number(rows ?? 0)).toBeLessThanOrEqual(PAGE + 1);
          }
        } finally {
          await session.close();
        }
      } finally {
        await driver.close();
      }
    } finally {
      await run('docker', ['rm', '-f', container]).catch(() => undefined);
    }
  }, 600_000);
});
