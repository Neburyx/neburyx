import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createAuditSink } from '@neburyx/ee-audit';
import { SYSTEM_ACTOR_ID, tokenCount, type AuditEvent, type AuditSinkContext, type MountedAuditSink } from '@neburyx/contracts';
import pg from 'pg';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readIdentity, seedFirstStart } from '../db/identity-repository.js';
import { uuidv7 } from '../identity/uuid.js';
import { clearRegisteredExtension, type ExtensionLoader } from './extension.js';
import { fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

const SHA = 'a'.repeat(64);

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const PREVIEW_MIGRATIONS = fileURLToPath(new URL('../../../../ee/migrations', import.meta.url));
const PREVIEW_FILE = join(fixtureFolder({ 'neburyx.yaml': stringify({ sources: [], ai: { preview: true } }) }), 'neburyx.yaml');
const loader: ExtensionLoader = { load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: PREVIEW_MIGRATIONS }) };
const CONNECTION_TIMEOUT_MS = 500;
const QUERY_TIMEOUT_MS = 800;

let postgres: TestPostgres;
const mounted: MountedAuditSink[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(mounted.map((entry) => entry.close()));
  await postgres.stop();
  removeFixtureFolders();
  clearRegisteredExtension();
});

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runInProcess({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole, NEBURYX_CONFIG: PREVIEW_FILE, NEBURYX_PROFILE: 'enterprise' }, SHIPPED, { extensionLoader: loader });
  expect(result.code, result.stderr).toBe(0);
  return database;
}

function sinkFor(url: string, over: Partial<AuditSinkContext> = {}): MountedAuditSink {
  const entry = createAuditSink({
    databaseUrl: url,
    poolSize: 2,
    connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    statementTimeoutMs: QUERY_TIMEOUT_MS,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
    newId: () => uuidv7(),
    onConnectionError: () => undefined,
    ...over,
  });
  mounted.push(entry);
  return entry;
}

const ACTOR = uuidv7();
const FULL: AuditEvent = { actorId: ACTOR, actorRole: 'investigator', action: 'graph.expand', result: 'partial', sourceId: 'alpha', investigationId: uuidv7(), resourceType: 'entity', resourceRef: 'person:1', traceId: 'tr-1', detail: { counts: { nodes: 4, edges: 3, missing: 1 } } };

