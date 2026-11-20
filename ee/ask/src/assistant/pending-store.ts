import { randomUUID } from 'node:crypto';
import type { AuditSinkContext } from '@neburyx/contracts';
import pg from 'pg';
import type { ThreadClient, ThreadPool } from './thread-store.js';

/** The size of the pool the store keeps of its own: every statement is short. */
const PENDING_POOL_SIZE = 2;

/** What a failed statement says: a fixed message, never the driver's text or a stored value. */
export class AssistantPendingStoreError extends Error {
  readonly code = 'ASSISTANT_PENDING_STORE_FAILED';

  constructor() {
    super('a waiting confirmation of the assistant could not be stored or read');
    this.name = 'AssistantPendingStoreError';
  }
}

/** Who a waiting confirmation is for and where; it holds no value and no plan. */
export interface PendingBinding {
  readonly userId: string;
  readonly investigationId: string;
  readonly sourceId: string;
  readonly mask: boolean;
}

export interface PendingEntry extends PendingBinding {
  readonly id: string;
  readonly expiresAtMs: number;
}

/** What a claim found: it is the caller's (`claimed`), or why it is not. */
export type ClaimResult = 'claimed' | 'unknown' | 'used' | 'dropped' | 'expired' | 'other';

/** Where the confirmation that was dropped was waiting. */
interface Dropped {
  readonly investigationId: string;
  readonly sourceId: string;
}

export interface AssistantPendingStore {
  /** Keeps a waiting confirmation of a person, replacing the one they had, and deletes their expired rows first; `replaced` is where the one that was waiting was. */
  add(entry: PendingEntry, now: number): Promise<{ readonly replaced: Dropped | undefined }>;
  /** Claims a waiting confirmation for the person it is bound to: exactly one claim of an id succeeds. An expired row is deleted when it is found. */
  claim(id: string, binding: PendingBinding, now: number): Promise<ClaimResult>;
  /** Drops the person's waiting confirmation, for a new message or a cancel; where it was waiting, or nothing when none was. */
  drop(userId: string, now: number): Promise<Dropped | undefined>;
  close(): Promise<void>;
}

const DELETE_EXPIRED = 'DELETE FROM assistant_pending_confirmations WHERE user_id = $1 AND expires_at <= $2 AND id <> $3';
const DROP_WAITING = "UPDATE assistant_pending_confirmations SET status = 'dropped' WHERE user_id = $1 AND status = 'waiting' RETURNING investigation_id, source_id";
/** Serialises the adds of one person, so two at once replace each other instead of one failing on the one-waiting-row index. */
const LOCK_PERSON = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const droppedOf = (rows: readonly Record<string, unknown>[]): Dropped | undefined => (rows[0] === undefined ? undefined : { investigationId: String(rows[0]['investigation_id']), sourceId: String(rows[0]['source_id']) });
const INSERT_WAITING = "INSERT INTO assistant_pending_confirmations (id, user_id, investigation_id, source_id, mask, status, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, 'waiting', $6, $7)";
const CLAIM =
  "UPDATE assistant_pending_confirmations SET status = 'used' WHERE id = $1 AND user_id = $2 AND investigation_id = $3 AND source_id = $4 AND mask = $5 AND status = 'waiting' AND expires_at > $6 RETURNING id";
const FIND = 'SELECT user_id, investigation_id, source_id, mask, status, expires_at FROM assistant_pending_confirmations WHERE id = $1';
const DELETE_ONE = 'DELETE FROM assistant_pending_confirmations WHERE id = $1';

const at = (ms: number): Date => new Date(ms);

interface Deps {
  readonly createPool: (config: pg.PoolConfig) => ThreadPool;
}

const defaultDeps: Deps = { createPool: (config) => new pg.Pool(config) };

