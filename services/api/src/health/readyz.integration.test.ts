import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../testing/cli.js';
import { rows, runInProcess } from '../testing/database.js';
import { forwardTo, type Forwarder } from '../testing/forwarder.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { startApi, stopApi, webRoot } from '../testing/start-api.js';

const WITHIN_MS = 3000;
const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const scratch: string[] = [];

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
  for (const folder of scratch) rmSync(folder, { recursive: true, force: true });
});

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  expect(result.code).toBe(0);
  return database;
}

interface Running {
  readonly database: TestDatabase;
  readonly forwarder: Forwarder;
  readonly secrets: readonly string[];
  readonly call: (url: string) => Promise<{ readonly status: number; readonly body: string; readonly tookMs: number }>;
  readonly stop: () => Promise<void>;
}

async function running(options: { readonly database?: TestDatabase; readonly migrations?: string } = {}): Promise<Running> {
  const database = options.database ?? (await migrated());
  const forwarder = await forwardTo(database.appUrl);
  const { result } = await startApi({ DATABASE_URL: forwarder.url }, options.migrations);
  if (result.exitCode !== 0) throw new Error('the API did not start');
  const upstream = new URL(database.appUrl);
  const via = new URL(forwarder.url);
  return {
    database,
    forwarder,
    secrets: [database.appRole, 'app-password', upstream.port, via.port, upstream.hostname, via.hostname, 'postgres://'],
    async call(url) {
      const started = Date.now();
      const response = await result.app.inject({ method: 'GET', url });
      return { status: response.statusCode, body: response.body, tookMs: Date.now() - started };
    },
    async stop() {
      await stopApi(result);
      await forwarder.stop();
    },
  };
}

function expectNoSecrets(secrets: readonly string[], ...bodies: readonly string[]): void {
  for (const body of bodies) {
    for (const secret of secrets) expect(body).not.toContain(secret);
  }
}

describe('GET /readyz when replies stop on a connection that is already open', () => {
  it('answers 503 within three seconds each time, keeps the migrations unknown after a good ping, closes promptly, and recovers', async () => {
    const api = await running();
    try {
      expect((await api.call('/readyz')).status).toBe(200);
      api.forwarder.muteReplies();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const muted = await api.call('/readyz');
        expect(muted.status).toBe(503);
        expect(muted.tookMs).toBeLessThan(WITHIN_MS);
        expect(JSON.parse(muted.body).status).toBe('not_ready');
      }
      await api.forwarder.resume();
      const back = await api.call('/readyz');
      expect(back.status).toBe(200);
      expect(JSON.parse(back.body).checks).toEqual({ database: 'ok', migrations: 'ok' });
    } finally {
      const closing = Date.now();
      await api.stop();
      expect(Date.now() - closing).toBeLessThan(WITHIN_MS);
    }
  });
});

describe('closing the API while a probe is stuck on an open connection', () => {
  it('finishes within three seconds because the stuck query is given up', async () => {
    const api = await running();
    try {
      expect((await api.call('/readyz')).status).toBe(200);
      api.forwarder.muteReplies();
      expect((await api.call('/readyz')).status).toBe(503);
    } finally {
      const closing = Date.now();
      await api.stop();
      expect(Date.now() - closing).toBeLessThan(WITHIN_MS);
    }
  });
});

describe('GET /readyz against a real Postgres', () => {
  it('answers 200 ready while Postgres is reachable', async () => {
    const api = await running();
    try {
      const ready = await api.call('/readyz');
      expect(ready.status).toBe(200);
      expect(JSON.parse(ready.body)).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } });
      expectNoSecrets(api.secrets, ready.body, (await api.call('/healthz')).body);
    } finally {
      await api.stop();
    }
  });

  it('answers 503 unreachable within three seconds once Postgres stops accepting connections, keeps /healthz at 200, and recovers', async () => {
    const api = await running();
    try {
      await api.forwarder.stop();
      const down = await api.call('/readyz');
      expect(down.status).toBe(503);
      expect(down.tookMs).toBeLessThan(WITHIN_MS);
      expect(JSON.parse(down.body)).toEqual({ status: 'not_ready', checks: { database: 'unreachable', migrations: 'unknown' } });
      const alive = await api.call('/healthz');
      expect(alive.status).toBe(200);
      expectNoSecrets(api.secrets, down.body, alive.body);

      await api.forwarder.resume();
      const back = await api.call('/readyz');
      expect(back.status).toBe(200);
      expect(JSON.parse(back.body)).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } });
    } finally {
      await api.stop();
    }
  });

  it('answers 503 unreachable within three seconds, three times in a row, while Postgres accepts connections and never answers, then recovers', async () => {
    const api = await running();
    try {
      await api.forwarder.stall();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const stalled = await api.call('/readyz');
        expect(stalled.status).toBe(503);
        expect(stalled.tookMs).toBeLessThan(WITHIN_MS);
        expect(JSON.parse(stalled.body)).toEqual({ status: 'not_ready', checks: { database: 'unreachable', migrations: 'unknown' } });
        expectNoSecrets(api.secrets, stalled.body);
      }
      await api.forwarder.resume();
      expect((await api.call('/readyz')).status).toBe(200);
    } finally {
      await api.stop();
    }
  });
});

