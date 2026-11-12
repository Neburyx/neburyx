import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditUnavailableError, buildPromptRegistry, createAuditedModelCall, createEnterpriseExtension, type AuditedCallContext, type ModelRequest, type PromptId } from '@neburyx/ee-ask';
import type { MountedAuditSink } from '@neburyx/contracts';
import pg from 'pg';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtureProvider, replyKey, type FixtureReply } from '../../../../ee/ask/src/testing/fixture.js';
import { uuidv7 } from '../identity/uuid.js';
import { clearRegisteredExtension, type ExtensionLoader } from './extension.js';
import { fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const PREVIEW_MIGRATIONS = fileURLToPath(new URL('../../../../ee/migrations', import.meta.url));
const PREVIEW_FILE = join(fixtureFolder({ 'neburyx.yaml': stringify({ sources: [], ai: { preview: true } }) }), 'neburyx.yaml');
const loader: ExtensionLoader = { load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: PREVIEW_MIGRATIONS }) };
const QUERY_TIMEOUT_MS = 800;
const folder = mkdtempSync(join(tmpdir(), 'audited-call-'));
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
  rmSync(folder, { recursive: true, force: true });
});

const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const ACTOR = uuidv7();
const CONTEXT: AuditedCallContext = { actorId: ACTOR, actorRole: 'investigator', traceId: 'tr-call' };
const MARKERS = ['QUESTION-MARKER', 'VIEW-MARKER', 'MESSAGE-MARKER', 'ANSWER-MARKER'];
const REQUESTS: Readonly<Record<PromptId, ModelRequest>> = {
  'ask.plan': { promptId: 'ask.plan', parameters: { catalog: 'T1, T2', question: 'QUESTION-MARKER who is here?' } },
  'summary.view': { promptId: 'summary.view', parameters: { view: 'VIEW-MARKER a view' } },
  'assistant.route': { promptId: 'assistant.route', parameters: { message: 'MESSAGE-MARKER hello', view: 'VIEW-MARKER a view' } },
};

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runInProcess({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole, NEBURYX_CONFIG: PREVIEW_FILE, NEBURYX_PROFILE: 'enterprise' }, SHIPPED, { extensionLoader: loader });
  expect(result.code, result.stderr).toBe(0);
  return database;
}

/** The extension's own mounted sink over the application's login, and a fixture provider behind the audited call, as a start of the preview puts them together. */
async function audited(database: TestDatabase, reply: FixtureReply, overrides: Record<string, string> = {}) {
  const extension = createEnterpriseExtension();
  expect(extension.auditSink()).toBeUndefined();
  const mounted = extension.createAuditSink?.({ databaseUrl: database.appUrl, poolSize: 2, connectionTimeoutMs: 500, statementTimeoutMs: QUERY_TIMEOUT_MS, queryTimeoutMs: QUERY_TIMEOUT_MS, newId: uuidv7, onConnectionError: () => undefined });
  if (mounted === undefined) throw new Error('the extension supplies no audit sink');
  mountedSinks.push(mounted);
  const sink = extension.auditSink();
  if (sink === undefined) throw new Error('the extension holds no audit sink');
  const built = await buildPromptRegistry(overrides);
  if (!built.ok) throw new Error(built.problems.join('; '));
  const replies = Object.fromEntries((['ask.plan', 'summary.view', 'assistant.route'] as const).map((id) => [replyKey(id, 1), reply]));
  const provider = createFixtureProvider({ registry: built.registry, replies });
  return { call: createAuditedModelCall({ provider, configuration: { registry: built.registry, model: 'configured-model' }, sink }).call, registry: built.registry };
}

const OK: FixtureReply = { kind: 'ok', text: 'ANSWER-MARKER a plan', usage: { kind: 'known', inputTokens: 12, outputTokens: 34 } };
const SIGNAL = new AbortController().signal;

