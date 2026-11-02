import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { serve, type ShutdownTimes, type Signals } from '../serve.js';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { startApi, stopApi, webRoot } from '../testing/start-api.js';
import type { Task } from './tasks.js';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  expect(result.code).toBe(0);
  return database;
}

async function enqueue(database: TestDatabase, task: string, payload: unknown = {}): Promise<void> {
  await rows(database.ownerUrl, 'SELECT graphile_worker.add_job($1, $2::json)', [task, JSON.stringify(payload)]);
}

async function listeners(database: TestDatabase): Promise<number> {
  const found = await rows(database.adminUrl, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1 AND query ILIKE 'LISTEN%'`, [database.appRole]);
  return Number(found[0]?.['n']);
}

async function queued(database: TestDatabase): Promise<readonly Record<string, unknown>[]> {
  return rows(database.ownerUrl, 'SELECT task_identifier, attempts, locked_at IS NOT NULL AS locked, last_error FROM graphile_worker.jobs ORDER BY id');
}

function fakeSignals(): { readonly signals: Signals; readonly emitter: EventEmitter; readonly exits: number[] } {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  return {
    emitter,
    exits,
    signals: {
      once: (signal, listener) => emitter.once(signal, listener),
      exit: (code) => {
        exits.push(code);
      },
    },
  };
}

function task(name: string, run: Task['run'], schedule?: string): Task {
  return { name, run, ...(schedule === undefined ? {} : { schedule }) };
}

const WAIT = { timeout: 30_000, interval: 100 };

describe('the job runner of the API', () => {
  it('runs a registered task for a queued job, with its payload, while a session listens on the queue', async () => {
    const database = await migrated();
    const received: unknown[] = [];
    const { result } = await startApi({ DATABASE_URL: database.appUrl }, undefined, { tasks: [task('record', (payload) => Promise.resolve(void received.push(payload)))] });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      // the queue session opens after the runner has started; a job queued before it exists is found by the next poll
      await vi.waitFor(async () => expect(await listeners(database)).toBeGreaterThan(0), WAIT);
      await enqueue(database, 'record', { n: 7 });
      await vi.waitFor(() => expect(received).toEqual([{ n: 7 }]), WAIT);
    } finally {
      await stopApi(result);
    }
  });

  it('starts, serves and opens no queue session when no task is registered', async () => {
    const database = await migrated();
    const { result } = await startApi({ DATABASE_URL: database.appUrl }, undefined, { tasks: [] });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      expect((await result.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect(await listeners(database)).toBe(0);
    } finally {
      await stopApi(result);
    }
  });

  it('lets a running task finish when the API is stopped, within the shutdown limit, and leaves no job locked', async () => {
    const database = await migrated();
    const events: string[] = [];
    const slow = task('slow', async () => {
      events.push('started');
      await sleep(1000);
      events.push('finished');
    });
    const run = fakeSignals();
    const started = await serve({ DATABASE_URL: database.appUrl, NEBURYX_WEB_ROOT: webRoot }, optionsWith([slow]), run.signals);
    expect(started.exitCode).toBe(0);
    await enqueue(database, 'slow');
    await vi.waitFor(() => expect(events).toEqual(['started']), WAIT);
    run.emitter.emit('SIGTERM');
    await vi.waitFor(() => expect(run.exits).toEqual([0]), { timeout: 4000, interval: 50 });
    expect(events).toEqual(['started', 'finished']);
    expect(await queued(database)).toEqual([]);
  });

  it('exits 1 at the shutdown limit when a task is still running, keeps its job locked and not lost, and lets a new API start', async () => {
    const database = await migrated();
    const events: string[] = [];
    const endless = task('endless', async () => {
      events.push('started');
      await sleep(3000);
      events.push('finished');
    });
    const run = fakeSignals();
    const times: ShutdownTimes = { graceMs: 50, deadlineMs: 500 };
    const first = await serve({ DATABASE_URL: database.appUrl, NEBURYX_WEB_ROOT: webRoot }, optionsWith([endless]), run.signals, times);
    expect(first.exitCode).toBe(0);
    await enqueue(database, 'endless');
    await vi.waitFor(() => expect(events).toEqual(['started']), WAIT);
    run.emitter.emit('SIGTERM');
    await vi.waitFor(() => expect(run.exits).toEqual([1]), { timeout: 3000, interval: 50 });
    expect(await queued(database)).toMatchObject([{ task_identifier: 'endless', locked: true }]);

    const sessionsBefore = await listeners(database);
    const second = await startApi({ DATABASE_URL: database.appUrl }, undefined, { tasks: [endless] });
    expect(second.result.exitCode).toBe(0);
    await vi.waitFor(async () => expect(await listeners(database)).toBeGreaterThan(sessionsBefore), WAIT);
    expect(await queued(database)).toMatchObject([{ task_identifier: 'endless', locked: true }]);
    expect(events).toEqual(['started']);
    await stopApi(second.result);
    if (first.exitCode === 0) await first.app.close();
  });

  it('leaves a job queued after the API has stopped', async () => {
    const database = await migrated();
    const ran: string[] = [];
    const { result } = await startApi({ DATABASE_URL: database.appUrl }, undefined, { tasks: [task('later', () => Promise.resolve(void ran.push('ran')))] });
    await stopApi(result);
    await enqueue(database, 'later');
    await sleep(2500);
    expect(ran).toEqual([]);
    expect(await queued(database)).toMatchObject([{ task_identifier: 'later', locked: false }]);
  });

  it('exits 1 and runs nothing when the database cannot be reached', async () => {
    const ran: string[] = [];
    const { result, stderr } = await startApi({ DATABASE_URL: 'postgres://app:secret@127.0.0.1:1/neburyx' }, undefined, {
      tasks: [task('never', () => Promise.resolve(void ran.push('ran')))],
    });
    expect(result.exitCode).toBe(1);
    expect(stderr).toBe('the database could not be reached\n');
    expect(ran).toEqual([]);
  });
});

describe('a task that fails', () => {
  const PAYLOAD_SENTINEL = 'payload-sentinel-4f2a';
  const ERROR_SENTINEL = 'error-sentinel-9c1d';

  it('leaves the API serving, keeps the job for retry, and logs only the task name', async () => {
    const database = await migrated();
    const lines: string[] = [];
    const explode = task('explode', () => Promise.reject(new Error(`boom ${ERROR_SENTINEL}`)));
    const { result } = await startApi({ DATABASE_URL: database.appUrl }, undefined, {
      tasks: [explode],
      logger: createLogger({ write: (chunk: string) => lines.push(chunk) }),
    });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      await enqueue(database, 'explode', { secret: PAYLOAD_SENTINEL });
      await vi.waitFor(async () => {
        const [job] = await queued(database);
        expect(job).toMatchObject({ task_identifier: 'explode', attempts: 1, locked: false });
        expect(typeof job?.['last_error']).toBe('string');
      }, WAIT);
      expect((await result.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      const log = lines.join('');
      expect(log).toContain('"event":"job.failed"');
      expect(log).toContain('"task":"explode"');
      expect(log).not.toContain(PAYLOAD_SENTINEL);
      expect(log).not.toContain(ERROR_SENTINEL);
    } finally {
      await stopApi(result);
    }
  });

  it('writes no payload to the log when a task succeeds', async () => {
    const database = await migrated();
    const lines: string[] = [];
    const ran: unknown[] = [];
    const fine = task('fine', (payload) => Promise.resolve(void ran.push(payload)));
    const { result } = await startApi({ DATABASE_URL: database.appUrl }, undefined, {
      tasks: [fine],
      logger: createLogger({ write: (chunk: string) => lines.push(chunk) }),
    });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      await enqueue(database, 'fine', { secret: PAYLOAD_SENTINEL });
      await vi.waitFor(() => expect(ran).toHaveLength(1), WAIT);
      expect(lines.join('')).not.toContain(PAYLOAD_SENTINEL);
    } finally {
      await stopApi(result);
    }
  });
});

describe('a scheduled task', () => {
  it('runs once in the next minute even with two API copies on the same database', { timeout: 150_000 }, async () => {
    const database = await migrated();
    const runs: string[] = [];
    const tick = task('tick', () => Promise.resolve(void runs.push(new Date().toISOString())), '* * * * *');
    const first = await startApi({ DATABASE_URL: database.appUrl }, undefined, { tasks: [tick] });
    const second = await startApi({ DATABASE_URL: database.appUrl }, undefined, { tasks: [tick] });
    try {
      await vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(1), { timeout: 100_000, interval: 500 });
      await sleep(8000);
      expect(runs).toHaveLength(1);
    } finally {
      await stopApi(first.result);
      await stopApi(second.result);
    }
  });
});

function optionsWith(tasks: readonly Task[]): Parameters<typeof serve>[1] {
  return {
    stderr: { write: () => true },
    logger: createLogger({ write: () => undefined }),
    defaultWebRoot: webRoot,
    portOverride: 0,
    tasks,
  };
}