function folderWith(files: readonly string[], extra: Readonly<Record<string, string>> = {}): string {
  const folder = mkdtempSync(join(tmpdir(), 'readyz-migrations-'));
  scratch.push(folder);
  for (const file of files) cpSync(join(SHIPPED, file), join(folder, file));
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(folder, name), text);
  return folder;
}

const ALL = ['0001-baseline.sql', '0002-deployment-and-users.sql', '0003-applied-migrations-function.sql'];

describe('the migrations check of /readyz', () => {
  it('is ok when every shipped migration is applied, and no body names a migration or leaks a secret', async () => {
    const api = await running();
    try {
      const ready = await api.call('/readyz');
      expect(ready.status).toBe(200);
      expect(JSON.parse(ready.body).checks).toEqual({ database: 'ok', migrations: 'ok' });
      expectNoSecrets([...api.secrets, '0001-baseline', 'kysely'], ready.body);
    } finally {
      await api.stop();
    }
  });

  it('is pending while a shipped file is not applied, with /healthz still 200', async () => {
    const api = await running({ migrations: folderWith(ALL, { '0004-not-applied.sql': 'SELECT 1;' }) });
    try {
      const pending = await api.call('/readyz');
      expect(pending.status).toBe(503);
      expect(JSON.parse(pending.body)).toEqual({ status: 'not_ready', checks: { database: 'ok', migrations: 'pending' } });
      expect((await api.call('/healthz')).status).toBe(200);
      expectNoSecrets([...api.secrets, '0004-not-applied'], pending.body);
    } finally {
      await api.stop();
    }
  });

  it('is pending while the function behind the check does not exist yet, and ok after migrate has run, without a restart', async () => {
    const database = await postgres.newDatabase();
    const first = folderWith(ALL.slice(0, 2));
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
    expect((await runInProcess(env, first)).code).toBe(0);
    await rows(database.ownerUrl, readFileSync(join(SHIPPED, '0004-sources.sql'), 'utf8'));
    const api = await running({ database });
    try {
      const before = await api.call('/readyz');
      expect(before.status).toBe(503);
      expect(JSON.parse(before.body).checks).toEqual({ database: 'ok', migrations: 'pending' });
      await rows(database.ownerUrl, 'DROP TABLE sources');
      expect((await runCli(['migrate'], env).done).code).toBe(0);
      const after = await api.call('/readyz');
      expect(after.status).toBe(200);
      expect(JSON.parse(after.body).checks).toEqual({ database: 'ok', migrations: 'ok' });
    } finally {
      await api.stop();
    }
  });

  it('is ok when the database has applied a migration this image does not ship', async () => {
    const database = await migrated();
    await rows(database.ownerUrl, `INSERT INTO kysely_migration (name, timestamp) VALUES ('0099-from-a-newer-image', '2030-01-01T00:00:00.000Z')`);
    const api = await running({ database });
    try {
      expect((await api.call('/readyz')).status).toBe(200);
    } finally {
      await api.stop();
    }
  });

  it('is unknown, within three seconds, while the migration query cannot finish, and ok once it can', async () => {
    const api = await running();
    const holder = new pg.Client({ connectionString: api.database.ownerUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE kysely_migration IN ACCESS EXCLUSIVE MODE');
      const blocked = await api.call('/readyz');
      expect(blocked.status).toBe(503);
      expect(blocked.tookMs).toBeLessThan(WITHIN_MS);
      expect(JSON.parse(blocked.body).checks.migrations).toBe('unknown');
      await holder.query('COMMIT');
      await vi.waitFor(async () => expect((await api.call('/readyz')).status).toBe(200), { timeout: 10_000, interval: 200 });
    } finally {
      await holder.end();
      await api.stop();
    }
  });

  it('is unknown, with the database unreachable, when Postgres has stopped accepting connections', async () => {
    const api = await running();
    try {
      await api.forwarder.stop();
      const down = await api.call('/readyz');
      expect(down.status).toBe(503);
      expect(JSON.parse(down.body).checks).toEqual({ database: 'unreachable', migrations: 'unknown' });
    } finally {
      await api.stop();
    }
  });
});
