import neo4j from 'neo4j-driver';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleGate } from '../gate/assemble.js';
import { degreeProbeItemSchema, DEGREE_PROBE_ID } from '../gate/templates/degree-probe.js';
import type { SystemRunner } from '../gate/types.js';
import { communitySeams } from '../seams/community-seams.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { judgePlan } from './degree-judge.js';

// A check by hand against an Enterprise server you run yourself, for what a container cannot show: the plan and db hits of the degree probe on Enterprise, and whether
// a login that can only read may run PROFILE. It CREATES a small synthetic graph in the named database, a role and a login (all named nbx_test_ or Nbx), and drops
// them again. It is skipped unless the variables are set and NBX_EE_ALLOW_WRITES is `yes`, it refuses a database whose name does not start with `nbx`, and no CI job runs it.
const URI = process.env['NBX_EE_URI'];
const USER = process.env['NBX_EE_USER'];
const PASSWORD = process.env['NBX_EE_PASSWORD'];
const DATABASE = process.env['NBX_EE_DATABASE'] ?? 'nbxprivcheck';
const live = URI !== undefined && USER !== undefined && PASSWORD !== undefined && process.env['NBX_EE_ALLOW_WRITES'] === 'yes' && DATABASE.startsWith('nbx');

const ROLE = 'nbx_test_degree_ro';
const READER = 'nbx_test_degree_reader';
const SUPERNODE = 30_000;

const entities = [
  { type: 'hub', label: 'NbxHub', stable_id: 'id' },
  { type: 'small', label: 'NbxSmall', stable_id: 'id' },
  { type: 'leaf', label: 'NbxLeaf', stable_id: 'id' },
];
const relationships = [
  { type: 'NBX_LINKED', from: 'hub', to: 'leaf' },
  { type: 'NBX_LINKED', from: 'small', to: 'leaf' },
];

describe.skipIf(!live)('the degree probe against an Enterprise server', () => {
  it('shows the plan and the db hits for an admin login, and says whether a login that can only read may run PROFILE', async () => {
    const admin = neo4j.driver(URI ?? '', neo4j.auth.basic(USER ?? '', PASSWORD ?? ''));
    const system = async (query: string) => {
      const session = admin.session({ database: 'system' });
      try {
        await session.run(query);
      } finally {
        await session.close();
      }
    };
    const data = async (query: string) => {
      const session = admin.session({ database: DATABASE });
      try {
        await session.run(query);
      } finally {
        await session.close();
      }
    };
    const readerPassword = randomBytes(18).toString('hex');
    const runners: { runner: SystemRunner; close: () => Promise<void> }[] = [];
    const runnerFor = (user: string, password: string): SystemRunner => {
      const mapping = mappingOf(sourceWith('live', { uri: URI, database: DATABASE, budgets: { timeout_ms: 10000, queue_wait_ms: 5000 }, entities, relationships, auth: { kind: 'basic', username_env: 'NBX_EE_U', password_env: 'NBX_EE_P' } }));
      const logger = { warn: () => undefined };
      const executor = createNeo4jExecutor({ sources: mapping.sources, env: { NBX_EE_U: user, NBX_EE_P: password }, logger });
      const defaults = communitySeams();
      const { system: runner } = assembleGate({ mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger });
      runners.push({ runner, close: () => executor.close() });
      return runner;
    };
    const probe = async (runner: SystemRunner, entityType: string) => {
      const started = Date.now();
      try {
        const page = await runner.run({ traceId: 'tr-live', sourceId: 'live', templateId: DEGREE_PROBE_ID, params: { entityType, relationshipType: 'NBX_LINKED' }, limit: 1 });
        const operators = degreeProbeItemSchema.parse(page.items[0]).operators;
        return { operators, verdict: judgePlan(operators), elapsedMs: Date.now() - started };
      } catch (error) {
        return { error: (error as { code?: string; reason?: string }).code + '/' + (error as { reason?: string }).reason, elapsedMs: Date.now() - started };
      }
    };
    try {
      await data(`CREATE (:NbxHub {id: 'h'}) WITH 1 AS one UNWIND range(1, ${SUPERNODE}) AS i MATCH (h:NbxHub) CREATE (h)-[:NBX_LINKED]->(:NbxLeaf {id: 'leaf' + i})`);
      await data(`CREATE (s:NbxSmall {id: 's'}) WITH s UNWIND range(1, 10) AS i MATCH (l:NbxLeaf {id: 'leaf' + i}) CREATE (s)-[:NBX_LINKED]->(l)`);
      await system(`CREATE ROLE ${ROLE} IF NOT EXISTS`);
      await system(`GRANT ACCESS ON DATABASE ${DATABASE} TO ${ROLE}`);
      await system(`GRANT MATCH {*} ON GRAPH ${DATABASE} TO ${ROLE}`);
      await system(`CREATE USER ${READER} IF NOT EXISTS SET PASSWORD '${readerPassword}' CHANGE NOT REQUIRED`);
      await system(`GRANT ROLE ${ROLE} TO ${READER}`);

      const asAdmin = runnerFor(USER ?? '', PASSWORD ?? '');
      const asReader = runnerFor(READER, readerPassword);
      const found = {
        adminHub: await probe(asAdmin, 'hub'),
        adminSmall: await probe(asAdmin, 'small'),
        readerHub: await probe(asReader, 'hub'),
      };
      process.stderr.write(`degree probe on Enterprise: ${JSON.stringify(found)}\n`);

      for (const key of ['adminHub', 'adminSmall'] as const) {
        const result = found[key];
        expect('error' in result ? result.error : result.verdict).toEqual({ result: 'cheap', basis: 'degree-operator' });
        expect(result.elapsedMs).toBeLessThan(10_000);
      }
      const hits = (key: 'adminHub' | 'adminSmall') => ('operators' in found[key] ? (found[key].operators ?? []).reduce((sum, operator) => sum + operator.dbHits, 0) : -1);
      expect(hits('adminHub')).toBe(hits('adminSmall'));
    } finally {
      await Promise.allSettled(runners.map((entry) => entry.close()));
      await data('MATCH (n) WHERE n:NbxHub OR n:NbxSmall OR n:NbxLeaf DETACH DELETE n').catch(() => undefined);
      await system(`DROP USER ${READER} IF EXISTS`).catch(() => undefined);
      await system(`DROP ROLE ${ROLE} IF EXISTS`).catch(() => undefined);
      await admin.close();
    }
  }, 300_000);
});
