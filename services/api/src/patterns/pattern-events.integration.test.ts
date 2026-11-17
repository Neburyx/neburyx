import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { errorResponse, errorStatus } from '../errors.js';
import { createEventQueue } from '../audit/queue.js';
import { rows, testPool } from '../testing/database.js';
import { seededDatabase, type SeededDatabase } from '../testing/pattern-events-rig.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { communityAudit } from '../seams/community-seams.js';
import type { Principal } from '../seams/seams.js';
import { inPatternTransaction, insertPatternEvent, PATTERN_EVENT_ACTIONS, readPatternEvents, type PatternEvent, type PatternHistory } from './pattern-events.js';

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
  const pool = testPool(seeded.database.appUrl);
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

/** The history as the application hands it by default: each event is written at once, and one that cannot be written is dropped. */
function directHistory(pool: pg.Pool): PatternHistory {
  return { record: (event) => insertPatternEvent(pool, event).catch(() => undefined) };
}

describe('the pattern event writer', () => {
  it('inserts one row for a listed action, with the database time, readable after the commit', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const patternId = randomUUID();
    await insertPatternEvent(pool, { id: randomUUID(), sourceId: seeded.sourceId, patternId, actorId: seeded.actorId, action: 'saved', version: 1 });
    const stored = await readPatternEvents(pool, { patternId });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ sourceId: seeded.sourceId, patternId, actorId: seeded.actorId, action: 'saved', version: 1 });
    expect(Date.now() - Date.parse(stored[0]?.createdAt ?? '')).toBeLessThan(60_000);
  });

  it('writes one row however many times the same event is inserted, as a retry of an insert that was committed but not acknowledged does', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const event: PatternEvent = { id: randomUUID(), sourceId: seeded.sourceId, patternId: randomUUID(), actorId: seeded.actorId, action: 'changed', version: 2 };
    await insertPatternEvent(pool, event);
    await insertPatternEvent(pool, event);
    await insertPatternEvent(pool, event);
    expect(await readPatternEvents(pool, { patternId: event.patternId })).toHaveLength(1);
  });

  it('throws a TypeError for an action outside the list before any SQL is sent, and names no value', async () => {
    const queries: string[] = [];
    const pool = { query: (text: string) => { queries.push(text); return Promise.resolve({ rows: [] }); } } as unknown as pg.Pool;
    for (const action of ['', 'Saved', 'SAVED', 'copy', 'secret-value-here']) {
      const failure = await insertPatternEvent(pool, { id: 'i', sourceId: 's', patternId: 'p', actorId: 'a', action: action as never, version: 1 }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).not.toContain(action === '' ? '\u0000' : action);
    }
    expect(queries).toEqual([]);
    expect(PATTERN_EVENT_ACTIONS).toEqual(['saved', 'changed', 'shared', 'unshared', 'copied', 'deleted']);
  });

  it('rejects the insert of an event of an unknown source and leaves nothing, for the writer that retries to count', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const patternId = randomUUID();
    await expect(insertPatternEvent(pool, { id: randomUUID(), sourceId: 'nowhere', patternId, actorId: seeded.actorId, action: 'saved', version: 1 })).rejects.toThrow();
    expect(await readPatternEvents(pool, { patternId })).toEqual([]);
  });

  it('answers 503 AUDIT_UNAVAILABLE with a body that holds none of the event', () => {
    const body = errorResponse('AUDIT_UNAVAILABLE', 'trace-1');
    expect(JSON.stringify(body)).not.toMatch(/alpha|pattern/);
    expect(body).toMatchObject({ error: { code: 'AUDIT_UNAVAILABLE' } });
    expect(errorStatus('AUDIT_UNAVAILABLE')).toBe(503);
  });
});

describe('the deadline of a history write', () => {
  it('is enforced by the server: a write blocked past it fails, nothing is left of it, and the next event is written once the block is gone', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const blocker = new pg.Client({ connectionString: seeded.database.ownerUrl });
    await blocker.connect();
    const first: PatternEvent = { id: randomUUID(), sourceId: seeded.sourceId, patternId: randomUUID(), actorId: seeded.actorId, action: 'saved', version: 1 };
    const second: PatternEvent = { ...first, id: randomUUID(), action: 'changed', version: 2 };
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE pattern_events IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await expect(insertPatternEvent(pool, first, 300)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
    await insertPatternEvent(pool, second, 300);
    expect((await readPatternEvents(pool, { patternId: first.patternId })).map((event) => event.action)).toEqual(['changed']);
  });
});

