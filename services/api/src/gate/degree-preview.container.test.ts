import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { parseMapping } from '../mapping/load.js';
import { judgePlan } from '../source-test/degree-judge.js';
import { profileDegreeRead } from '../testing/degree-plan.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { degreePreviewCheapTemplate } from './templates/degree-preview.js';

const run = promisify(execFile);

// A plan check on a Neo4j image you name, for the series the dev server does not run. It starts one Community container with `docker run`, makes a small graph in it and removes
// the container again. It is skipped unless NBX_PLAN_IMAGE names an image (for example neo4j:2026), and no CI job runs it.
const IMAGE = process.env['NBX_PLAN_IMAGE'];
const LARGE = 30_000;
const SMALL = 10;
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

describe.skipIf(IMAGE === undefined)('the cheap degree read on a server of another series', () => {
  it('counts a node of 30,000 relationships from its degree and reads as few things as a node of 10', async () => {
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
          await session.run('CREATE (:PlanHub {hubId: $small}), (:PlanHub {hubId: $large})', { small: 'small', large: 'large' });
          await session.run('CREATE INDEX plan_hub FOR (n:PlanHub) ON (n.hubId)');
          await session.run('MATCH (h:PlanHub {hubId: "small"}) UNWIND range(1, $n) AS i CREATE (h)-[:PLAN_LINKED]->(:PlanLeaf {leafId: "s" + i})', { n: neo4j.int(SMALL) });
          await session.run('MATCH (h:PlanHub {hubId: "large"}) UNWIND range(1, $n) AS i CREATE (h)-[:PLAN_LINKED]->(:PlanLeaf {leafId: "l" + i})', { n: neo4j.int(LARGE) });
          await session.run('CALL db.awaitIndexes(120)');
          const mapping = parseMapping(
            fileOf(baseSource({ id: 'plan', entities: [{ type: 'hub', label: 'PlanHub', stable_id: 'hubId' }, { type: 'leaf', label: 'PlanLeaf', stable_id: 'leafId' }], relationships: [{ type: 'PLAN_LINKED', from: 'hub', to: 'leaf' }] })),
            'neburyx.yaml',
          );
          const [source] = mapping.sources;
          if (source === undefined) throw new Error('the mapping has no source');
          const version = (await session.run('CALL dbms.components() YIELD versions RETURN versions[0] AS version')).records[0]?.get('version');
          const small = await profileDegreeRead(session, degreePreviewCheapTemplate, source, 'hub', 'small', 500);
          const large = await profileDegreeRead(session, degreePreviewCheapTemplate, source, 'hub', 'large', 500);
          process.stderr.write(`cheap degree plan on ${String(version)}: small ${small.dbHits} db hits, large ${large.dbHits} db hits\n`);
          expect(judgePlan(small.operators)).toEqual({ result: 'cheap', basis: 'degree-operator' });
          expect(judgePlan(large.operators)).toEqual({ result: 'cheap', basis: 'degree-operator' });
          expect(large.rows[0]?.['c0']).toEqual(neo4j.int(LARGE));
          expect(large.dbHits).toBe(small.dbHits);
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
