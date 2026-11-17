// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { classify } from './errors.js';

// the driver's own texts, as neo4j-driver 6.3.0 writes them when the wait for a connection runs out
const NOTHING_CONNECTED = 'Connection acquisition timed out in 2000 ms. Pool status: Active conn count = 0, Idle conn count = 0.';
const IN_USE = 'Connection acquisition timed out in 2000 ms. Pool status: Active conn count = 32, Idle conn count = 0.';

describe('the wait for a connection that ran out', () => {
  it('is a connection that could not be made in time, not a full pool, when no connection is active or idle', () => {
    expect(classify(new Error(NOTHING_CONNECTED))).toBe('unreachable');
  });

  it('is a full pool when connections are in use', () => {
    expect(classify(new Error(IN_USE))).toBe('pool-full');
    expect(classify(new Error('Connection acquisition timed out in 2000 ms. Pool status: Active conn count = 1, Idle conn count = 0.'))).toBe('pool-full');
  });

  it('is a full pool when an idle connection exists, whatever the active count', () => {
    expect(classify(new Error('Connection acquisition timed out in 2000 ms. Pool status: Active conn count = 0, Idle conn count = 3.'))).toBe('pool-full');
  });

  it('stays a full pool when the text has no pool status, or one this reading does not understand (another driver version)', () => {
    expect(classify(new Error('Connection acquisition timed out in 2000 ms.'))).toBe('pool-full');
    expect(classify(new Error('Connection acquisition timed out in 2000 ms. Pool status: Active conn count = zero, Idle conn count = 0.'))).toBe('pool-full');
    expect(classify(new Error('Connection acquisition timed out after 2 s; pool: 0 active, 0 idle'))).toBe('pool-full');
  });

  it('reads the text the installed driver builds: its source still has the wording this reading relies on', () => {
    const fromDriver = createRequire(createRequire(import.meta.url).resolve('neo4j-driver'));
    const pool = readFileSync(fromDriver.resolve('neo4j-driver-core/lib/internal/pool/pool.js'), 'utf8');
    expect(pool).toContain('Connection acquisition timed out in ');
    expect(pool).toContain(' ms. Pool status: Active conn count = ');
    expect(pool).toContain(', Idle conn count = ');
  });
});
