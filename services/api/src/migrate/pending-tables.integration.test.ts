import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAssistantPendingStore, createPgAssistantThreadStore, type AssistantPendingStore } from '@neburyx/ee-ask';
import { changeInvestigationStatus } from '../db/investigations-repository.js';
import { clearRegisteredExtension, type ExtensionLoader } from '../profile/extension.js';
import { attempt, fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const PREVIEW_MIGRATIONS = fileURLToPath(new URL('../../../../ee/migrations', import.meta.url));
const PREVIEW_FILE = join(fixtureFolder({ 'neburyx.yaml': stringify({ sources: [], ai: { preview: true } }) }), 'neburyx.yaml');
const loader: ExtensionLoader = { load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: PREVIEW_MIGRATIONS }) };

const OWNER = '0192f000-0000-7000-8000-000000000001';
const OTHER = '0192f000-0000-7000-8000-000000000002';
const FIRST = '0192f000-0000-7000-8000-0000000000a1';
const SECOND = '0192f000-0000-7000-8000-0000000000a2';
const HASH = 'a'.repeat(64);

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  removeFixtureFolders();
  clearRegisteredExtension();
});

/** A migrated database holding two people, a source and two open investigations of the first person. */
async function seeded(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runInProcess({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole, NEBURYX_CONFIG: PREVIEW_FILE, NEBURYX_PROFILE: 'enterprise' }, SHIPPED, { extensionLoader: loader });
  expect([result.code, result.stderr]).toEqual([0, '']);
  await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ('${OWNER}', 'issuer', 'one', 'One'), ('${OTHER}', 'issuer', 'two', 'Two')`);
  await rows(database.ownerUrl, `INSERT INTO sources (id, alias, connector, uri, database, secret_ref, config_hash, identity_hash) VALUES ('alpha', 'alpha', 'neo4j', 'bolt://x', 'neo4j', 'a:b', 'h', 'i')`);
  for (const id of [FIRST, SECOND]) await rows(database.ownerUrl, `INSERT INTO investigations (id, source_id, source_identity_hash, owner_id, title) VALUES ('${id}', 'alpha', 'i', '${OWNER}', 'Account')`);
  return database;
}

const contextOf = (database: TestDatabase) => ({ databaseUrl: database.appUrl, poolSize: 2, connectionTimeoutMs: 5000, statementTimeoutMs: 5000, queryTimeoutMs: 5000, newId: () => randomUUID(), onConnectionError: () => undefined });


const HASH_ONE = 'b'.repeat(64);
const WHO = { userId: OWNER, investigationId: FIRST, sourceId: 'alpha', mask: false };
const LIFETIME = 15 * 60 * 1000;

async function withStores<T>(database: TestDatabase, work: (first: AssistantPendingStore, second: AssistantPendingStore) => Promise<T>): Promise<T> {
  const first = createPgAssistantPendingStore(contextOf(database));
  const second = createPgAssistantPendingStore(contextOf(database));
  try {
    return await work(first, second);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}

const count = async (database: TestDatabase, where = 'true'): Promise<number> => Number((await rows(database.ownerUrl, `SELECT count(*)::int AS n FROM assistant_pending_confirmations WHERE ${where}`))[0]?.['n']);
const entry = (over: Partial<typeof WHO & { id: string; expiresAtMs: number }> = {}, now = Date.now()) => ({ id: randomUUID(), ...WHO, expiresAtMs: now + LIFETIME, ...over });

describe('the table of the pending confirmations of the assistant', () => {
  it('has the columns of the decision and none that can hold a value, a result or a plan, and one waiting row a person', async () => {
    const database = await seeded();
    const columns = (await rows(database.ownerUrl, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assistant_pending_confirmations' ORDER BY ordinal_position`)).map((row) => String(row['column_name']));
    expect(columns).toEqual(['id', 'user_id', 'investigation_id', 'source_id', 'mask', 'status', 'created_at', 'expires_at']);
    await withStores(database, async (store) => {
      await store.add(entry(), Date.now());
      await store.add(entry(), Date.now());
    });
    expect(await count(database, `user_id = '${OWNER}' AND status = 'waiting'`)).toBe(1);
    expect(await attempt(database.ownerUrl, `INSERT INTO assistant_pending_confirmations (id, user_id, investigation_id, source_id, mask, status, created_at, expires_at) VALUES ($1, '${OWNER}', '${FIRST}', 'alpha', false, 'waiting', now(), now())`, [randomUUID()])).not.toBe('allowed');
  });

  it('replaces instead of failing when two adds of one person are made at the same time', async () => {
    const database = await seeded();
    await withStores(database, async (first, second) => {
      const results = await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 === 0 ? first : second).add(entry({ investigationId: index % 2 === 0 ? FIRST : SECOND }), Date.now())));
      expect(results.filter((result) => result.replaced === undefined)).toHaveLength(1);
    });
    expect(await count(database, `user_id = '${OWNER}' AND status = 'waiting'`)).toBe(1);
  });

  it('decides a new message and the add of an earlier turn of the same person in one order, so one waiting row or none is left, never two and never a failure', async () => {
    const database = await seeded();
    await withStores(database, async (first, second) => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? first.add(entry(), Date.now()) : second.drop(OWNER, Date.now()))));
      expect(results).toHaveLength(8);
    });
    expect(await count(database, `user_id = '${OWNER}' AND status = 'waiting'`)).toBeLessThanOrEqual(1);
  });

  it('lets exactly one of two instances over the one database claim an id, and refuses the same id after', async () => {
    const database = await seeded();
    const results = await withStores(database, async (first, second) => {
      const held = entry();
      await first.add(held, Date.now());
      const claims = await Promise.all([first.claim(held.id, WHO, Date.now()), second.claim(held.id, WHO, Date.now())]);
      return [...claims, await second.claim(held.id, WHO, Date.now())];
    });
    expect(results.slice(0, 2).sort()).toEqual(['claimed', 'used']);
    expect(results[2]).toBe('used');
  });

  it('replaces the waiting confirmation of a person across investigations, and refuses an id of another person, investigation, source or masking', async () => {
    const database = await seeded();
    await withStores(database, async (first, second) => {
      const one = entry();
      const two = entry({ investigationId: SECOND });
      expect(await first.add(one, Date.now())).toEqual({ replaced: undefined });
      expect(await second.add(two, Date.now())).toEqual({ replaced: { investigationId: FIRST, sourceId: 'alpha' } });
      expect(await first.claim(one.id, WHO, Date.now())).toBe('dropped');
      for (const binding of [{ ...WHO, userId: OTHER, investigationId: SECOND }, { ...WHO, investigationId: FIRST }, { ...WHO, investigationId: SECOND, sourceId: 'beta' }, { ...WHO, investigationId: SECOND, mask: true }]) {
        expect(await first.claim(two.id, binding, Date.now())).toBe('other');
      }
      expect(await first.claim(two.id, { ...WHO, investigationId: SECOND }, Date.now())).toBe('claimed');
    });
  });

  it('deletes the expired rows of a person when that person adds or claims, with no timer, and refuses an expired id', async () => {
    const database = await seeded();
    await withStores(database, async (store) => {
      const old = entry({}, Date.now() - 2 * LIFETIME);
      await store.add(old, Date.now() - 2 * LIFETIME);
      expect(await count(database, `id = '${old.id}'`)).toBe(1);
      const fresh = entry();
      await store.add(fresh, Date.now());
      expect(await count(database, `id = '${old.id}'`)).toBe(0);
      expect(await store.claim(old.id, WHO, Date.now())).toBe('unknown');
      expect(await store.claim(fresh.id, WHO, Date.now() + 2 * LIFETIME)).toBe('expired');
      expect(await count(database, `id = '${fresh.id}'`)).toBe(0);
    });
  });

  it('drops the waiting confirmation for a new message or a cancel, and a later claim fails', async () => {
    const database = await seeded();
    await withStores(database, async (store) => {
      const held = entry();
      await store.add(held, Date.now());
      expect(await store.drop(OWNER, Date.now())).toEqual({ investigationId: FIRST, sourceId: 'alpha' });
      expect(await store.drop(OWNER, Date.now())).toBeUndefined();
      expect(await store.claim(held.id, WHO, Date.now())).toBe('dropped');
    });
  });

  it('is removed with its investigation, and with a close, an archive or a delete of it, so a decision after is refused', async () => {
    for (const change of [`status = 'closed', closed_at = now()`, `status = 'archived', archived_at = now()`, `deleted_at = now()`]) {
      const database = await seeded();
      const held = entry();
      await withStores(database, async (store) => {
        await store.add(held, Date.now());
        await store.add(entry({ investigationId: SECOND, userId: OTHER }), Date.now());
      });
      await rows(database.ownerUrl, `UPDATE investigations SET ${change} WHERE id = '${FIRST}'`);
      expect(await count(database, `investigation_id = '${FIRST}'`)).toBe(0);
      expect(await count(database, `investigation_id = '${SECOND}'`)).toBe(1);
      await withStores(database, async (store) => expect(await store.claim(held.id, WHO, Date.now())).toBe('unknown'));
    }
    const database = await seeded();
    await withStores(database, (store) => store.add(entry(), Date.now()));
    await rows(database.ownerUrl, `DELETE FROM investigations WHERE id = '${FIRST}'`);
    expect(await count(database)).toBe(0);
  });

  it('lets the thread keep a turn that waited, and no other outcome', async () => {
    const database = await seeded();
    const thread = randomUUID();
    await rows(database.ownerUrl, `INSERT INTO assistant_threads (id, investigation_id, user_id, created_at, last_turn_at) VALUES ('${thread}', '${FIRST}', '${OWNER}', now(), now())`);
    const insert = (outcome: string) => attempt(database.ownerUrl, `INSERT INTO assistant_turns (id, thread_id, seq, at, route, outcome, question_hash) VALUES ($1, '${thread}', $2, now(), 'ask', '${outcome}', '${HASH_ONE}')`, [randomUUID(), Math.floor(Math.random() * 1e6) + 1]);
    expect(await insert('waiting')).toBe('allowed');
    expect(await insert('answered')).toBe('allowed');
    expect(await insert('maybe')).not.toBe('allowed');
  });

  it('fails closed with the fixed error when the database cannot be reached', async () => {
    const database = await seeded();
    const store = createPgAssistantPendingStore({ ...contextOf(database), databaseUrl: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMs: 300 });
    await expect(store.add(entry(), Date.now())).rejects.toMatchObject({ code: 'ASSISTANT_PENDING_STORE_FAILED' });
    await store.close();
  });
});
