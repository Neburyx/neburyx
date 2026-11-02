import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sourcesResponseSchema } from '@neburyx/contracts';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { sourceWith } from '../testing/gate-fixtures.js';
import { fileOf } from '../testing/mapping.js';
import { envFor, neo4jImageFrom, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-container.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { startApi, stopApi, webRoot } from '../testing/start-api.js';

const folder = mkdtempSync(join(tmpdir(), 'startup-neo4j-'));
let neo4jServer: RunningNeo4j;
let postgres: TestPostgres;

beforeAll(async () => {
  [neo4jServer, postgres] = await Promise.all([startNeo4j(), startPostgres()]);
});

afterAll(async () => {
  await runAll([() => postgres?.stop(), () => neo4jServer?.stop()]);
  rmSync(folder, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof address === 'object' && address !== null ? address.port : 0;
}

const auth = { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD };

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  expect(result.code).toBe(0);
  return database;
}

let counter = 0;
function mappingFile(...sources: Record<string, unknown>[]): string {
  counter += 1;
  const file = join(folder, `neburyx-${counter}.yaml`);
  writeFileSync(file, fileOf(...sources));
  return file;
}

describe(`the startup check against ${neo4jImageFrom(process.env)}`, () => {
  it('leaves a reachable source connected with the version stored and a closed one unavailable, before the first request', async () => {
    const database = await migrated();
    const file = mappingFile(
      sourceWith('alpha', { uri: neo4jServer.boltUri, database: 'neo4j', auth }),
      sourceWith('beta', { uri: `bolt://127.0.0.1:${await freePort()}`, database: 'neo4j', auth }),
    );
    const { result } = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: file, ...envFor(neo4jServer) });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      const listed = sourcesResponseSchema.parse((await result.app.inject({ method: 'GET', url: '/v1/sources' })).json());
      expect(listed.items.map((item) => [item.id, item.state, item.stateReason])).toEqual([
        ['alpha', 'connected', null],
        ['beta', 'unavailable', 'The source could not be reached.'],
      ]);
      expect(listed.items.every((item) => item.lastTestAt !== null)).toBe(true);
      const stored = await rows(database.ownerUrl, 'SELECT source_id, outcome, server_version, triggered_by FROM source_checks ORDER BY source_id');
      const tag = neo4jServer.image.split(':')[1] ?? '';
      expect(stored.map((row) => [row['source_id'], row['outcome'], row['triggered_by']])).toEqual([['alpha', 'pass', null], ['beta', 'fail', null]]);
      expect(String(stored[0]?.['server_version'])).toMatch(new RegExp(`^Neo4j ${tag.replace('.', '\\.')}(\\.|$)`));
      expect(stored[1]?.['server_version']).toBeNull();
    } finally {
      await stopApi(result);
    }
  });

  it('replaces the unknown state that an identity change leaves with the result of the new check', async () => {
    const database = await migrated();
    const first = mappingFile(sourceWith('alpha', { uri: neo4jServer.boltUri, database: 'neo4j', auth }));
    const started = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: first, ...envFor(neo4jServer) });
    await stopApi(started.result);
    expect(await rows(database.ownerUrl, `SELECT state FROM sources WHERE id = 'alpha'`)).toEqual([{ state: 'connected' }]);
    const second = mappingFile(sourceWith('alpha', { uri: `bolt://127.0.0.1:${await freePort()}`, database: 'neo4j', auth }));
    const restarted = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: second, ...envFor(neo4jServer) });
    await stopApi(restarted.result);
    expect(await rows(database.ownerUrl, `SELECT state, state_reason FROM sources WHERE id = 'alpha'`)).toEqual([{ state: 'unavailable', state_reason: 'The source could not be reached.' }]);
  });
});