describe('the pattern transaction helper', () => {
  it('hands one event to the history and to the sink once, after the commit, with the mapped code and no detail', async () => {
    const seeded = await seededDatabase(postgres);
    await withStandIn(seeded);
    const pool = poolOn(seeded);
    const observer = poolOn(seeded);
    const recording = recordingSink(observer);
    const patternId = randomUUID();
    const result = await inPatternTransaction({ pool, audit: recording.sink, history: directHistory(pool), newId: randomUUID }, { principal: principalOf(seeded), traceId: 'trace-7' }, async (transaction) => {
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
    expect(await readPatternEvents(pool, { patternId })).toHaveLength(1);
  });

  it('hands two events over in the order recorded, once each, and reads them back in that order', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const recording = recordingSink();
    const patternId = randomUUID();
    await inPatternTransaction({ pool, audit: recording.sink, history: directHistory(pool), newId: randomUUID }, { principal: principalOf(seeded), traceId: 't' }, async (transaction) => {
      await transaction.record({ sourceId: seeded.sourceId, patternId, action: 'saved', version: 1 });
      await transaction.record({ sourceId: seeded.sourceId, patternId, action: 'shared', version: 1 });
    });
    expect(recording.events.map((event) => event.action)).toEqual(['pattern.save', 'pattern.share']);
    expect((await readPatternEvents(pool, { patternId })).map((event) => event.action)).toEqual(['saved', 'shared']);
  });

  it('hands nothing over when the work throws, and leaves no row', async () => {
    const seeded = await seededDatabase(postgres);
    await withStandIn(seeded);
    const pool = poolOn(seeded);
    const recording = recordingSink();
    const deps = { pool, audit: recording.sink, history: directHistory(pool), newId: randomUUID };
    const failedWork = await inPatternTransaction(deps, { principal: principalOf(seeded), traceId: 't' }, async (transaction) => {
      await transaction.client.query(`INSERT INTO stand_in (note) VALUES ('change')`);
      await transaction.record({ sourceId: seeded.sourceId, patternId: randomUUID(), action: 'saved', version: 1 });
      throw new Error('the work failed');
    }).catch((error: unknown) => error);
    expect((failedWork as Error).message).toBe('the work failed');
    expect(recording.events).toEqual([]);
    expect(await readPatternEvents(pool, { sourceId: seeded.sourceId })).toEqual([]);
    expect(await standInRows(seeded)).toBe(0);
  });

  it('refuses the change, with nothing handed over, when the work catches a failed statement of its own', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const recording = recordingSink();
    const failure = await inPatternTransaction({ pool, audit: recording.sink, history: directHistory(pool), newId: randomUUID }, { principal: principalOf(seeded), traceId: 't' }, async (transaction) => {
      await transaction.record({ sourceId: seeded.sourceId, patternId: randomUUID(), action: 'saved', version: 1 });
      await transaction.client.query('SELECT * FROM a_table_that_is_not_there').catch(() => undefined);
      return 'looks fine';
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(recording.events).toEqual([]);
    expect(await readPatternEvents(pool, { sourceId: seeded.sourceId })).toEqual([]);
  });

  it('keeps the committed change and still hands the sink event over when the history store cannot take the event, and counts the failure', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    await withStandIn(seeded);
    const recording = recordingSink();
    const lines: Record<string, unknown>[] = [];
    const history = createEventQueue<PatternEvent>({
      sinks: [{ name: 'pattern-history', sink: { record: () => Promise.reject(new Error('the history store is down, secret')) } }],
      idFields: (event) => ({ action: event.action, actorId: event.actorId, sourceId: event.sourceId }),
      settings: { queueSize: 10, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 },
      logger: { warn: (fields) => void lines.push(fields) },
    });
    const result = await inPatternTransaction({ pool, audit: recording.sink, history: history.sink, newId: randomUUID }, { principal: principalOf(seeded), traceId: 't' }, async (transaction) => {
      await transaction.client.query(`INSERT INTO stand_in (note) VALUES ('change')`);
      await transaction.record({ sourceId: seeded.sourceId, patternId: randomUUID(), action: 'saved', version: 1 });
      return 'committed';
    });
    expect(result).toBe('committed');
    expect(await standInRows(seeded)).toBe(1);
    expect(recording.events.map((event) => event.action)).toEqual(['pattern.save']);
    await vi.waitFor(() => expect(history.counts().failed).toBe(1));
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  it('with the Community sink returns the work result, and the row is readable from another connection', async () => {
    const seeded = await seededDatabase(postgres);
    const pool = poolOn(seeded);
    const patternId = randomUUID();
    const result = await inPatternTransaction({ pool, audit: communityAudit, history: directHistory(pool), newId: randomUUID }, { principal: principalOf(seeded), traceId: 't' }, async (transaction) => {
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
      inPatternTransaction({ pool, audit: communityAudit, history: directHistory(pool), newId: randomUUID }, { principal: principalOf(seeded), traceId: 't' }, (transaction) => transaction.record({ sourceId, patternId, action, version }));
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