describe('the audit sink over the preview tables', () => {
  it('stores an event with every member and reads it back with all the columns, the id a version 7 uuid and the time from the database', async () => {
    const database = await migrated();
    const entry = sinkFor(database.appUrl);
    const [before] = await rows(database.ownerUrl, 'SELECT clock_timestamp() AS now');
    await entry.sink.record(FULL);
    const [after] = await rows(database.ownerUrl, 'SELECT clock_timestamp() AS now');
    const stored = await rows(database.appUrl, 'SELECT * FROM audit_events');
    expect(stored).toHaveLength(1);
    const row = stored[0] ?? {};
    expect(row).toMatchObject({ actor_id: ACTOR, actor_role: 'investigator', action: 'graph.expand', result: 'partial', source_id: 'alpha', investigation_id: FULL.investigationId, resource_type: 'entity', resource_ref: 'person:1', trace_id: 'tr-1', detail: { counts: { nodes: 4, edges: 3, missing: 1 } } });
    expect(String(row['id'])[14]).toBe('7');
    expect(Number(row['at'] instanceof Date ? row['at'].getTime() : Number.NaN)).toBeGreaterThanOrEqual(Number((before?.['now'] as Date).getTime()));
    expect(Number((row['at'] as Date).getTime())).toBeLessThanOrEqual(Number((after?.['now'] as Date).getTime()));
  });

  it('stores null for every optional column of an event that has only the required members', async () => {
    const database = await migrated();
    await sinkFor(database.appUrl).sink.record({ actorId: ACTOR, actorRole: 'viewer', action: 'investigation.open', result: 'success', traceId: 'tr-2' });
    expect(await rows(database.appUrl, 'SELECT source_id, investigation_id, resource_type, resource_ref, detail FROM audit_events')).toEqual([{ source_id: null, investigation_id: null, resource_type: null, resource_ref: null, detail: null }]);
  });

  it.each([
    { reason: 'cancelled' },
    { target: 'evidence', type: 'owns' },
    { counts: { nodes: 1, edges: 0, missing: 0 } },
    { export: { format: 'csv', entities: 5, relationships: 4, maskedFields: 2 } },
    { ai: { modelRef: 'model-a', promptId: 'ask-plan', promptVersion: '1', promptSha256: SHA, tokensIn: tokenCount(12), tokensOut: 'unknown' } },
  ] as const)('round-trips the detail shape %j', async (detail) => {
    const database = await migrated();
    await sinkFor(database.appUrl).sink.record({ ...FULL, detail });
    expect(await rows(database.appUrl, 'SELECT detail FROM audit_events')).toEqual([{ detail }]);
  });

  it('stores the purge of a deleted investigation and a read by the system principal, whose actor is not a person', async () => {
    const database = await migrated();
    const entry = sinkFor(database.appUrl);
    await entry.sink.record({ actorId: 'system', actorRole: 'system', action: 'investigation.purge', traceId: 'purge', result: 'success', sourceId: 'alpha' });
    await entry.sink.record({ actorId: SYSTEM_ACTOR_ID, actorRole: null, action: 'source.connectivity', traceId: 'tr-3', result: 'success', sourceId: 'alpha' });
    expect(await rows(database.appUrl, 'SELECT actor_id, actor_role FROM audit_events ORDER BY action')).toEqual([
      { actor_id: SYSTEM_ACTOR_ID, actor_role: 'system' },
      { actor_id: SYSTEM_ACTOR_ID, actor_role: 'system' },
    ]);
  });

  it('stores an event for the seeded local user under that user\'s id, and adds no user', async () => {
    const database = await migrated();
    const pool = new pg.Pool({ connectionString: database.appUrl });
    try {
      await seedFirstStart(pool);
      const identity = await readIdentity(pool);
      const before = await rows(database.ownerUrl, 'SELECT count(*)::int AS users FROM users');
      await sinkFor(database.appUrl).sink.record({ ...FULL, actorId: identity.principal.id });
      expect(await rows(database.appUrl, 'SELECT actor_id FROM audit_events')).toEqual([{ actor_id: identity.principal.id }]);
      expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS users FROM users')).toEqual(before);
    } finally {
      await pool.end();
    }
  });

  it('refuses a detail that holds prompt or summary text, writes no row, and leaves no marker in the table or on the process output', async () => {
    const database = await migrated();
    const entry = sinkFor(database.appUrl);
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    try {
      const bad = { ai: { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: 'unknown', tokensOut: 'unknown', prompt: 'PROMPT-MARKER' }, text: 'SUMMARY-MARKER' };
      // ill-typed on purpose: the sink must refuse what the type already forbids
      await expect(entry.sink.record({ ...FULL, detail: bad as never })).rejects.toMatchObject({ code: 'AUDIT_DETAIL_REFUSED' });
      await entry.sink.record({ ...FULL, detail: { ai: { modelRef: 'model-a', promptId: 'ask-plan', promptVersion: '1', promptSha256: SHA, tokensIn: tokenCount(1), tokensOut: tokenCount(2) } } });
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const everything = JSON.stringify(await rows(database.ownerUrl, 'SELECT * FROM audit_events'));
    expect(everything).not.toMatch(/PROMPT-MARKER|SUMMARY-MARKER/);
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS rows FROM audit_events')).toEqual([{ rows: 1 }]);
    expect(written.join('')).not.toMatch(/PROMPT-MARKER|SUMMARY-MARKER/);
  });

  it('rejects within the connection timeout when the database cannot be reached, with a fixed code', async () => {
    const entry = sinkFor('postgres://app:nopassword@127.0.0.1:1/none');
    const started = Date.now();
    await expect(entry.sink.record(FULL)).rejects.toMatchObject({ code: 'AUDIT_WRITE_FAILED', message: 'the audit event could not be written' });
    expect(Date.now() - started).toBeLessThan(CONNECTION_TIMEOUT_MS * 4);
  });

  it('rejects within the query timeout when the table is locked and the insert stalls', async () => {
    const database = await migrated();
    const entry = sinkFor(database.appUrl);
    const owner = new pg.Client({ connectionString: database.ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await expect(entry.sink.record(FULL)).rejects.toMatchObject({ code: 'AUDIT_WRITE_FAILED' });
      expect(Date.now() - started).toBeLessThan(QUERY_TIMEOUT_MS * 4);
    } finally {
      await owner.query('ROLLBACK');
      await owner.end();
    }
  });
});
