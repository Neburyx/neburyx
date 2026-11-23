import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSummaryInstructions, createAuditedModelCall, createCaseSummarizer, createEnterpriseExtension, createPgAssistantRunStore, createPgSummaryRunStore, promptRecordOf, type ModelProvider } from '@neburyx/ee-ask';
import { clearRegisteredExtension, type ExtensionLoader } from '../profile/extension.js';
import { attempt, fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const PREVIEW_MIGRATIONS = fileURLToPath(new URL('../../../../ee/migrations', import.meta.url));
const PREVIEW_FILE = join(fixtureFolder({ 'neburyx.yaml': stringify({ sources: [], ai: { preview: true } }) }), 'neburyx.yaml');
const loader: ExtensionLoader = { load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: PREVIEW_MIGRATIONS }) };

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  removeFixtureFolders();
  clearRegisteredExtension();
});

const environment = (database: TestDatabase) => ({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole });
const previewOn = (database: TestDatabase) => ({ ...environment(database), NEBURYX_CONFIG: PREVIEW_FILE, NEBURYX_PROFILE: 'enterprise' });

async function migratedWithPreview(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader });
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return database;
}

const columnsOf = async (database: TestDatabase, table: string) =>
  rows(database.ownerUrl, `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);

const AUDIT_ROW = (over: Record<string, unknown> = {}): readonly unknown[] => {
  const row = { id: randomUUID(), actor: randomUUID(), role: 'administrator', action: 'graph.expand', result: 'success', trace: 'tr-1', ...over };
  return [row.id, row.actor, row.role, row.action, row.result, row.trace];
};
const INSERT_AUDIT = 'INSERT INTO audit_events (id, actor_id, actor_role, action, result, trace_id) VALUES ($1, $2, $3, $4, $5, $6)';

describe('the audit_events table of the preview', () => {
  it('has the columns of the data model, with null allowed on the optional ones only, and the primary key (at, id)', async () => {
    const database = await migratedWithPreview();
    expect(await columnsOf(database, 'audit_events')).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'actor_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'actor_role', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'action', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'result', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'source_id', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'investigation_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'resource_type', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'resource_ref', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'trace_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'detail', data_type: 'jsonb', is_nullable: 'YES' },
    ]);
    const key = await rows(database.ownerUrl, `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) WHERE i.indrelid = 'audit_events'::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`);
    expect(key.map((entry) => entry['attname'])).toEqual(['at', 'id']);
    const defaulted = await rows(database.ownerUrl, `SELECT column_default FROM information_schema.columns WHERE table_name = 'audit_events' AND column_name = 'at'`);
    expect(defaulted[0]?.['column_default']).toBe('clock_timestamp()');
  });

  it('has one index on each of actor, action, investigation and source with the time descending, one on the trace ID, and no foreign key', async () => {
    const database = await migratedWithPreview();
    const indexes = await rows(database.ownerUrl, `SELECT indexdef FROM pg_indexes WHERE tablename = 'audit_events' AND indexname <> 'audit_events_pkey' ORDER BY indexname`);
    expect(indexes.map((entry) => String(entry['indexdef']).replace(/^.*\((.*)\)$/, '$1'))).toEqual(['action, at DESC', 'actor_id, at DESC', 'investigation_id, at DESC', 'source_id, at DESC', 'trace_id']);
    expect(await rows(database.ownerUrl, `SELECT 1 FROM pg_constraint WHERE conrelid = 'audit_events'::regclass AND contype = 'f'`)).toEqual([]);
  });

  it.each(['success', 'denied', 'partial', 'refused', 'failed'])('accepts the result %s from the application role, and reads the row back', async (result) => {
    const database = await migratedWithPreview();
    const values = AUDIT_ROW({ result });
    expect(await attempt(database.appUrl, INSERT_AUDIT, values)).toBe('allowed');
    expect(await rows(database.appUrl, 'SELECT result FROM audit_events WHERE id = $1', [values[0]])).toEqual([{ result }]);
  });

  it('refuses a result outside the five, and a null in any required column', async () => {
    const database = await migratedWithPreview();
    expect(await attempt(database.appUrl, INSERT_AUDIT, AUDIT_ROW({ result: 'ok' }))).toMatch(/audit_events_result_known/);
    for (const [index, column] of ['id', 'actor_id', 'actor_role', 'action', 'result', 'trace_id'].entries()) {
      const values = [...AUDIT_ROW()];
      values[index] = null;
      expect(await attempt(database.appUrl, INSERT_AUDIT, values), column).toMatch(/null value|violates not-null/);
    }
  });

  it('refuses the application role an update, a delete and a truncate, on the first migrate and after a second one', async () => {
    const database = await migratedWithPreview();
    expect(await attempt(database.appUrl, INSERT_AUDIT, AUDIT_ROW())).toBe('allowed');
    const second = await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader });
    expect([second.code, second.stdout]).toEqual([0, 'nothing to apply\n']);
    for (const statement of ["UPDATE audit_events SET action = 'x'", 'DELETE FROM audit_events', 'TRUNCATE audit_events']) {
      expect(await attempt(database.appUrl, statement), statement).toMatch(/permission denied/);
    }
  });

  it('gives the application role nothing, and grants nothing silently, when the default rights were removed before the preview migration', async () => {
    const database = await postgres.newDatabase();
    expect((await runInProcess(environment(database), SHIPPED)).code).toBe(0);
    const owner = new pg.Client({ connectionString: database.ownerUrl });
    await owner.connect();
    try {
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${owner.escapeIdentifier(database.appRole)}`);
    } finally {
      await owner.end();
    }
    expect((await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader })).code).toBe(0);
    expect(await attempt(database.appUrl, INSERT_AUDIT, AUDIT_ROW())).toMatch(/permission denied/);
    expect(await attempt(database.appUrl, 'SELECT * FROM audit_events')).toMatch(/permission denied/);
  });
});

