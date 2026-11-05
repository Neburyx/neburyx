import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sourceTestReportSchema } from '@neburyx/contracts';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import { createSourceGate } from '../gate/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import { rows, runInProcess } from '../testing/database.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { fileOf } from '../testing/mapping.js';
import { envFor, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { seedFixtureGraph } from '../testing/seed-graph.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { webRoot } from '../testing/start-api.js';
import { runTestSourceCommand } from './command.js';
import { createSourceTester } from './tester.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const folder = mkdtempSync(join(tmpdir(), 'test-source-neo4j-'));
let neo4jServer: RunningNeo4j;
let postgres: TestPostgres;
let database: TestDatabase;
let store: AppStore;

const options = () => ({ uri: neo4jServer.boltUri, database: neo4jServer.database, auth: { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD } });

beforeAll(async () => {
  [neo4jServer, postgres] = await Promise.all([startNeo4j(), startPostgres()]);
  await seedFixtureGraph(neo4jServer);
  database = await postgres.newDatabase();
  const migrated = await runInProcess({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }, SHIPPED);
  expect(migrated.code, migrated.stderr).toBe(0);
  store = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  await store.initialize();
  await store.syncSources(mappingOf(sourceWith('alpha', options()), sourceWith('beta', options())).sources);
});

afterAll(async () => {
  await runAll([() => store?.close(), () => postgres?.stop(), () => neo4jServer?.stop()]);
  rmSync(folder, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
});

async function command(args: readonly string[], file: string) {
  let out = '';
  let err = '';
  const code = await runTestSourceCommand(args, { DATABASE_URL: database.appUrl, NEBURYX_CONFIG: file, ...envFor(neo4jServer) }, {
    stdout: { write: (text) => (out += text) },
    stderr: { write: (text) => (err += text) },
  });
  return { code, out, err };
}

describe(`neburyx test-source against the dev Neo4j server`, () => {
  it('prints the same facts as the route, stores the run for the local identity, and writes nothing to the sources table', async () => {
    const file = join(folder, 'only-alpha.yaml');
    writeFileSync(file, fileOf(sourceWith('alpha', options())));
    const before = await rows(database.ownerUrl, 'SELECT id, removed_at, updated_at FROM sources ORDER BY id');
    const result = await command(['--name', 'alpha'], file);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');

    const mapping = mappingOf(sourceWith('alpha', options()), sourceWith('beta', options()));
    const gate = createSourceGate({ usability: ALWAYS_USABLE, mapping, env: envFor(neo4jServer), seams: communitySeams(), logger: { warn: () => undefined } });
    const routeStore = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: routeStore, mapping, sourceTester: createSourceTester({ gate: gate.gate, mapping, store: routeStore }) });
    const report = sourceTestReportSchema.parse((await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' })).json());
    await app.close();
    await gate.close();

    expect(report.server).not.toBeNull();
    expect(result.out).toContain(`Outcome: ${report.outcome}\nState: ${report.state}\n`);
    expect(result.out).toContain(`Server: ${report.server?.product} ${report.server?.version} (${report.server?.edition})\n`);
    expect(result.out).toContain(`Version supported: ${report.versionSupported === true ? 'yes' : 'no'}\n`);
    expect(result.out).toContain(`Operations: ${report.operations.map((operation) => `${operation.name} (${operation.status})`).join(', ')}\n`);
    expect(result.out).toContain(`Mapping: ${report.mappingSummary.entityTypes} entity types, ${report.mappingSummary.relationshipTypes} relationship types, ${report.mappingSummary.derivedRules} derived rules\n`);

    expect(report.degreeChecks.status).toBe('pass');
    expect(result.out).toContain(`Degree counts: pass\n${report.degreeChecks.types.map((entry) => `  ${entry.entityType}: cheap (${entry.relationshipTypes.join(', ')})\n`).join('')}  found on ${report.degreeChecks.foundOn}\n`);

    const user = (await store.current()).principal.id;
    const checks = await rows(database.ownerUrl, `SELECT triggered_by, outcome FROM source_checks WHERE source_id = 'alpha' ORDER BY checked_at`);
    expect(checks).toEqual([{ triggered_by: user, outcome: 'pass' }, { triggered_by: user, outcome: 'pass' }]);
    const sources = await rows(database.ownerUrl, 'SELECT id, removed_at, updated_at FROM sources ORDER BY id');
    expect(sources.map((row) => [row['id'], row['removed_at'], row['updated_at']])).toEqual(before.map((row) => [row['id'], row['removed_at'], row['updated_at']]));
  });

  it('exits 1 and says the API must be started once for a source the database does not know', async () => {
    const file = join(folder, 'unknown-to-database.yaml');
    writeFileSync(file, fileOf(sourceWith('gamma', options())));
    const result = await command(['--name', 'gamma'], file);
    expect(result.code).toBe(1);
    expect(result.err).toBe('the database does not know this source yet; start the API once so that it creates the local identity and the sources\n');
  });
});