describe('a model call through the fixture, recorded in audit_events', () => {
  it.each(['ask.plan', 'summary.view', 'assistant.route'] as const)('leaves one row for %s with the model, the prompt, its hash and the counts', async (id) => {
    const database = await migrated();
    const { call, registry } = await audited(database, OK);
    await call(REQUESTS[id], CONTEXT, SIGNAL);
    const stored = await rows(database.appUrl, 'SELECT actor_id, actor_role, action, result, trace_id, detail FROM audit_events');
    expect(stored).toEqual([
      {
        actor_id: ACTOR,
        actor_role: 'investigator',
        action: { 'ask.plan': 'ask.plan', 'summary.view': 'ai.summary', 'assistant.route': 'assistant.turn' }[id],
        result: 'success',
        trace_id: 'tr-call',
        detail: { ai: { modelRef: 'fixture-model', promptId: id, promptVersion: '1', promptSha256: registry.resolve(id, REQUESTS[id].parameters).record.sha256, tokensIn: 12, tokensOut: 34 } },
      },
    ]);
  });

  it('leaves no marker of the question, the view, the message or the answer in the row, and none on the process output', async () => {
    const database = await migrated();
    const { call } = await audited(database, OK);
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    try {
      for (const id of ['ask.plan', 'summary.view', 'assistant.route'] as const) await call(REQUESTS[id], CONTEXT, SIGNAL);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const everything = JSON.stringify(await rows(database.ownerUrl, 'SELECT * FROM audit_events'));
    for (const marker of MARKERS) {
      expect(everything).not.toContain(marker);
      expect(written.join('')).not.toContain(marker);
    }
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS rows FROM audit_events')).toEqual([{ rows: 3 }]);
  });

  it('records the template hash of an operator\'s override, not that of the built-in prompt', async () => {
    const database = await migrated();
    const file = join(folder, 'summary.txt');
    writeFileSync(file, "An operator's own instruction about {{view}}.");
    const { call } = await audited(database, OK, { 'summary.view': file });
    await call(REQUESTS['summary.view'], CONTEXT, SIGNAL);
    const [row] = await rows(database.appUrl, 'SELECT detail FROM audit_events');
    const expected = sha256Of("An operator's own instruction about {{view}}.");
    expect(row?.['detail']).toMatchObject({ ai: { promptSha256: expected } });
    const builtIn = await buildPromptRegistry();
    if (!builtIn.ok) throw new Error('the built-in prompts did not load');
    expect(builtIn.registry.resolve('summary.view', REQUESTS['summary.view'].parameters).record.sha256).not.toBe(expected);
  });

  it('records the model of a fallback answer, unknown counts as unknown, and the names of the pii properties sent', async () => {
    const database = await migrated();
    const { call } = await audited(database, { kind: 'ok', text: 'a plan', model: 'fallback-model' });
    await call(REQUESTS['ask.plan'], { ...CONTEXT, piiPropertiesSent: ['person.phone'] }, SIGNAL);
    expect(await rows(database.appUrl, 'SELECT detail FROM audit_events')).toMatchObject([{ detail: { ai: { modelRef: 'fallback-model', tokensIn: 'unknown', tokensOut: 'unknown', piiPropertiesSent: ['person.phone'] } } }]);
  });

  it('rejects with the audit error and returns no text when the table is locked and the insert stalls', async () => {
    const database = await migrated();
    const { call } = await audited(database, OK);
    const owner = new pg.Client({ connectionString: database.ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      const outcome = await call(REQUESTS['ask.plan'], CONTEXT, SIGNAL).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(AuditUnavailableError);
      expect(outcome).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
      expect(JSON.stringify(outcome)).not.toContain('ANSWER-MARKER');
      expect(Date.now() - started).toBeLessThan(QUERY_TIMEOUT_MS * 4);
    } finally {
      await owner.query('ROLLBACK');
      await owner.end();
    }
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS rows FROM audit_events')).toEqual([{ rows: 0 }]);
  });
});
