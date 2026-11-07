import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { readLibrary } from './investigations-repository.js';

function fakePool(failing: readonly string[] = []) {
  const statements: string[] = [];
  const released: unknown[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (failing.some((prefix) => sql.startsWith(prefix))) throw new Error(`${sql} failed`);
      return { rows: [] };
    },
    release: (destroy?: boolean) => void released.push(destroy),
  };
  // a pool is only asked for a connection here, and a real one cannot be made to fail a rollback on demand
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, statements, released };
}

describe('the reads of one list call', () => {
  it('runs them in one repeatable-read read-only transaction, commits, and releases the connection once for reuse', async () => {
    const { pool, statements, released } = fakePool();
    await expect(readLibrary(pool, async () => 'answer')).resolves.toBe('answer');
    expect(statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT']);
    expect(released).toEqual([false]);
  });

  it('rolls back, rethrows the error of the read and releases the connection once for reuse when a read fails', async () => {
    const { pool, statements, released } = fakePool();
    const failure = new Error('the read failed');
    await expect(readLibrary(pool, async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
    expect(released).toEqual([false]);
  });

  it('destroys the connection, once, and still reports the error of the read when the rollback fails', async () => {
    const { pool, released } = fakePool(['ROLLBACK']);
    const failure = new Error('the read failed');
    await expect(readLibrary(pool, async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(released).toEqual([true]);
  });

  it('releases the connection once and reports the error when the transaction cannot start', async () => {
    const { pool, released } = fakePool(['BEGIN']);
    await expect(readLibrary(pool, async () => 'never')).rejects.toThrow('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY failed');
    expect(released).toHaveLength(1);
  });

  it('rolls back and reports the error when the commit fails', async () => {
    const { pool, statements, released } = fakePool(['COMMIT']);
    await expect(readLibrary(pool, async () => 'answer')).rejects.toThrow('COMMIT failed');
    expect(statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK']);
    expect(released).toEqual([false]);
  });
});
