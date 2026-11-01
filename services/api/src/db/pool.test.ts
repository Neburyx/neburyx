import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPool } from './pool.js';

describe('createPool', () => {
  it('reports an error on an idle connection instead of letting it escape', async () => {
    let reports = 0;
    const pool = createPool('postgres://app@127.0.0.1:1/neburyx', () => (reports += 1));
    expect(() => pool.emit('error', new Error('idle client lost'))).not.toThrow();
    expect(reports).toBe(1);
    await pool.end();
  });

  it('reports an error on a connection that is checked out instead of letting it escape', async () => {
    let reports = 0;
    const pool = createPool('postgres://app@127.0.0.1:1/neburyx', () => (reports += 1));
    const client = new EventEmitter();
    pool.emit('connect', client);
    expect(() => client.emit('error', new Error('connection lost mid-query'))).not.toThrow();
    expect(reports).toBe(1);
    await pool.end();
  });
});
