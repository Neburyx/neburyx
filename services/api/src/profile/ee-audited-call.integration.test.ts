import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditedModelCall, createEnterpriseExtension, type AuditedCallContext, type ModelRequest } from '@neburyx/ee-ask';
import type { MountedAuditSink } from '@neburyx/contracts';
import pg from 'pg';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtureProvider, replyKey, type FixtureReply } from '../../../../ee/ai-runtime/src/testing/fixture.js';
import { uuidv7 } from '../identity/uuid.js';
import { clearRegisteredExtension, type ExtensionLoader } from './extension.js';
import { fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const PREVIEW_MIGRATIONS = fileURLToPath(new URL('../../../../ee/migrations', import.meta.url));
const PREVIEW_FILE = join(fixtureFolder({ 'neburyx.yaml': stringify({ sources: [], ai: { preview: true } }) }), 'neburyx.yaml');
const loader: ExtensionLoader = { load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: PREVIEW_MIGRATIONS }) };
const QUERY_TIMEOUT_MS = 800;
const mountedSinks: MountedAuditSink[] = [];

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(mountedSinks.map((entry) => entry.close()));
  await postgres.stop();
  removeFixtureFolders();
  clearRegisteredExtension();
});

const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const ACTOR = uuidv7();
const CONTEXT: AuditedCallContext = { action: 'ai.summary', actorId: ACTOR, actorRole: 'investigator', traceId: 'tr-call' };
const MARKERS = ['INSTRUCTIONS-MARKER', 'VALUES-MARKER', 'ANSWER-MARKER'];
const INSTRUCTIONS = 'INSTRUCTIONS-MARKER the fixed part of a test prompt.';
const REQUEST: ModelRequest = { promptId: 'test.prompt', version: 1, instructions: INSTRUCTIONS, values: 'VALUES-MARKER what changes with each call' };

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runInProcess({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole, NEBURYX_CONFIG: PREVIEW_FILE, NEBURYX_PROFILE: 'enterprise' }, SHIPPED, { extensionLoader: loader });
  expect(result.code, result.stderr).toBe(0);
  return database;
}

/** The extension's own mounted sink over the application's login, and a fixture provider behind the audited call, as a start of the preview puts them together. */
async function audited(database: TestDatabase, reply: FixtureReply) {
  const extension = createEnterpriseExtension();
  expect(extension.auditSink()).toBeUndefined();
  const mounted = extension.createAuditSink?.({ databaseUrl: database.appUrl, poolSize: 2, connectionTimeoutMs: 500, statementTimeoutMs: QUERY_TIMEOUT_MS, queryTimeoutMs: QUERY_TIMEOUT_MS, newId: uuidv7, onConnectionError: () => undefined });
  if (mounted === undefined) throw new Error('the extension supplies no audit sink');
  mountedSinks.push(mounted);
  const sink = extension.auditSink();
  if (sink === undefined) throw new Error('the extension holds no audit sink');
  const provider = createFixtureProvider({ replies: { [replyKey('test.prompt', 1)]: reply } });
  return { call: createAuditedModelCall({ provider, configuration: { model: 'configured-model' }, sink }).call };
}

const OK: FixtureReply = { kind: 'ok', text: 'ANSWER-MARKER an answer', usage: { kind: 'known', inputTokens: 12, outputTokens: 34 } };
const SIGNAL = new AbortController().signal;

describe('a model call through the fixture, recorded in audit_events', () => {
  it('leaves one row with the action, the model, the prompt, its hash and the counts', async () => {
    const database = await migrated();
    const { call } = await audited(database, OK);
    await call(REQUEST, CONTEXT, SIGNAL);
    const stored = await rows(database.appUrl, 'SELECT actor_id, actor_role, action, result, trace_id, detail FROM audit_events');
    expect(stored).toEqual([
      {
        actor_id: ACTOR,
        actor_role: 'investigator',
        action: 'ai.summary',
        result: 'success',
        trace_id: 'tr-call',
        detail: { ai: { modelRef: 'fixture-model', promptId: 'test.prompt', promptVersion: '1', promptSha256: sha256Of(INSTRUCTIONS), tokensIn: 12, tokensOut: 34, cacheReadTokens: 'unknown', cacheWriteTokens: 'unknown' } },
      },
    ]);
    const [row] = stored;
    expect(row?.['detail']).not.toHaveProperty('ai.instructionsSha256');
    expect(row?.['detail']).not.toHaveProperty('ai.piiPropertiesSent');
  });

  it('leaves no marker of the instructions, the values or the answer in the row, and none on the process output', async () => {
    const database = await migrated();
    const { call } = await audited(database, OK);
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    try {
      await call(REQUEST, CONTEXT, SIGNAL);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const everything = JSON.stringify(await rows(database.ownerUrl, 'SELECT * FROM audit_events'));
    for (const marker of MARKERS) {
      expect(everything).not.toContain(marker);
      expect(written.join('')).not.toContain(marker);
    }
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS rows FROM audit_events')).toEqual([{ rows: 1 }]);
  });

  it('records the model of a fallback answer and unknown counts as unknown', async () => {
    const database = await migrated();
    const { call } = await audited(database, { kind: 'ok', text: 'an answer', model: 'fallback-model' });
    await call(REQUEST, CONTEXT, SIGNAL);
    expect(await rows(database.appUrl, 'SELECT detail FROM audit_events')).toMatchObject([{ detail: { ai: { modelRef: 'fallback-model', tokensIn: 'unknown', tokensOut: 'unknown' } } }]);
  });

  it('returns the answer within the query time limit, and writes no event, when the table is locked and the insert stalls', async () => {
    const database = await migrated();
    const { call } = await audited(database, OK);
    const owner = new pg.Client({ connectionString: database.ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      const outcome = await call(REQUEST, CONTEXT, SIGNAL).catch((error: unknown) => error);
      expect(JSON.stringify(outcome)).toContain('ANSWER-MARKER');
      expect(Date.now() - started).toBeLessThan(QUERY_TIMEOUT_MS * 4);
    } finally {
      await owner.query('ROLLBACK');
      await owner.end();
    }
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS rows FROM audit_events')).toEqual([{ rows: 0 }]);
  });
});
