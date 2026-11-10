import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppStore, type AppStore } from '../app-store.js';
import { contentHashOf, initialDraftDocuments } from '../investigations/draft.js';
import { uuidv7 } from '../identity/uuid.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { webRoot } from '../testing/start-api.js';
import { reportFromFailure, reportFromServer } from '../source-test/report.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta'));
const [alpha, beta] = mapping.sources;
if (alpha === undefined || beta === undefined) throw new Error('the fixture mapping has two sources');
const SERVER = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] };
const CURRENT = identityHashOf(alpha);

let postgres: TestPostgres;
const stores: AppStore[] = [];
beforeAll(async () => {
  postgres = await startPostgres();
});
afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

async function opened(): Promise<{ readonly database: TestDatabase; readonly store: AppStore }> {
  const database = await postgres.newDatabase();
  expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
  const store = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  stores.push(store);
  await store.initialize();
  await store.syncSources(mapping.sources);
  return { database, store };
}

async function addInvestigation(database: TestDatabase, store: AppStore, sourceId: string, hash: string): Promise<string> {
  const [owner] = await rows(database.ownerUrl, `SELECT id FROM users WHERE issuer = 'local'`);
  const id = uuidv7();
  const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
  await store.createInvestigation({ id, sourceId, sourceIdentityHash: hash, ownerId: String(owner?.['id']), title: 'T', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', draft: { id: uuidv7(), ...documents, mappingHash: 'h', contentHash: contentHashOf(documents), nodeCount: 1, edgeCount: 0, countsPolicyVersion: 'none' } });
  return id;
}

const testedOn = (store: AppStore, hash: string, reached = true) =>
  store.recordSourceCheck({ id: uuidv7(), report: reached ? reportFromServer(alpha, SERVER, null, '2026-11-09T10:00:00.000Z') : reportFromFailure(alpha, 'unreachable', '2026-11-09T10:00:00.000Z'), triggeredBy: null, identityHash: hash, configHash: alpha.configHash });
const hashesOf = (database: TestDatabase) => rows(database.ownerUrl, 'SELECT id, source_id, source_identity_hash, version, last_edited_at FROM investigations ORDER BY id');

describe('rebinding a source on PostgreSQL', () => {
  it('sets the hash of that source\'s investigations that differ, in one statement, and leaves every other column and every other source alone', async () => {
    const { database, store } = await opened();
    const stale = await addInvestigation(database, store, 'alpha', 'old');
    await addInvestigation(database, store, 'alpha', CURRENT);
    await addInvestigation(database, store, 'beta', 'beta-old');
    await testedOn(store, CURRENT);
    const before = await hashesOf(database);
    expect(await store.rebindSource('alpha', CURRENT)).toEqual({ outcome: 'rebound', count: 1 });
    const after = await hashesOf(database);
    expect(after.map((row) => row['source_identity_hash'])).toEqual(before.map((row) => (row['id'] === stale ? CURRENT : row['source_identity_hash'])));
    expect(after.map((row) => [row['id'], row['version'], row['last_edited_at']])).toEqual(before.map((row) => [row['id'], row['version'], row['last_edited_at']]));
    expect(await store.rebindSource('alpha', CURRENT)).toEqual({ outcome: 'rebound', count: 0 });
  });

  it('writes nothing without a check that reached the source on this connection, or with one that did not', async () => {
    const { database, store } = await opened();
    await addInvestigation(database, store, 'alpha', 'old');
    const before = JSON.stringify(await hashesOf(database));
    expect(await store.rebindSource('alpha', CURRENT)).toEqual({ outcome: 'not-tested' });
    await testedOn(store, 'the-previous-connection');
    await testedOn(store, CURRENT, false);
    expect(await store.rebindSource('alpha', CURRENT)).toEqual({ outcome: 'not-tested' });
    expect(JSON.stringify(await hashesOf(database))).toBe(before);
  });

  it('refuses a source the table does not hold, one marked removed, and a hash the row does not hold', async () => {
    const { database, store } = await opened();
    await addInvestigation(database, store, 'alpha', 'old');
    await testedOn(store, CURRENT);
    const before = JSON.stringify(await hashesOf(database));
    expect(await store.rebindSource('gamma', CURRENT)).toEqual({ outcome: 'unknown-source' });
    expect(await store.rebindSource('alpha', 'not-the-stored-hash')).toEqual({ outcome: 'not-synced' });
    await rows(database.ownerUrl, `UPDATE sources SET removed_at = now() WHERE id = 'alpha'`);
    expect(await store.rebindSource('alpha', CURRENT)).toEqual({ outcome: 'unknown-source' });
    expect(JSON.stringify(await hashesOf(database))).toBe(before);
  });

  it('reads the proof under the lock on the source row: a sync that lands between the proof and the write leaves nothing written', async () => {
    const { database, store } = await opened();
    await addInvestigation(database, store, 'alpha', 'old');
    await testedOn(store, CURRENT);
    const before = JSON.stringify(await hashesOf(database));
    const holder = new pg.Client({ connectionString: database.ownerUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE sources SET identity_hash = 'a-newer-connection' WHERE id = 'alpha'`);
      const waiting = store.rebindSource('alpha', CURRENT);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query('COMMIT');
      expect(await waiting).toEqual({ outcome: 'not-synced' });
    } finally {
      await holder.end();
    }
    expect(JSON.stringify(await hashesOf(database))).toBe(before);
  });
});