describe('the ask_runs table of the preview', () => {
  const user = async (database: TestDatabase): Promise<string> => {
    const id = randomUUID();
    await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'local', $2, 'Test user')`, [id, id]);
    return id;
  };
  const INSERT_RUN = `INSERT INTO ask_runs (id, actor_id, intent, outcome, row_count, elapsed_ms) VALUES ($1, $2, 'entity', $3, $4, $5)`;

  it('has the columns of the data model, all required, with the id as primary key and created_at defaulting to the database clock', async () => {
    const database = await migratedWithPreview();
    expect(await columnsOf(database, 'ask_runs')).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'actor_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'outcome', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'row_count', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'elapsed_ms', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'intent', data_type: 'text', is_nullable: 'NO' },
    ]);
    const constraints = await rows(database.ownerUrl, `SELECT contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'ask_runs'::regclass AND contype IN ('p', 'f') ORDER BY contype`);
    expect(constraints).toEqual([
      { contype: 'f', definition: 'FOREIGN KEY (actor_id) REFERENCES users(id)' },
      { contype: 'p', definition: 'PRIMARY KEY (id)' },
    ]);
  });

  it.each(['complete', 'partial', 'failed'])('lets the application role insert a run with the outcome %s and read it back', async (outcome) => {
    const database = await migratedWithPreview();
    const actor = await user(database);
    const id = randomUUID();
    expect(await attempt(database.appUrl, INSERT_RUN, [id, actor, outcome, 3, 120])).toBe('allowed');
    expect(await rows(database.appUrl, 'SELECT outcome, row_count, elapsed_ms FROM ask_runs WHERE id = $1', [id])).toEqual([{ outcome, row_count: 3, elapsed_ms: 120 }]);
  });

  it('refuses an actor that is no user, an unknown outcome and a negative count', async () => {
    const database = await migratedWithPreview();
    const actor = await user(database);
    expect(await attempt(database.appUrl, INSERT_RUN, [randomUUID(), randomUUID(), 'complete', 1, 1])).toMatch(/foreign key/);
    expect(await attempt(database.appUrl, INSERT_RUN, [randomUUID(), actor, 'ok', 1, 1])).toMatch(/ask_runs_outcome_known/);
    expect(await attempt(database.appUrl, INSERT_RUN, [randomUUID(), actor, 'complete', -1, 1])).toMatch(/ask_runs_row_count_not_negative/);
    expect(await attempt(database.appUrl, INSERT_RUN, [randomUUID(), actor, 'complete', 1, -1])).toMatch(/ask_runs_elapsed_not_negative/);
    expect(await attempt(database.appUrl, INSERT_RUN, [randomUUID(), actor, 'complete', 1, 1])).toBe('allowed');
  });
});

describe('the preview migrations that retired the stored plans', () => {
  const EARLIER_FILES = ['0001-audit-events.sql', '0002-ask-runs.sql', '0003-ask-plans.sql'];
  const earlier: ExtensionLoader = {
    load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: fixtureFolder(Object.fromEntries(EARLIER_FILES.map((name) => [name, readFileSync(join(PREVIEW_MIGRATIONS, name), 'utf8')]))) }),
  };

  it('drops ask_plans and the plan_id of ask_runs on a database that holds plans and runs, keeps every run, and the audit index by trace ID', async () => {
    const database = await postgres.newDatabase();
    expect((await runInProcess(previewOn(database), SHIPPED, { extensionLoader: earlier })).code).toBe(0);
    const owner = randomUUID();
    await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'local', $2, 'Test user')`, [owner, owner]);
    const plan = randomUUID();
    await rows(database.ownerUrl, `INSERT INTO ask_plans (id, user_id, source_id, template_id, template_version, params, planning_trace_id, expires_at) VALUES ($1, $2, 'demo', 'entity', 1, '{}', 'tr-1', clock_timestamp() + interval '15 minutes')`, [plan, owner]);
    const runs = [randomUUID(), randomUUID()];
    for (const id of runs) await rows(database.ownerUrl, `INSERT INTO ask_runs (id, plan_id, actor_id, outcome, row_count, elapsed_ms) VALUES ($1, $2, $3, 'complete', 2, 10)`, [id, plan, owner]);

    const migrated = await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader });
    expect([migrated.code, migrated.stderr]).toEqual([0, '']);
    expect(await rows(database.ownerUrl, `SELECT to_regclass('public.ask_plans') IS NOT NULL AS plans`)).toEqual([{ plans: false }]);
    expect((await columnsOf(database, 'ask_runs')).map((column) => column['column_name'])).not.toContain('plan_id');
    expect((await rows(database.ownerUrl, 'SELECT id FROM ask_runs ORDER BY id')).map((row) => row['id'])).toEqual([...runs].sort());
    expect(await rows(database.ownerUrl, `SELECT indexname FROM pg_indexes WHERE tablename = 'audit_events' AND indexdef LIKE '%(trace_id)%'`)).toEqual([{ indexname: 'audit_events_trace' }]);
    const again = await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader });
    expect([again.code, again.stdout]).toEqual([0, 'nothing to apply\n']);
  });

  it('adds the intent of ask_runs to a database migrated to 0004: the rows stay with the intent unknown, and the column is required', async () => {
    const UNTIL_0004 = [...EARLIER_FILES, '0004-drop-ask-plans.sql'];
    const until0004: ExtensionLoader = {
      load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: fixtureFolder(Object.fromEntries(UNTIL_0004.map((name) => [name, readFileSync(join(PREVIEW_MIGRATIONS, name), 'utf8')]))) }),
    };
    const database = await postgres.newDatabase();
    expect((await runInProcess(previewOn(database), SHIPPED, { extensionLoader: until0004 })).code).toBe(0);
    const owner = randomUUID();
    await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'local', $2, 'Test user')`, [owner, owner]);
    const runs = [randomUUID(), randomUUID()];
    for (const id of runs) await rows(database.ownerUrl, `INSERT INTO ask_runs (id, actor_id, outcome, row_count, elapsed_ms) VALUES ($1, $2, 'complete', 2, 10)`, [id, owner]);

    const migrated = await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader });
    expect([migrated.code, migrated.stderr]).toEqual([0, '']);
    expect(await rows(database.ownerUrl, 'SELECT id, intent FROM ask_runs ORDER BY id')).toEqual([...runs].sort().map((id) => ({ id, intent: 'unknown' })));
    expect(await rows(database.ownerUrl, `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'ask_runs' AND column_name = 'intent'`)).toEqual([{ is_nullable: 'NO' }]);
    expect(await attempt(database.appUrl, 'INSERT INTO ask_runs (id, actor_id, outcome, row_count, elapsed_ms) VALUES ($1, $2, $3, 1, 1)', [randomUUID(), owner, 'complete'])).toMatch(/intent/);
  });

  it('indexes the audit table by trace ID on a fresh database', async () => {
    const database = await migratedWithPreview();
    const found = await rows(database.ownerUrl, `SELECT indexname FROM pg_indexes WHERE tablename = 'audit_events' AND indexdef LIKE '%(trace_id)%'`);
    expect(found).toEqual([{ indexname: 'audit_events_trace' }]);
  });
});

describe('the summary_runs and summary_run_calls tables of the preview', () => {
  const contextOf = (database: TestDatabase) => ({ databaseUrl: database.appUrl, poolSize: 2, connectionTimeoutMs: 5000, statementTimeoutMs: 5000, queryTimeoutMs: 5000, newId: () => randomUUID(), onConnectionError: () => undefined });
  const BASE = { actorId: randomUUID(), sourceId: 'demo', traceId: 'tr-1', settings: { model: 'm' } };
  const call = (runId: string, number: number) => ({ runId, number, startedAt: new Date(), instructionsSha256: 'a'.repeat(64), instructionsText: 'INSTRUCTIONS', valuesText: 'VALUES' });

  it('has the columns of the data model, a cascade from the calls to the run, and no foreign key to the users table', async () => {
    const database = await migratedWithPreview();
    expect((await columnsOf(database, 'summary_runs')).map((column) => column['column_name'])).toEqual(['id', 'actor_id', 'investigation_id', 'source_id', 'trace_id', 'started_at', 'finished_at', 'outcome', 'calls', 'settings']);
    expect((await columnsOf(database, 'summary_run_calls')).map((column) => column['column_name'])).toEqual(['run_id', 'call_number', 'started_at', 'duration_ms', 'instructions_sha256', 'instructions_text', 'values_text', 'reply_text', 'status', 'failure_kind', 'tokens_in', 'tokens_out']);
    expect(await rows(database.ownerUrl, `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'summary_run_calls'::regclass AND contype = 'f'`)).toEqual([{ definition: 'FOREIGN KEY (run_id) REFERENCES summary_runs(id) ON DELETE CASCADE' }]);
    expect(await rows(database.ownerUrl, `SELECT 1 FROM pg_constraint WHERE conrelid = 'summary_runs'::regclass AND contype = 'f'`)).toEqual([]);
  });

  it('is written, completed and removed by the real store through the application role, and a removal takes the calls with the run', async () => {
    const database = await migratedWithPreview();
    const store = createPgSummaryRunStore(contextOf(database));
    try {
      const startedAt = new Date('2026-10-01T00:00:00Z');
      const id = randomUUID();
      await store.begin({ ...BASE, id, startedAt });
      await store.begin({ ...BASE, id, startedAt });
      expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM summary_runs WHERE id = $1', [id])).toEqual([{ n: 1 }]);
      await store.beginCall(call(id, 1));
      await store.beginCall(call(id, 1));
      expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM summary_run_calls WHERE run_id = $1', [id])).toEqual([{ n: 1 }]);
      expect(await rows(database.ownerUrl, 'SELECT status, reply_text FROM summary_run_calls WHERE run_id = $1', [id])).toEqual([{ status: null, reply_text: null }]);
      await store.endCall({ runId: id, number: 1, status: 'refused', replyText: 'REPLY', tokensIn: 5, tokensOut: 2, durationMs: 40 });
      await store.finish(id, 'failed', 1, new Date());
      expect(await rows(database.ownerUrl, 'SELECT outcome, calls FROM summary_runs WHERE id = $1', [id])).toEqual([{ outcome: 'failed', calls: 1 }]);
      expect(await rows(database.ownerUrl, 'SELECT status, reply_text, tokens_in, duration_ms FROM summary_run_calls WHERE run_id = $1', [id])).toEqual([{ status: 'refused', reply_text: 'REPLY', tokens_in: 5, duration_ms: 40 }]);
      expect(await store.removeStartedBefore(new Date(startedAt.getTime()))).toBe(0);
      expect(await store.removeStartedBefore(new Date(startedAt.getTime() + 1))).toBe(1);
      expect(await rows(database.ownerUrl, 'SELECT 1 FROM summary_run_calls')).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('holds the rows of a whole click through the real summarizer, store and audit sink, readable by the application role, with the run id and trace id linking them to the audit events', async () => {
    const database = await migratedWithPreview();
    const context = contextOf(database);
    const extension = createEnterpriseExtension();
    const mounted = extension.createAuditSink?.({ ...context, onConnectionError: () => undefined });
    if (mounted === undefined) throw new Error('no audit sink');
    const store = createPgSummaryRunStore(context);
    try {
      const provider: ModelProvider = { complete: async (request) => ({ status: 'ok', text: JSON.stringify({ sentences: [{ text: 'A fixed sentence.', cites: ['n1'] }] }), usage: { kind: 'known', inputTokens: 5, outputTokens: 2 }, model: 'm', prompt: promptRecordOf(request) }) };
      const model = createAuditedModelCall({ provider, configuration: { model: 'claude-sonnet-5-5' }, sink: mounted.sink });
      const summarizer = createCaseSummarizer({
        settings: { model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 5, maxElements: 300, maxOutputTokens: 4000, maxInputTokens: 100_000, retentionDays: 30 },
        instructions: buildSummaryInstructions('PROMPT', 'TYPOLOGY'),
        model: () => model,
        audit: () => mounted.sink,
        tokenKeys: () => ({ current: { kid: 'abcd1234', bytes: Buffer.alloc(32, 7) } }),
        runs: () => store,
        availability: () => ({ available: true }),
      });
      const actor = randomUUID();
      const investigationId = randomUUID();
      const node = { ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, display: { title: 'Ana Silva', type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
      const answer = await summarizer.summarize(
        {
          actorId: actor,
          actorRole: 'investigator',
          traceId: 'trace-click-1',
          policyVersion: 'p1',
          request: { investigationId, sourceId: 'demo', entities: [], edges: [], aggregates: [], derived: [] },
          reading: { nodes: [node], edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 },
        },
        new AbortController().signal,
      );
      expect(answer.status).toBe('ok');
      const runs = await rows(database.appUrl, 'SELECT id, actor_id, investigation_id, source_id, trace_id, outcome, calls, finished_at IS NOT NULL AS finished FROM summary_runs');
      expect(runs).toEqual([{ id: expect.any(String), actor_id: actor, investigation_id: investigationId, source_id: 'demo', trace_id: 'trace-click-1', outcome: 'ok', calls: 1, finished: true }]);
      const calls = await rows(database.appUrl, 'SELECT call_number, status, tokens_in, tokens_out, instructions_text, values_text, reply_text FROM summary_run_calls WHERE run_id = $1', [runs[0]?.['id']]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ call_number: 1, status: 'answered', tokens_in: 5, tokens_out: 2 });
      expect(String(calls[0]?.['instructions_text'])).toContain('PROMPT');
      expect(String(calls[0]?.['values_text'])).toContain('n1 |');
      expect(String(calls[0]?.['reply_text'])).toContain('A fixed sentence.');
      const events = await rows(database.appUrl, `SELECT action, detail FROM audit_events WHERE trace_id = 'trace-click-1' ORDER BY action`);
      expect(events.map((event) => event['action'])).toEqual(['ai.case-summary', 'ai.case-summary.closed']);
      const detail = (event: Record<string, unknown> | undefined) => event?.['detail'] as { ai?: { runId?: string }; summary?: { runId?: string } };
      expect(detail(events[0]).ai?.runId).toBe(runs[0]?.['id']);
      expect(detail(events[1]).summary?.runId).toBe(runs[0]?.['id']);
      expect(JSON.stringify(events)).not.toMatch(/A fixed sentence|PROMPT|Ana Silva/);
      expect(await attempt(database.appUrl, 'DELETE FROM summary_runs WHERE started_at < now() - interval \'1 day\'')).toBe('allowed');
    } finally {
      await store.close();
      await mounted.close();
    }
  });

  it('writes a call once however often it is written, and answers a fixed error when a write fails: the end of a call that was never started', async () => {
    const database = await migratedWithPreview();
    const store = createPgSummaryRunStore(contextOf(database));
    try {
      const id = randomUUID();
      await store.begin({ ...BASE, id, startedAt: new Date() });
      await store.beginCall(call(id, 1));
      await expect(store.beginCall(call(id, 1))).resolves.toBeUndefined();
      expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM summary_run_calls WHERE run_id = $1', [id])).toEqual([{ n: 1 }]);
      await expect(store.endCall({ runId: randomUUID(), number: 1, status: 'answered', durationMs: 1 })).rejects.toMatchObject({ code: 'SUMMARY_RUN_WRITE_FAILED' });
    } finally {
      await store.close();
    }
  });

  it('is added to a database migrated to 0005 by the next start, without a change to the earlier tables', async () => {
    const UNTIL_0005 = ['0001-audit-events.sql', '0002-ask-runs.sql', '0003-ask-plans.sql', '0004-drop-ask-plans.sql', '0005-ask-runs-intent.sql'];
    const until0005: ExtensionLoader = {
      load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: fixtureFolder(Object.fromEntries(UNTIL_0005.map((name) => [name, readFileSync(join(PREVIEW_MIGRATIONS, name), 'utf8')]))) }),
    };
    const database = await postgres.newDatabase();
    expect((await runInProcess(previewOn(database), SHIPPED, { extensionLoader: until0005 })).code).toBe(0);
    expect(await rows(database.ownerUrl, `SELECT to_regclass('public.summary_runs') IS NOT NULL AS runs`)).toEqual([{ runs: false }]);
    const migrated = await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader });
    expect([migrated.code, migrated.stderr]).toEqual([0, '']);
    expect(await rows(database.ownerUrl, `SELECT to_regclass('public.summary_runs') IS NOT NULL AS runs, to_regclass('public.summary_run_calls') IS NOT NULL AS calls`)).toEqual([{ runs: true, calls: true }]);
  });
});

describe('the assistant_runs and assistant_run_calls tables of the preview', () => {
  const contextOf = (database: TestDatabase) => ({ databaseUrl: database.appUrl, poolSize: 2, connectionTimeoutMs: 5000, statementTimeoutMs: 5000, queryTimeoutMs: 5000, newId: () => randomUUID(), onConnectionError: () => undefined });
  const BASE = { actorId: randomUUID(), sourceId: 'demo', traceId: 'tr-1', settings: { model: 'm' } };
  const call = (runId: string, number: number) => ({ runId, number, startedAt: new Date(), instructionsSha256: 'a'.repeat(64), instructionsText: 'INSTRUCTIONS', valuesText: 'VALUES' });

  it('has the columns of the data model, a cascade from the calls to the run, and no foreign key to the users table', async () => {
    const database = await migratedWithPreview();
    expect((await columnsOf(database, 'assistant_runs')).map((column) => column['column_name'])).toEqual(['id', 'actor_id', 'investigation_id', 'source_id', 'trace_id', 'started_at', 'finished_at', 'outcome', 'calls', 'settings']);
    expect((await columnsOf(database, 'assistant_run_calls')).map((column) => column['column_name'])).toEqual(['run_id', 'call_number', 'started_at', 'duration_ms', 'instructions_sha256', 'instructions_text', 'values_text', 'reply_text', 'status', 'failure_kind', 'tokens_in', 'tokens_out', 'error_class', 'error_code', 'error_type']);
    expect(await rows(database.ownerUrl, `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'assistant_run_calls'::regclass AND contype = 'f'`)).toEqual([{ definition: 'FOREIGN KEY (run_id) REFERENCES assistant_runs(id) ON DELETE CASCADE' }]);
    expect(await rows(database.ownerUrl, `SELECT 1 FROM pg_constraint WHERE conrelid = 'assistant_runs'::regclass AND contype = 'f'`)).toEqual([]);
  });

  it('is written, completed and removed by the real store through the application role, and a removal takes the calls with the run', async () => {
    const database = await migratedWithPreview();
    const store = createPgAssistantRunStore(contextOf(database));
    try {
      const startedAt = new Date('2026-10-01T00:00:00Z');
      const id = randomUUID();
      await store.begin({ ...BASE, id, startedAt });
      await store.begin({ ...BASE, id, startedAt });
      expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM assistant_runs WHERE id = $1', [id])).toEqual([{ n: 1 }]);
      await store.beginCall(call(id, 1));
      await store.beginCall(call(id, 1));
      expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM assistant_run_calls WHERE run_id = $1', [id])).toEqual([{ n: 1 }]);
      await store.endCall({ runId: id, number: 1, status: 'refused', replyText: 'REPLY', tokensIn: 5, tokensOut: 2, durationMs: 40 });
      await store.finish(id, 'failed', 1, new Date());
      expect(await rows(database.ownerUrl, 'SELECT outcome, calls FROM assistant_runs WHERE id = $1', [id])).toEqual([{ outcome: 'failed', calls: 1 }]);
      expect(await rows(database.ownerUrl, 'SELECT status, reply_text, tokens_in, duration_ms FROM assistant_run_calls WHERE run_id = $1', [id])).toEqual([{ status: 'refused', reply_text: 'REPLY', tokens_in: 5, duration_ms: 40 }]);
      await expect(store.endCall({ runId: randomUUID(), number: 1, status: 'answered', durationMs: 1 })).rejects.toMatchObject({ code: 'ASSISTANT_RUN_WRITE_FAILED' });
      expect(await store.removeStartedBefore(new Date(startedAt.getTime()))).toBe(0);
      expect(await attempt(database.appUrl, "UPDATE assistant_runs SET outcome = 'x' WHERE false")).toBe('allowed');
      expect(await store.removeStartedBefore(new Date(startedAt.getTime() + 1))).toBe(1);
      expect(await rows(database.ownerUrl, 'SELECT 1 FROM assistant_run_calls')).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('is added to a database migrated to 0006 by the next start, without a change to the earlier tables', async () => {
    const UNTIL_0006 = ['0001-audit-events.sql', '0002-ask-runs.sql', '0003-ask-plans.sql', '0004-drop-ask-plans.sql', '0005-ask-runs-intent.sql', '0006-summary-runs.sql'];
    const until0006: ExtensionLoader = {
      load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: fixtureFolder(Object.fromEntries(UNTIL_0006.map((name) => [name, readFileSync(join(PREVIEW_MIGRATIONS, name), 'utf8')]))) }),
    };
    const database = await postgres.newDatabase();
    expect((await runInProcess(previewOn(database), SHIPPED, { extensionLoader: until0006 })).code).toBe(0);
    expect(await rows(database.ownerUrl, `SELECT to_regclass('public.assistant_runs') IS NOT NULL AS runs`)).toEqual([{ runs: false }]);
    const migrated = await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader });
    expect([migrated.code, migrated.stderr]).toEqual([0, '']);
    expect(await rows(database.ownerUrl, `SELECT to_regclass('public.assistant_runs') IS NOT NULL AS runs, to_regclass('public.assistant_run_calls') IS NOT NULL AS calls`)).toEqual([{ runs: true, calls: true }]);
  });
});

describe('a start of the Community product', () => {
  it('creates neither table, and loads no preview migration', async () => {
    const database = await postgres.newDatabase();
    const result = await runInProcess(environment(database), SHIPPED);
    expect(result.code).toBe(0);
    const found = await rows(database.ownerUrl, `SELECT to_regclass('public.audit_events') IS NOT NULL AS audit, to_regclass('public.ask_runs') IS NOT NULL AS runs, to_regclass('public.summary_runs') IS NOT NULL AS summaries, to_regclass('public.assistant_runs') IS NOT NULL AS assistant`);
    expect(found).toEqual([{ audit: false, runs: false, summaries: false, assistant: false }]);
  });
});
