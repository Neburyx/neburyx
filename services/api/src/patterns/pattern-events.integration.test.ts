import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { AppError, errorResponse } from '../errors.js';
import { rows } from '../testing/database.js';
import { seededDatabase, type SeededDatabase } from '../testing/pattern-events-rig.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { communityAudit } from '../seams/community-seams.js';
import type { Principal } from '../seams/seams.js';
import { inPatternTransaction, PATTERN_EVENT_ACTIONS, readPatternEvents, recordPatternEvent } from './pattern-events.js';

let postgres: TestPostgres;
const pools: pg.Pool[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await postgres.stop();
});

function poolOn(seeded: SeededDatabase): pg.Pool {
  const pool = new pg.Pool({ connectionString: seeded.database.appUrl });
  pools.push(pool);
  return pool;
}

function principalOf(seeded: SeededDatabase): Principal {
  return { id: seeded.actorId, role: 'administrator' } as Principal;
}

async function withStandIn(seeded: SeededDatabase): Promise<void> {
  await rows(seeded.database.ownerUrl, `CREATE TABLE stand_in (note text)`);
}

async function standInRows(seeded: SeededDatabase): Promise<number> {
  return (await rows(seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM stand_in`))[0]?.['n'] as number;
}

function recordingSink(visibleTo?: pg.Pool): { readonly sink: AuditSink; readonly events: AuditEvent[]; readonly seen: number[] } {
  const events: AuditEvent[] = [];
  const seen: number[] = [];
  const sink: AuditSink = {
    async record(event) {
      events.push(event);
      if (visibleTo !== undefined) seen.push(Number((await visibleTo.query('SELECT count(*)::int AS n FROM pattern_events')).rows[0].n));
    },
  };
  return { sink, events, seen };
}

describe('the pattern event writer', () => {
  it('inserts one row for a listed action, with the database time, readable after the commit', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const patternId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recordPatternEvent(client, { id: randomUUID(), sourceId: seeded.sourceId, patternId, actorId: seeded.actorId, action: 'saved', version: 1 });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const stored = await readPatternEvents(pool, { patternId });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ sourceId: seeded.sourceId, patternId, actorId: seeded.actorId, action: 'saved', version: 1 });
    expect(Date.now() - Date.parse(stored[0]?.createdAt ?? '')).toBeLessThan(60_000);
  });

  it('throws a TypeError for an action outside the list before any SQL is sent, and names no value', async () => {
    const queries: string[] = [];
    const client = { query: (text: string) => { queries.push(text); return Promise.resolve({ rows: [] }); } } as unknown as pg.PoolClient;
    for (const action of ['', 'Saved', 'SAVED', 'copy', 'secret-value-here']) {
      const failure = await recordPatternEvent(client, { id: 'i', sourceId: 's', patternId: 'p', actorId: 'a', action: action as never, version: 1 }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).not.toContain(action === '' ? '\u0000' : action);
    }
    expect(queries).toEqual([]);
    expect(PATTERN_EVENT_ACTIONS).toEqual(['saved', 'changed', 'shared', 'unshared', 'copied', 'deleted']);
  });

  it('fails closed with AUDIT_UNAVAILABLE and rolls the surrounding change back, for an unknown source and for a client that rejects', async () => {
    const seeded = await seededDatabase(postgres);
    await withStandIn(seeded);
    const pool = poolOn(seeded);
    const refused = await inPatternTransaction({ pool, audit: communityAudit, newId: randomUUID }, { principal: principalOf(seeded), traceId: 't' }, async (transaction) => {
      await transaction.client.query(`INSERT INTO stand_in (note) VALUES ('change')`);
      await transaction.record({ sourceId: 'nowhere', patternId: randomUUID(), action: 'saved', version: 1 });
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({ code: 'AUDIT_UNAVAILABLE', details: undefined });
    expect(await standInRows(seeded)).toBe(0);

    const broken = { query: () => Promise.reject(new Error('the connection dropped, secret')) } as unknown as pg.PoolClient;
    const second = await recordPatternEvent(broken, { id: randomUUID(), sourceId: 'alpha', patternId: randomUUID(), actorId: seeded.actorId, action: 'saved', version: 1 }).catch((error: unknown) => error);
    expect(second).toMatchObject({ code: 'AUDIT_UNAVAILABLE', details: undefined });
    expect((second as Error).message).not.toContain('secret');
  });

  it('answers 503 AUDIT_UNAVAILABLE with a body that holds none of the event', () => {
    const body = errorResponse('AUDIT_UNAVAILABLE', 'trace-1');
    expect(JSON.stringify(body)).not.toMatch(/alpha|pattern/);
    expect(body).toMatchObject({ error: { code: 'AUDIT_UNAVAILABLE' } });
  });
});

describe('the pattern transaction helper', () => {
  it('passes one event to the sink once, after the commit, with the mapped code and no detail', async () => {
    const seeded = await seededDatabase(postgres);
    await withStandIn(seeded);
    const pool = poolOn(seeded);
    const observer = poolOn(seeded);
    const recording = recordingSink(observer);
    const patternId = randomUUID();
    const result = await inPatternTransaction({ pool, audit: recording.sink, newId: randomUUID }, { principal: principalOf(seeded), traceId: 'trace-7' }, async (transaction) => {
      await transaction.client.query(`INSERT INTO stand_in (note) VALUES ('change')`);
      await transaction.record({ sourceId: seeded.sourceId, patternId, action: 'saved', version: 1 });
      return 'done';
    });
    expect(result).toBe('done');
    expect(recording.events).toEqual([
      { actorId: seeded.actorId, actorRole: 'administrator', action: 'pattern.save', result: 'success', sourceId: seeded.sourceId, resourceType: 'pattern', resourceRef: patternId, traceId: 'trace-7' },
    ]);
    expect(recording.events[0]).not.toHaveProperty('detail');
    expect(recording.seen).toEqual([1]);
  });

  it('passes two events in the order recorded, once each, and reads them back in that order', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const recording = recordingSink();
    const patternId = randomUUID();
    await inPatternTransaction({ pool, audit: recording.sink, newId: randomUUID }, { principal: principalOf(seeded), traceId: 't' }, async (transaction) => {
      await transaction.record({ sourceId: seeded.sourceId, patternId, action: 'saved', version: 1 });
      await transaction.record({ sourceId: seeded.sourceId, patternId, action: 'shared', version: 1 });
    });
    expect(recording.events.map((event) => event.action)).toEqual(['pattern.save', 'pattern.share']);
    expect((await readPatternEvents(pool, { patternId })).map((event) => event.action)).toEqual(['saved', 'shared']);
  });

  it('makes no sink call when the event write fails or the work throws afterwards, and leaves no row', async () => {
    const seeded = await seededDatabase(postgres);
    await withStandIn(seeded);
    const pool = poolOn(seeded);
    const recording = recordingSink();
    const deps = { pool, audit: recording.sink, newId: randomUUID };
    const context = { principal: principalOf(seeded), traceId: 't' };
    const failedWrite = await inPatternTransaction(deps, context, async (transaction) => {
      await transaction.record({ sourceId: 'nowhere', patternId: randomUUID(), action: 'deleted', version: 1 });
    }).catch((error: unknown) => error);
    expect(failedWrite).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    const failedWork = await inPatternTransaction(deps, context, async (transaction) => {
      await transaction.client.query(`INSERT INTO stand_in (note) VALUES ('change')`);
      await transaction.record({ sourceId: seeded.sourceId, patternId: randomUUID(), action: 'saved', version: 1 });
      throw new Error('the work failed');
    }).catch((error: unknown) => error);
    expect((failedWork as Error).message).toBe('the work failed');
    expect(recording.events).toEqual([]);
    expect(await readPatternEvents(pool, { sourceId: seeded.sourceId })).toEqual([]);
    expect(await standInRows(seeded)).toBe(0);
  });

  it('keeps the rows and passes every event on when the sink rejects, then throws INTERNAL_ERROR with no details', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const calls: string[] = [];
    const sink: AuditSink = { record: (event) => { calls.push(event.action); return Promise.reject(new Error('sink down, secret')); } };
    const failure = await inPatternTransaction({ pool, audit: sink, newId: randomUUID }, { principal: principalOf(seeded), traceId: 't' }, async (transaction) => {
      await transaction.record({ sourceId: seeded.sourceId, patternId: randomUUID(), action: 'saved', version: 1 });
      await transaction.record({ sourceId: seeded.sourceId, patternId: randomUUID(), action: 'deleted', version: 2 });
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR', details: undefined });
    expect(calls).toEqual(['pattern.save', 'pattern.delete']);
    expect(await readPatternEvents(pool, { sourceId: seeded.sourceId })).toHaveLength(2);
  });

  it('with the Community sink returns the work result, and the row is readable from another connection', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const patternId = randomUUID();
    const result = await inPatternTransaction({ pool, audit: communityAudit, newId: randomUUID }, { principal: principalOf(seeded), traceId: 't' }, async (transaction) => {
      await transaction.record({ sourceId: seeded.sourceId, patternId, action: 'copied', version: 1 });
      return 42;
    });
    expect(result).toBe(42);
    expect(await readPatternEvents(poolOn(seeded), { patternId })).toHaveLength(1);
  });
});

describe('reading the trail', () => {
  it('returns each pattern and each source its own rows, oldest first, with the seven fields only, and refuses an unfiltered read', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const [first, second] = [randomUUID(), randomUUID()];
    const run = (sourceId: string, patternId: string, action: 'saved' | 'changed', version: number) =>
      inPatternTransaction({ pool, audit: communityAudit, newId: randomUUID }, { principal: principalOf(seeded), traceId: 't' }, (transaction) => transaction.record({ sourceId, patternId, action, version }));
    await run(seeded.sourceId, first, 'saved', 1);
    await run(seeded.otherSourceId, second, 'saved', 1);
    await run(seeded.sourceId, first, 'changed', 2);
    const ofFirst = await readPatternEvents(pool, { patternId: first });
    expect(ofFirst.map((event) => [event.action, event.version])).toEqual([['saved', 1], ['changed', 2]]);
    expect(Object.keys(ofFirst[0] ?? {}).sort()).toEqual(['action', 'actorId', 'createdAt', 'id', 'patternId', 'sourceId', 'version']);
    expect((await readPatternEvents(pool, { sourceId: seeded.otherSourceId })).map((event) => event.patternId)).toEqual([second]);
    expect((await readPatternEvents(pool, { sourceId: seeded.sourceId })).map((event) => event.patternId)).toEqual([first, first]);
    await expect(readPatternEvents(pool, {})).rejects.toBeInstanceOf(TypeError);
  });
});