/** Keeps the waiting confirmations through the application's own database login, on a pool of its own. Any failure is the fixed error, so the caller can fail closed. */
export function createPgAssistantPendingStore(context: AuditSinkContext, deps: Deps = defaultDeps): AssistantPendingStore {
  const pool = deps.createPool({
    connectionString: context.databaseUrl,
    max: PENDING_POOL_SIZE,
    ...(context.connectionStream === undefined ? {} : { stream: context.connectionStream }),
    connectionTimeoutMillis: context.connectionTimeoutMs,
    statement_timeout: context.statementTimeoutMs,
    query_timeout: context.queryTimeoutMs,
  });
  pool.on('error', context.onConnectionError);
  let closing: Promise<void> | undefined;

  async function withClient<T>(work: (client: ThreadClient) => Promise<T>): Promise<T> {
    let client: ThreadClient;
    try {
      client = await pool.connect();
    } catch {
      throw new AssistantPendingStoreError();
    }
    try {
      return await work(client);
    } catch {
      throw new AssistantPendingStoreError();
    } finally {
      client.release();
    }
  }

  return {
    add: (entry, now) =>
      withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(LOCK_PERSON, [entry.userId]);
          await client.query(DELETE_EXPIRED, [entry.userId, at(now), entry.id]);
          const dropped = await client.query(DROP_WAITING, [entry.userId]);
          await client.query(INSERT_WAITING, [entry.id, entry.userId, entry.investigationId, entry.sourceId, entry.mask, at(now), at(entry.expiresAtMs)]);
          await client.query('COMMIT');
          return { replaced: droppedOf(dropped.rows) };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }),
    claim: (id, binding, now) =>
      withClient(async (client) => {
        // the row asked for is left for the lookup below, so an expired id is told apart from one never known
        await client.query(DELETE_EXPIRED, [binding.userId, at(now), id]);
        const claimed = await client.query(CLAIM, [id, binding.userId, binding.investigationId, binding.sourceId, binding.mask, at(now)]);
        if ((claimed.rowCount ?? claimed.rows.length) > 0) return 'claimed' as const;
        const found = (await client.query(FIND, [id])).rows[0];
        if (found === undefined) return 'unknown' as const;
        if (found['user_id'] !== binding.userId || found['investigation_id'] !== binding.investigationId || found['source_id'] !== binding.sourceId || found['mask'] !== binding.mask) return 'other' as const;
        if (found['status'] === 'used') return 'used' as const;
        if (found['status'] === 'dropped') return 'dropped' as const;
        await client.query(DELETE_ONE, [id]);
        return 'expired' as const;
      }),
    drop: (userId, now) =>
      withClient(async (client) => {
        // under the lock of the person, so a message and the add of an earlier turn of the same person are decided in one order
        await client.query('BEGIN');
        try {
          await client.query(LOCK_PERSON, [userId]);
          await client.query(DELETE_EXPIRED, [userId, at(now), randomUUID()]);
          const dropped = droppedOf((await client.query(DROP_WAITING, [userId])).rows);
          await client.query('COMMIT');
          return dropped;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }),
    close: () => (closing ??= pool.end()),
  };
}

interface Held extends PendingEntry {
  status: 'waiting' | 'used' | 'dropped';
}

export interface MemoryAssistantPendingStore extends AssistantPendingStore {
  /** The rows by id, for a test to read: what a row holds, and nothing else. */
  readonly rows: Map<string, Held>;
  /** Makes the next calls fail, as an unreachable database does. */
  failing: boolean;
}

/** The same behaviour in memory, for the tests of the routes and for a build with no database. */
export function createMemoryAssistantPendingStore(): MemoryAssistantPendingStore {
  const rows = new Map<string, Held>();
  const store: MemoryAssistantPendingStore = {
    rows,
    failing: false,
    add: (entry, now) => {
      if (store.failing) return Promise.reject(new AssistantPendingStoreError());
      for (const [id, held] of rows) if (held.userId === entry.userId && held.expiresAtMs <= now) rows.delete(id);
      let replaced: Dropped | undefined;
      for (const held of rows.values()) {
        if (held.userId === entry.userId && held.status === 'waiting') {
          held.status = 'dropped';
          replaced = { investigationId: held.investigationId, sourceId: held.sourceId };
        }
      }
      rows.set(entry.id, { ...entry, status: 'waiting' });
      return Promise.resolve({ replaced });
    },
    claim: (id, binding, now) => {
      if (store.failing) return Promise.reject(new AssistantPendingStoreError());
      for (const [heldId, held] of rows) if (heldId !== id && held.userId === binding.userId && held.expiresAtMs <= now) rows.delete(heldId);
      const found = rows.get(id);
      if (found === undefined) return Promise.resolve('unknown');
      if (found.userId !== binding.userId || found.investigationId !== binding.investigationId || found.sourceId !== binding.sourceId || found.mask !== binding.mask) return Promise.resolve('other');
      if (found.status === 'used') return Promise.resolve('used');
      if (found.status === 'dropped') return Promise.resolve('dropped');
      if (found.expiresAtMs <= now) {
        rows.delete(id);
        return Promise.resolve('expired');
      }
      found.status = 'used';
      return Promise.resolve('claimed');
    },
    drop: (userId, now) => {
      if (store.failing) return Promise.reject(new AssistantPendingStoreError());
      for (const [id, held] of rows) if (held.userId === userId && held.expiresAtMs <= now) rows.delete(id);
      let dropped: Dropped | undefined;
      for (const held of rows.values()) {
        if (held.userId === userId && held.status === 'waiting') {
          held.status = 'dropped';
          dropped = { investigationId: held.investigationId, sourceId: held.sourceId };
        }
      }
      return Promise.resolve(dropped);
    },
    close: () => Promise.resolve(),
  };
  return store;
}

export const newPendingId = (): string => randomUUID();
