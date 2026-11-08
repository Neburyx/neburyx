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
import { RELATED_CONTEXT_ID } from './templates/related-context.js';

const run = promisify(execFile);

// A plan check of the relationship context read on a Neo4j image you name, for the series the dev server does not run. It starts one Community container with `docker run`, makes a small graph in it and removes
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

describe.skipIf(IMAGE === undefined)('the relationship context read on a server of another series', () => {
  it('seeks each end by its index and checks the pair between two bound nodes, with no scan and no expansion from an unbound node', async () => {
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
          await session.run('CREATE INDEX plan_maker FOR (n:PlanMaker) ON (n.makerId)');
          await session.run('CREATE INDEX plan_piece FOR (n:PlanPiece) ON (n.pieceId)');
          await session.run("CREATE (:PlanMaker {makerId: 'bigC'}), (:PlanPiece {pieceId: 'bigA'}), (:PlanMaker {makerId: 'c1'}), (:PlanPiece {pieceId: 'a1'})");
          await session.run("MATCH (c:PlanMaker {makerId: 'bigC'}) UNWIND range(1, $n) AS i CREATE (c)-[:PLAN_OWNS]->(:PlanPiece {pieceId: 'o' + toString(i)})", { n: neo4j.int(RELATIONSHIPS) });
          await session.run("MATCH (a:PlanPiece {pieceId: 'bigA'}) UNWIND range(1, $n) AS i CREATE (:PlanMaker {makerId: 'p' + toString(i)})-[:PLAN_OWNS]->(a)", { n: neo4j.int(RELATIONSHIPS) });
          await session.run("MATCH (c:PlanMaker {makerId: 'c1'}), (a:PlanPiece {pieceId: 'a1'}) CREATE (c)-[:PLAN_OWNS]->(a)");
          await session.run('CALL db.awaitIndexes(120)');
          const mapping = parseMapping(
            fileOf(baseSource({ id: 'plan', entities: [{ type: 'maker', label: 'PlanMaker', stable_id: 'makerId' }, { type: 'piece', label: 'PlanPiece', stable_id: 'pieceId' }], relationships: [{ type: 'PLAN_OWNS', from: 'maker', to: 'piece' }] })),
            'neburyx.yaml',
          );
          const [source] = mapping.sources;
          if (source === undefined) throw new Error('the mapping has no source');
          const template = defaultCatalog().find(RELATED_CONTEXT_ID);
          if (template === undefined) throw new Error('no template');
          const version = (await session.run('CALL dbms.components() YIELD versions RETURN versions[0] AS version')).records[0]?.get('version');
          const ref = (entityType: string, stableId: string) => ({ sourceId: 'plan', entityType, stableId, stableInteger: null });
          const rendered = renderTemplate(template, { hits: [ref('maker', 'bigC'), ref('maker', 'c1')], exact: [ref('piece', 'bigA'), ref('piece', 'a1')] }, allowlistFromMapping(source), PAGE, 500);
          const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(PAGE) });
          const operators = (plan: ProfiledPlan | false): ProfiledPlan[] => (plan === false ? [] : [plan, ...plan.children.flatMap(operators)]);
          const names = operators(result.summary.profile).map((operator) => operator.operatorType);
          process.stderr.write(`relationship context plan on ${String(version)}: ${names.join(' > ')}\n`);
          expect(names.filter((name) => /IndexSeek/.test(name)).length).toBeGreaterThanOrEqual(2);
          for (const forbidden of [/AllNodesScan/, /NodeByLabelScan/, /RelationshipTypeScan/, /RelationshipIndexScan/]) expect(names.some((name) => forbidden.test(name))).toBe(false);
          expect(names.filter((name) => /Expand/.test(name)).every((name) => /Into/.test(name))).toBe(true);
          expect(result.records).toHaveLength(1);
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
