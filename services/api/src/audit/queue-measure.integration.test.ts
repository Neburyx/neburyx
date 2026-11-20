import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createAuditSink } from '@neburyx/ee-audit';
import { createPgAssistantThreadStore } from '@neburyx/ee-ask';
import type { AssistantThreadTurnWrite, AuditEvent, MountedAuditSink } from '@neburyx/contracts';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearRegisteredExtension, type ExtensionLoader } from '../profile/extension.js';
import { fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { AUDIT_RETRY_WAIT_BOUNDS, AUDIT_WRITE_TIMEOUT_BOUNDS } from './settings.js';
import { percentile, proposed, verdictOf, writeMeasureRecord } from '../testing/burst-measure.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const PREVIEW_MIGRATIONS = fileURLToPath(new URL('../../../../ee/migrations', import.meta.url));
const PREVIEW_FILE = join(fixtureFolder({ 'neburyx.yaml': stringify({ sources: [], ai: { preview: true } }) }), 'neburyx.yaml');
const loader: ExtensionLoader = { load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: PREVIEW_MIGRATIONS }) };

const OWNER = '0192f000-0000-7000-8000-000000000001';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000a1';
const HASH = 'a'.repeat(64);
const EVENTS = 1320;
const THREAD_DEFAULT = 100;
const THREAD_CEILING = 500;
const THREAD_READ_LIMIT_MS = 1000;

let postgres: TestPostgres;
const closers: (() => Promise<void>)[] = [];
const figures: Record<string, unknown> = {};

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
  await postgres.stop();
  removeFixtureFolders();
  clearRegisteredExtension();
  const folder = process.env['NEBURYX_MEASURE_RECORD_DIR'];
  if (folder !== undefined && folder !== '') writeMeasureRecord(folder, 'audit-and-thread-measure.json', figures);
});

async function seeded(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runInProcess({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole, NEBURYX_CONFIG: PREVIEW_FILE, NEBURYX_PROFILE: 'enterprise' }, SHIPPED, { extensionLoader: loader });
  expect([result.code, result.stderr]).toEqual([0, '']);
  await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ('${OWNER}', 'issuer', 'one', 'One')`);
  await rows(database.ownerUrl, `INSERT INTO sources (id, alias, connector, uri, database, secret_ref, config_hash, identity_hash) VALUES ('alpha', 'alpha', 'neo4j', 'bolt://x', 'neo4j', 'a:b', 'h', 'i')`);
  await rows(database.ownerUrl, `INSERT INTO investigations (id, source_id, source_identity_hash, owner_id, title) VALUES ('${INVESTIGATION}', 'alpha', 'i', '${OWNER}', 'Account')`);
  return database;
}

const contextOf = (database: TestDatabase) => ({ databaseUrl: database.appUrl, poolSize: 2, connectionTimeoutMs: 5000, statementTimeoutMs: 5000, queryTimeoutMs: 5000, newId: () => randomUUID(), onConnectionError: () => undefined });

describe('the built-in audit sink under the events of a burst', () => {
  it('writes each event of the burst and reports the latency of a write beside the write time limit and the retry wait', async () => {
    const database = await seeded();
    const sink: MountedAuditSink = createAuditSink(contextOf(database));
    closers.push(() => sink.close());
    const latencies: number[] = [];
    for (let index = 0; index < EVENTS; index += 1) {
      const event: AuditEvent = { actorId: OWNER, actorRole: 'investigator', action: 'assistant.step', result: 'success', traceId: `trace-${String(index)}` };
      const started = performance.now();
      await sink.sink.record(event);
      latencies.push(performance.now() - started);
    }
    const max = Math.ceil(Math.max(...latencies));
    const p99 = Math.ceil(percentile(latencies, 0.99));
    const limit = AUDIT_WRITE_TIMEOUT_BOUNDS.default;
    const verdict = verdictOf(max, limit);
    figures['auditSink'] = { events: EVENTS, maxMs: max, p99Ms: p99, writeTimeoutMs: limit, retryWaitMs: AUDIT_RETRY_WAIT_BOUNDS.default, verdict, ...(verdict === 'inside' ? {} : { proposedWriteTimeoutMs: proposed(max, AUDIT_WRITE_TIMEOUT_BOUNDS.max) }) };
    expect(latencies).toHaveLength(EVENTS);
    expect(Number((await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM audit_events'))[0]?.['n'])).toBe(EVENTS);
  });
});

describe('the read of a stored thread', () => {
  it('reports the time and the bytes of a read of the default and of the ceiling number of turns, inside when 500 turns read in under a second', async () => {
    const database = await seeded();
    const store = createPgAssistantThreadStore(contextOf(database));
    closers.push(() => store.close());
    for (let index = 0; index < THREAD_CEILING; index += 1) {
      const turn: AssistantThreadTurnWrite = { id: randomUUID(), investigationId: INVESTIGATION, userId: OWNER, at: new Date(Date.UTC(2026, 10, 18, 10, 0, index)), route: 'ask', outcome: 'answered', questionHash: HASH, intent: 'widgetById', entities: [{ role: 'id', ref: { sourceId: 'alpha', entityType: 'widget', stableId: `W-${String(index)}` } }], citationRefs: [{ sourceId: 'alpha', entityType: 'widget', stableId: `W-${String(index)}` }], steps: 1, modelRef: 'm', promptVersion: '1', tokensIn: 10, tokensOut: 5 };
      expect(await store.append(turn, 0)).toBe('stored');
    }
    const reads: Record<string, { turns: number; ms: number; bytes: number }> = {};
    for (const limit of [THREAD_DEFAULT, THREAD_CEILING]) {
      const started = performance.now();
      const thread = await store.read(INVESTIGATION, OWNER, limit);
      const ms = Math.ceil(performance.now() - started);
      reads[String(limit)] = { turns: thread.turns.length, ms, bytes: Buffer.byteLength(JSON.stringify(thread)) };
    }
    const ceiling = reads[String(THREAD_CEILING)];
    expect(reads[String(THREAD_DEFAULT)]?.turns).toBe(THREAD_DEFAULT);
    expect(ceiling?.turns).toBe(THREAD_CEILING);
    const verdict = (ceiling?.ms ?? Infinity) < THREAD_READ_LIMIT_MS ? 'inside' : 'over';
    figures['threadRead'] = { default: THREAD_DEFAULT, ceiling: THREAD_CEILING, reads, limitMs: THREAD_READ_LIMIT_MS, verdict, ...(verdict === 'inside' ? {} : { proposedTurns: THREAD_DEFAULT }) };
  });
});
