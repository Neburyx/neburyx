import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAssistantThreadStore, type AssistantThreadStore } from '@neburyx/ee-ask';
import { changeInvestigationStatus } from '../db/investigations-repository.js';
import type { AssistantThreadTurnWrite } from '@neburyx/contracts';
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

const turn = (over: Partial<AssistantThreadTurnWrite> = {}): AssistantThreadTurnWrite => ({ id: randomUUID(), investigationId: FIRST, userId: OWNER, at: new Date('2026-11-18T10:00:00Z'), route: 'ask', outcome: 'answered', questionHash: HASH, intent: 'widgetById', entities: [{ role: 'id', ref: { sourceId: 'alpha', entityType: 'widget', stableId: 'W-1' } }], citationRefs: [{ sourceId: 'alpha', entityType: 'widget', stableId: 'W-1' }], steps: 1, modelRef: 'm', promptVersion: '1', tokensIn: 10, tokensOut: 5, ...over });

async function withStore<T>(database: TestDatabase, work: (store: AssistantThreadStore) => Promise<T>): Promise<T> {
  const store = createPgAssistantThreadStore(contextOf(database));
  try {
    return await work(store);
  } finally {
    await store.close();
  }
}

const count = async (database: TestDatabase, table: string, where = 'true'): Promise<number> => Number((await rows(database.ownerUrl, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0]?.['n']);
const ALLOWED_TURN_COLUMNS = ['id', 'thread_id', 'seq', 'at', 'route', 'outcome', 'cause', 'question_hash', 'intent', 'template_id', 'entities', 'citation_refs', 'steps', 'model_ref', 'prompt_version', 'tokens_in', 'tokens_out', 'run_id'];
const TEXT_TABLES = ['assistant_threads', 'assistant_turns', 'assistant_investigation_epochs', 'assistant_thread_clears'];
const ALLOWED_COLUMNS: Readonly<Record<string, readonly string[]>> = { assistant_threads: ['id', 'investigation_id', 'user_id', 'created_at', 'last_turn_at'], assistant_turns: ALLOWED_TURN_COLUMNS, assistant_investigation_epochs: ['investigation_id', 'epoch'], assistant_thread_clears: ['investigation_id', 'user_id', 'cleared_at'] };

const waitUntilBlocked = async (database: TestDatabase): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (Number((await rows(database.adminUrl, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = '${database.ownerUrl.split('/').at(-1)?.split('?')[0] ?? ''}'`))[0]?.['n']) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no statement is waiting for a lock');
};

const columnsOf = async (database: TestDatabase, table: string): Promise<string[]> => (await rows(database.ownerUrl, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])).map((row) => String(row['column_name']));

describe('the column list of the thread tables', () => {
  it('is exactly the list of the decisions, and a column added to any of them fails the check', async () => {
    const database = await seeded();
    const differences = async (): Promise<string[]> => (await Promise.all(TEXT_TABLES.map(async (table) => ((await columnsOf(database, table)).join() === (ALLOWED_COLUMNS[table] ?? []).join() ? '' : table)))).filter((name) => name !== '');
    expect(await differences()).toEqual([]);
    await rows(database.ownerUrl, 'ALTER TABLE assistant_turns ADD COLUMN question_text text');
    expect(await differences()).toEqual(['assistant_turns']);
  });
});

describe('the thread tables of the assistant', () => {
  it('have the columns of the decisions and no column that can hold text', async () => {
    const database = await seeded();
    expect(await columnsOf(database, 'assistant_threads')).toEqual(['id', 'investigation_id', 'user_id', 'created_at', 'last_turn_at']);
    expect(await columnsOf(database, 'assistant_turns')).toEqual(['id', 'thread_id', 'seq', 'at', 'route', 'outcome', 'cause', 'question_hash', 'intent', 'template_id', 'entities', 'citation_refs', 'steps', 'model_ref', 'prompt_version', 'tokens_in', 'tokens_out', 'run_id']);
    expect(await columnsOf(database, 'assistant_investigation_epochs')).toEqual(['investigation_id', 'epoch']);
    expect(await columnsOf(database, 'assistant_thread_clears')).toEqual(['investigation_id', 'user_id', 'cleared_at']);
  });

  it('cascade: turns with their thread, threads with their investigation, and one thread a person in an investigation', async () => {
    const database = await seeded();
    await withStore(database, async (store) => {
      expect(await store.append(turn(), 0)).toBe('stored');
      expect(await store.append(turn({ userId: OTHER }), 0)).toBe('stored');
    });
    expect(await count(database, 'assistant_threads')).toBe(2);
    expect(await attempt(database.ownerUrl, `INSERT INTO assistant_threads (id, investigation_id, user_id, created_at, last_turn_at) VALUES ($1, '${FIRST}', '${OWNER}', now(), now())`, [randomUUID()])).not.toBe('allowed');
    await rows(database.ownerUrl, `DELETE FROM investigations WHERE id = '${FIRST}'`);
    expect(await count(database, 'assistant_threads')).toBe(0);
    expect(await count(database, 'assistant_turns')).toBe(0);
  });
});

describe('the clearing when an investigation is closed, archived or deleted', () => {
  it.each([
    ['closed', `status = 'closed', closed_at = now()`],
    ['archived', `status = 'archived', archived_at = now()`],
    ['soft-deleted', `deleted_at = now()`],
  ])('deletes every person’s threads of the investigation when it is %s, records who and how often, and leaves the other investigation alone', async (_name, change) => {
    const database = await seeded();
    await withStore(database, async (store) => {
      await store.append(turn(), 0);
      await store.append(turn({ userId: OTHER }), 0);
      await store.append(turn({ investigationId: SECOND }), 0);
    });
    await rows(database.ownerUrl, `UPDATE investigations SET ${change} WHERE id = '${FIRST}'`);
    expect(await count(database, 'assistant_threads', `investigation_id = '${FIRST}'`)).toBe(0);
    expect(await count(database, 'assistant_threads', `investigation_id = '${SECOND}'`)).toBe(1);
    expect(await count(database, 'assistant_turns')).toBe(1);
    expect((await rows(database.ownerUrl, `SELECT user_id FROM assistant_thread_clears WHERE investigation_id = '${FIRST}' ORDER BY user_id`)).map((row) => row['user_id'])).toEqual([OWNER, OTHER]);
    expect(await rows(database.ownerUrl, `SELECT epoch::int AS epoch FROM assistant_investigation_epochs WHERE investigation_id = '${FIRST}'`)).toEqual([{ epoch: 1 }]);
    expect(await count(database, 'assistant_investigation_epochs', `investigation_id = '${SECOND}'`)).toBe(0);
  });

  it('records a person who had a thread and none for a person who had not, moves the epoch again for a later archive, and leaves everything when the change fails', async () => {
    const database = await seeded();
    await withStore(database, (store) => store.append(turn(), 0));
    const client = new pg.Client({ connectionString: database.ownerUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE investigations SET status = 'closed', closed_at = now() WHERE id = '${FIRST}'`);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
    expect(await count(database, 'assistant_threads')).toBe(1);
    expect(await count(database, 'assistant_thread_clears')).toBe(0);
    await rows(database.ownerUrl, `UPDATE investigations SET status = 'closed', closed_at = now() WHERE id = '${FIRST}'`);
    await rows(database.ownerUrl, `UPDATE investigations SET status = 'archived', archived_at = now() WHERE id = '${FIRST}'`);
    expect(await count(database, 'assistant_thread_clears', `user_id = '${OTHER}'`)).toBe(0);
    expect(await rows(database.ownerUrl, `SELECT epoch::int AS epoch FROM assistant_investigation_epochs WHERE investigation_id = '${FIRST}'`)).toEqual([{ epoch: 2 }]);
  });

  it('starts a reopened investigation with an empty thread, and says when the previous one was cleared', async () => {
    const database = await seeded();
    await withStore(database, async (store) => {
      await store.append(turn(), 0);
      await rows(database.ownerUrl, `UPDATE investigations SET status = 'closed', closed_at = now() WHERE id = '${FIRST}'`);
      await rows(database.ownerUrl, `UPDATE investigations SET status = 'open', closed_at = NULL WHERE id = '${FIRST}'`);
      const read = await store.read(FIRST, OWNER, 100);
      expect(read.turns).toEqual([]);
      expect(read.previousThreadClearedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect((await store.read(FIRST, OTHER, 100)).previousThreadClearedAt).toBeNull();
      expect(await store.append(turn(), 1)).toBe('stored');
      expect((await store.read(FIRST, OWNER, 100)).previousThreadClearedAt).toBeNull();
    });
  });
});

describe('the clearing in the product’s own status change, as the application role', () => {
  const change = (status: 'closed' | 'open', beforeCommit: (row: unknown, transaction: { query(text: string, values?: readonly unknown[]): Promise<unknown> }) => Promise<void>) => ({ investigationId: FIRST, ownerId: OWNER, expectedVersion: status === 'closed' ? 1 : 2, status, beforeCommit });

  it('deletes the thread in the transaction of the change that also writes its audit event, and leaves it when that event cannot be written', async () => {
    const database = await seeded();
    await withStore(database, (store) => store.append(turn(), 0));
    const pool = new pg.Pool({ connectionString: database.appUrl });
    try {
      await expect(changeInvestigationStatus(pool, change('closed', () => Promise.reject(new Error('the audit store is down'))))).rejects.toThrow('the audit store is down');
      expect(await count(database, 'assistant_threads')).toBe(1);
      expect(await count(database, 'assistant_investigation_epochs')).toBe(0);
      expect(await rows(database.ownerUrl, `SELECT status FROM investigations WHERE id = '${FIRST}'`)).toEqual([{ status: 'open' }]);
      const result = await changeInvestigationStatus(pool, change('closed', async (_row, transaction) => void (await transaction.query('INSERT INTO audit_events (id, actor_id, actor_role, action, result, trace_id) VALUES ($1, $2, $3, $4, $5, $6)', [randomUUID(), OWNER, 'investigator', 'investigation.close', 'success', 'tr-1']))));
      expect(result).toMatchObject({ outcome: 'changed' });
      expect(await count(database, 'assistant_threads')).toBe(0);
      expect(await count(database, 'assistant_thread_clears')).toBe(1);
      expect(await count(database, 'audit_events', "action = 'investigation.close'")).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

describe('the store as the application role', () => {
  it('creates the thread, follows seq, moves last_turn_at, and reads the caller’s own thread only', async () => {
    const database = await seeded();
    await withStore(database, async (store) => {
      expect(await store.epoch(FIRST)).toBe(0);
      await store.append(turn({ at: new Date('2026-11-18T10:00:00Z') }), 0);
      await store.append(turn({ at: new Date('2026-11-18T10:05:00Z'), route: 'refuse', outcome: 'refused', cause: 'verdict', intent: undefined, entities: [], citationRefs: [], steps: 0, modelRef: undefined, promptVersion: undefined, tokensIn: undefined, tokensOut: undefined }), 0);
      await store.append(turn({ userId: OTHER }), 0);
      const own = await store.read(FIRST, OWNER, 100);
      expect(own.turns.map((held) => [held.seq, held.route, held.outcome, held.cause, held.citedElements])).toEqual([[1, 'ask', 'answered', undefined, 1], [2, 'refuse', 'refused', 'verdict', 0]]);
      expect((await store.read(FIRST, OTHER, 100)).turns).toHaveLength(1);
    });
    expect(await rows(database.ownerUrl, `SELECT last_turn_at FROM assistant_threads WHERE user_id = '${OWNER}'`)).toEqual([{ last_turn_at: new Date('2026-11-18T10:05:00Z') }]);
    expect(await rows(database.ownerUrl, `SELECT model_ref, tokens_in FROM assistant_turns WHERE cause = 'verdict'`)).toEqual([{ model_ref: null, tokens_in: null }]);
  });

  it('reads the caller’s last turns for the router with the references they ran and cited, oldest first, and nothing of another person, another investigation or older turns than the bound', async () => {
    const database = await seeded();
    const ref = (stableId: string) => ({ sourceId: 'demo', entityType: 'widget', stableId });
    await withStore(database, async (store) => {
      await store.append(turn({ at: new Date('2026-11-18T10:00:00Z'), intent: 'one' }), 0);
      await store.append(turn({ at: new Date('2026-11-18T10:05:00Z'), intent: 'two', entities: [{ role: 'id', ref: ref('A-1') }], citationRefs: [ref('A-2')] }), 0);
      await store.append(turn({ at: new Date('2026-11-18T10:10:00Z'), route: 'refuse', outcome: 'refused', cause: 'verdict', intent: undefined, steps: 0 }), 0);
      await store.append(turn({ userId: OTHER, intent: 'theirs', entities: [{ role: 'id', ref: ref('A-9') }] }), 0);
      await store.append(turn({ investigationId: SECOND, intent: 'elsewhere' }), 0);
      const context = await store.readContext(FIRST, OWNER, 2);
      expect(context.map((held) => [held.route, held.outcome, held.cause, held.intent])).toEqual([['ask', 'answered', undefined, 'two'], ['refuse', 'refused', 'verdict', undefined]]);
      expect(context[0]?.entities).toEqual([{ role: 'id', ref: ref('A-1') }]);
      expect(context[0]?.citationRefs).toEqual([ref('A-2')]);
      expect(JSON.stringify(await store.readContext(FIRST, OWNER, 100))).not.toMatch(/theirs|elsewhere|A-9/);
      expect(await store.readContext(FIRST, '0192f000-0000-7000-8000-0000000000ff', 100)).toEqual([]);
    });
  });

  it('refuses a turn for a closed or deleted investigation and for another epoch, writing nothing', async () => {
    const database = await seeded();
    await withStore(database, async (store) => {
      expect(await store.append(turn(), 7)).toBe('refused');
      await rows(database.ownerUrl, `UPDATE investigations SET status = 'closed', closed_at = now() WHERE id = '${FIRST}'`);
      expect(await store.append(turn(), 1)).toBe('refused');
      expect(await store.append(turn({ investigationId: randomUUID() }), 0)).toBe('refused');
    });
    expect(await count(database, 'assistant_threads')).toBe(0);
  });

  it('answers the fixed error for a failing statement, with no driver text', async () => {
    const database = await seeded();
    await withStore(database, async (store) => {
      await expect(store.append({ ...turn(), questionHash: 'not-a-hash' }, 0)).rejects.toMatchObject({ code: 'ASSISTANT_THREAD_STORE_FAILED' });
      await expect(store.read('not-a-uuid', OWNER, 100)).rejects.toMatchObject({ code: 'ASSISTANT_THREAD_STORE_FAILED', message: 'the thread of an assistant turn could not be stored or read' });
    });
  });
});

describe('the writes of the store under retries, concurrency and the closing of the investigation', () => {
  it('is safe to write twice: a retry changes nothing, whatever the outcome of the first write', async () => {
    const database = await seeded();
    const first = turn();
    await withStore(database, async (store) => {
      expect(await store.append(first, 0)).toBe('stored');
      const before = await rows(database.ownerUrl, 'SELECT t.seq, h.last_turn_at FROM assistant_turns t JOIN assistant_threads h ON h.id = t.thread_id');
      expect(await store.append(first, 0)).toBe('duplicate');
      expect(await store.append({ ...first, at: new Date('2027-01-01T00:00:00Z') }, 0)).toBe('duplicate');
      expect(await rows(database.ownerUrl, 'SELECT t.seq, h.last_turn_at FROM assistant_turns t JOIN assistant_threads h ON h.id = t.thread_id')).toEqual(before);
    });
    expect(await count(database, 'assistant_turns')).toBe(1);
  });

  it('stores a turn once when the connection fails after the commit and the write is tried again', async () => {
    const database = await seeded();
    const state = { dropAfterCommit: true };
    const store = createPgAssistantThreadStore(contextOf(database), {
      createPool: (config) => {
        const real = new pg.Pool(config);
        return {
          connect: async () => {
            const client = await real.connect();
            return {
              query: async (text, values) => {
                const result = await client.query(text, values === undefined ? undefined : [...values]);
                if (text === 'COMMIT' && state.dropAfterCommit) {
                  state.dropAfterCommit = false;
                  throw new Error('the connection was lost after the commit');
                }
                return result;
              },
              release: () => client.release(),
            };
          },
          end: () => real.end(),
          on: (event, listener) => real.on(event, listener),
        };
      },
    });
    try {
      const first = turn();
      await expect(store.append(first, 0)).rejects.toMatchObject({ code: 'ASSISTANT_THREAD_STORE_FAILED' });
      expect(await count(database, 'assistant_turns')).toBe(1);
      expect(await store.append(first, 0)).toBe('duplicate');
      expect(await count(database, 'assistant_turns')).toBe(1);
      expect(await count(database, 'assistant_threads')).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('keeps distinct, ordered seq for writers that append to one thread at once, and one thread for writers that create it at once', async () => {
    const database = await seeded();
    const one = createPgAssistantThreadStore(contextOf(database));
    const two = createPgAssistantThreadStore(contextOf(database));
    try {
      const first = await Promise.all([one.append(turn(), 0), two.append(turn(), 0), one.append(turn(), 0), two.append(turn(), 0)]);
      expect(first.filter((result) => result === 'stored')).toHaveLength(4);
      expect(await count(database, 'assistant_threads')).toBe(1);
      const more = await Promise.all(Array.from({ length: 8 }, (_unused, index) => (index % 2 === 0 ? one : two).append(turn(), 0)));
      expect(more.filter((result) => result === 'stored')).toHaveLength(8);
      expect((await rows(database.ownerUrl, 'SELECT seq FROM assistant_turns ORDER BY seq')).map((row) => row['seq'])).toEqual(Array.from({ length: 12 }, (_unused, index) => index + 1));
    } finally {
      await one.close();
      await two.close();
    }
  });

  it('never leaves a thread behind a close that races an append: the turn is stored and then cleared, or refused', async () => {
    const database = await seeded();
    for (let round = 0; round < 6; round += 1) {
      const id = randomUUID();
      await rows(database.ownerUrl, `INSERT INTO investigations (id, source_id, source_identity_hash, owner_id, title) VALUES ('${id}', 'alpha', 'i', '${OWNER}', 'Raced')`);
      await withStore(database, async (store) => {
        const [result] = await Promise.all([store.append(turn({ investigationId: id }), 0), rows(database.ownerUrl, `UPDATE investigations SET status = 'closed', closed_at = now() WHERE id = '${id}'`)]);
        expect(['stored', 'refused']).toContain(result);
      });
      expect(await count(database, 'assistant_threads', `investigation_id = '${id}'`), `round ${round}`).toBe(0);
    }
  });

  it('serializes an append against a closing transaction that holds the investigation: the append waits, then is refused, and nothing is left', async () => {
    const database = await seeded();
    const closer = new pg.Client({ connectionString: database.ownerUrl });
    await closer.connect();
    try {
      await closer.query('BEGIN');
      await closer.query(`UPDATE investigations SET status = 'closed', closed_at = now() WHERE id = '${FIRST}'`);
      await withStore(database, async (store) => {
        const waiting = store.append(turn(), 0);
        waiting.catch(() => undefined);
        await waitUntilBlocked(database);
        await closer.query('COMMIT');
        expect(await waiting).toBe('refused');
      });
      expect(await count(database, 'assistant_threads')).toBe(0);
    } finally {
      await closer.end();
    }
  });

  it('serializes a close against an append of the real store that holds the investigation: the close waits, then clears the thread that append stored', async () => {
    const database = await seeded();
    const gate = { release: (): void => undefined };
    const held = new Promise<void>((resolve) => (gate.release = resolve));
    const state = { locked: false };
    const store = createPgAssistantThreadStore(contextOf(database), {
      createPool: (config) => {
        const real = new pg.Pool(config);
        return {
          connect: async () => {
            const client = await real.connect();
            return {
              query: async (text, values) => {
                const result = await client.query(text, values === undefined ? undefined : [...values]);
                if (text.includes('FOR SHARE')) {
                  state.locked = true;
                  await held;
                }
                return result;
              },
              release: () => client.release(),
            };
          },
          end: () => real.end(),
          on: (event, listener) => real.on(event, listener),
        };
      },
    });
    const closer = new pg.Client({ connectionString: database.ownerUrl });
    await closer.connect();
    try {
      const appending = store.append(turn(), 0);
      for (let attempt = 0; attempt < 200 && !state.locked; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(state.locked).toBe(true);
      const closing = closer.query(`UPDATE investigations SET status = 'closed', closed_at = now() WHERE id = '${FIRST}'`);
      await waitUntilBlocked(database);
      gate.release();
      expect(await appending).toBe('stored');
      await closing;
      expect(await count(database, 'assistant_threads')).toBe(0);
      expect(await rows(database.ownerUrl, `SELECT user_id FROM assistant_thread_clears WHERE investigation_id = '${FIRST}'`)).toEqual([{ user_id: OWNER }]);
      expect(await rows(database.ownerUrl, `SELECT epoch::int AS epoch FROM assistant_investigation_epochs WHERE investigation_id = '${FIRST}'`)).toEqual([{ epoch: 1 }]);
    } finally {
      await closer.end();
      await store.close();
    }
  });

  it('reads the turns and the clearing from one snapshot: a close that races the read never gives turns with the time they were cleared', async () => {
    const database = await seeded();
    for (let round = 0; round < 12; round += 1) {
      const id = randomUUID();
      await rows(database.ownerUrl, `INSERT INTO investigations (id, source_id, source_identity_hash, owner_id, title) VALUES ('${id}', 'alpha', 'i', '${OWNER}', 'Read race')`);
      await withStore(database, async (store) => {
        await store.append(turn({ investigationId: id }), 0);
        const [answer] = await Promise.all([store.read(id, OWNER, 100), rows(database.ownerUrl, `UPDATE investigations SET status = 'closed', closed_at = now() WHERE id = '${id}'`)]);
        expect(answer.turns.length > 0 && answer.previousThreadClearedAt !== null, `round ${round}`).toBe(false);
      });
    }
  });

  it('refuses a write that waited across a close and a reopen, whatever clock the turn carries', async () => {
    const database = await seeded();
    await withStore(database, async (store) => {
      const started = await store.epoch(FIRST);
      await rows(database.ownerUrl, `UPDATE investigations SET status = 'closed', closed_at = now() WHERE id = '${FIRST}'`);
      await rows(database.ownerUrl, `UPDATE investigations SET status = 'open', closed_at = NULL WHERE id = '${FIRST}'`);
      for (const at of [new Date('2000-01-01T00:00:00Z'), new Date(), new Date('2999-01-01T00:00:00Z')]) expect(await store.append(turn({ at }), started)).toBe('refused');
      expect(await count(database, 'assistant_threads')).toBe(0);
      expect(await store.append(turn(), await store.epoch(FIRST))).toBe('stored');
    });
  });
});
