import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppStore, type AppStore } from '../app-store.js';
import { uuidv7 } from '../identity/uuid.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { initialDraftDocuments } from './draft.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const entities = [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }];
const mapping = parseMapping(fileOf(...['demo', 'other'].map((id) => baseSource({ id, uri: `neo4j+s://${id}.example.test:7687`, entities, relationships: [] }))), 'neburyx.yaml');
const modelOf = (id: string) => mapping.sources.find((source) => source.id === id) ?? (() => { throw new Error(`no source ${id}`); })();

let postgres: TestPostgres;
const stores: AppStore[] = [];
beforeAll(async () => {
  postgres = await startPostgres();
});
afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await postgres.stop();
});

async function started() {
  const database = await postgres.newDatabase();
  expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
  const store = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  stores.push(store);
  await store.initialize();
  await store.syncSources(mapping.sources);
  const [owner] = await rows(database.ownerUrl, `SELECT id FROM users WHERE issuer = 'local'`);
  const ownerId = String(owner?.['id']);
  async function add(over: { sourceId?: string; owner?: string; status?: string; deleted?: boolean } = {}): Promise<string> {
    const id = uuidv7();
    const sourceId = over.sourceId ?? 'demo';
    const documents = initialDraftDocuments({ entityType: 'widget', stableId: id.slice(-6) });
    await store.createInvestigation({
      id,
      sourceId,
      sourceIdentityHash: identityHashOf(modelOf(sourceId)),
      ownerId: over.owner ?? ownerId,
      title: `Widget ${id.slice(-6)}`,
      caseRef: 'REF-1',
      startingEntityType: 'widget',
      startingStableId: id.slice(-6),
      draft: { id: uuidv7(), ...documents, mappingHash: 'm', contentHash: 'c1', nodeCount: 1, edgeCount: 0, countsPolicyVersion: 'none' },
    });
    await rows(database.ownerUrl, `UPDATE investigations SET status = $2, deleted_at = $3 WHERE id = $1`, [id, over.status ?? 'open', over.deleted === true ? '2026-11-05T09:00:00Z' : null]);
    return id;
  }
  return { database, store, ownerId, add };
}

describe('the investigations named for a list of chats, against Postgres', () => {
  it('names the open, live investigations of the owner among the ids, on the sources given, with the alias of the source', async () => {
    const { store, ownerId, add } = await started();
    const mine = await add();
    const closed = await add({ status: 'closed' });
    const archived = await add({ status: 'archived' });
    const deleted = await add({ deleted: true });
    const elsewhere = await add({ sourceId: 'other' });
    const named = await store.readLibrary((reader) => reader.readNamedInvestigations({ ownerId, ids: [mine, closed, archived, deleted, elsewhere, uuidv7()], sourceIds: ['demo'] }));
    expect(named.map((each) => each.id)).toEqual([mine]);
    expect(named[0]?.sourceAlias).toBe('demo');
    const both = await store.readLibrary((reader) => reader.readNamedInvestigations({ ownerId, ids: [mine, elsewhere], sourceIds: ['demo', 'other'] }));
    expect(both.map((each) => each.id).sort()).toEqual([mine, elsewhere].sort());
  });

  it('names nothing for another owner’s ids and nothing for an empty list', async () => {
    const { store, ownerId, add } = await started();
    const mine = await add();
    expect(await store.readLibrary((reader) => reader.readNamedInvestigations({ ownerId: uuidv7(), ids: [mine], sourceIds: ['demo'] }))).toEqual([]);
    expect(await store.readLibrary((reader) => reader.readNamedInvestigations({ ownerId, ids: [], sourceIds: ['demo'] }))).toEqual([]);
  });
});
