import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createPlanStore, type PlanStore } from '@neburyx/ee-ask';
import { createAuditSink } from '@neburyx/ee-audit';
import type { AuditSinkContext } from '@neburyx/contracts';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../identity/uuid.js';
import { clearRegisteredExtension, type ExtensionLoader } from './extension.js';
import { fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const PREVIEW_MIGRATIONS = fileURLToPath(new URL('../../../../ee/migrations', import.meta.url));
const PREVIEW_FILE = join(fixtureFolder({ 'neburyx.yaml': stringify({ sources: [], ai: { preview: true } }) }), 'neburyx.yaml');
const loader: ExtensionLoader = { load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: PREVIEW_MIGRATIONS }) };

let postgres: TestPostgres;
const open: PlanStore[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(open.map((store) => store.close()));
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

function storeFor(url: string): PlanStore {
  const context: AuditSinkContext = { databaseUrl: url, poolSize: 2, connectionTimeoutMs: 1000, statementTimeoutMs: 5000, queryTimeoutMs: 5000, newId: () => uuidv7(), onConnectionError: () => undefined };
  const store = createPlanStore(context);
  open.push(store);
  return store;
}

async function userIn(database: TestDatabase): Promise<string> {
  const id = uuidv7();
  await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'local', $2, 'Test user')`, [id, id]);
  return id;
}

const PLAN = { sourceId: 'demo', templateId: 'entity', templateVersion: 1, params: { entityRef: 'node_a' }, planningTraceId: 'tr-1' } as const;

async function setup() {
  const database = await migrated();
  const owner = await userIn(database);
  const other = await userIn(database);
  const store = storeFor(database.appUrl);
  return { database, owner, other, store };
}

async function stateOf(database: TestDatabase, id: string): Promise<string | undefined> {
  return (await rows(database.ownerUrl, 'SELECT state FROM ask_plans WHERE id = $1', [id]))[0]?.['state'] as string | undefined;
}

describe('the plan store over the preview tables', () => {
  it('refuses a claim of a plan that is not there, of another user, that was cancelled, that ran and that expired, and changes none of them', async () => {
    const { database, owner, other, store } = await setup();
    const proposed = await store.insert({ ...PLAN, userId: owner });
    expect(await store.claim(uuidv7(), owner)).toEqual({ status: 'absent' });
    expect(await store.claim(proposed.id, other)).toEqual({ status: 'absent' });
    expect(await stateOf(database, proposed.id)).toBe('proposed');

    const cancelled = await store.insert({ ...PLAN, userId: owner });
    expect(await store.cancel(cancelled.id, owner)).toEqual({ status: 'cancelled' });
    expect(await store.claim(cancelled.id, owner)).toEqual({ status: 'not-runnable' });

    const ran = await store.insert({ ...PLAN, userId: owner });
    expect((await store.claim(ran.id, owner)).status).toBe('claimed');
    expect(await store.finish({ planId: ran.id, userId: owner, outcome: 'complete', rowCount: 3, elapsedMs: 40 })).toMatchObject({ status: 'finished' });
    expect(await store.claim(ran.id, owner)).toEqual({ status: 'not-runnable' });

    const late = await store.insert({ ...PLAN, userId: owner });
    await rows(database.ownerUrl, `UPDATE ask_plans SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [late.id]);
    expect(await store.claim(late.id, owner)).toEqual({ status: 'expired' });
    expect(await stateOf(database, late.id)).toBe('expired');
    expect(await store.claim(late.id, owner)).toEqual({ status: 'expired' });
  });

  it('stores a plan as proposed with an expiry of fifteen minutes on the database clock and no text of a question', async () => {
    const { database, owner, store } = await setup();
    const plan = await store.insert({ ...PLAN, userId: owner });
    const [row] = await rows(database.ownerUrl, `SELECT state, expires_at - created_at AS lifetime, params FROM ask_plans WHERE id = $1`, [plan.id]);
    expect(row).toMatchObject({ state: 'proposed', params: { entityRef: 'node_a' } });
    expect(row?.['lifetime']).toMatchObject({ minutes: 15 });
    expect(plan.state).toBe('proposed');
  });

  it('lets exactly one of two claims of one plan succeed, and the other answers not-runnable', async () => {
    const { owner, store, database } = await setup();
    const second = storeFor(database.appUrl);
    for (let round = 0; round < 10; round += 1) {
      const plan = await store.insert({ ...PLAN, userId: owner });
      const results = await Promise.all([store.claim(plan.id, owner), second.claim(plan.id, owner)]);
      expect(results.map((result) => result.status).sort()).toEqual(['claimed', 'not-runnable']);
    }
  });

  it('lets exactly one of a claim and a cancel of one plan succeed', async () => {
    const { owner, store, database } = await setup();
    const second = storeFor(database.appUrl);
    for (let round = 0; round < 10; round += 1) {
      const plan = await store.insert({ ...PLAN, userId: owner });
      const [claim, cancel] = await Promise.all([store.claim(plan.id, owner), second.cancel(plan.id, owner)]);
      expect([claim.status === 'claimed', cancel.status === 'cancelled'].filter(Boolean)).toHaveLength(1);
      expect(claim.status === 'claimed' ? cancel.status : claim.status).toBe('not-runnable');
    }
  });

  it('lets an edit and a claim of one plan race with one winner: a lost edit leaves no new plan, a lost claim leaves the old one cancelled', async () => {
    const { owner, store, database } = await setup();
    const second = storeFor(database.appUrl);
    for (let round = 0; round < 10; round += 1) {
      const plan = await store.insert({ ...PLAN, userId: owner });
      const [claim, edit] = await Promise.all([store.claim(plan.id, owner), second.edit({ planId: plan.id, userId: owner, templateId: 'expand', templateVersion: 1, params: { hops: 1 } })]);
      expect([claim.status === 'claimed', edit.status === 'edited'].filter(Boolean)).toHaveLength(1);
      const children = await rows(database.ownerUrl, 'SELECT state FROM ask_plans WHERE parent_plan_id = $1', [plan.id]);
      if (edit.status === 'edited') {
        expect(await stateOf(database, plan.id)).toBe('cancelled');
        expect(children).toEqual([{ state: 'proposed' }]);
        expect(claim.status).toBe('not-runnable');
      } else {
        expect(await stateOf(database, plan.id)).toBe('confirmed');
        expect(children).toEqual([]);
        expect(edit.status).toBe('not-runnable');
      }
    }
  });

  it('edits a plan: the old one is cancelled, the new one has it as its parent and the same source, owner and planning trace', async () => {
    const { database, owner, other, store } = await setup();
    const plan = await store.insert({ ...PLAN, userId: owner });
    expect(await store.edit({ planId: plan.id, userId: other, templateId: 'expand', templateVersion: 1, params: {} })).toEqual({ status: 'absent' });
    expect(await stateOf(database, plan.id)).toBe('proposed');
    const edited = await store.edit({ planId: plan.id, userId: owner, templateId: 'expand', templateVersion: 2, params: { hops: 2 } });
    expect(edited).toMatchObject({ status: 'edited', plan: { parentPlanId: plan.id, sourceId: 'demo', userId: owner, planningTraceId: 'tr-1', templateId: 'expand', templateVersion: 2, state: 'proposed', params: { hops: 2 } } });
    expect(await stateOf(database, plan.id)).toBe('cancelled');
    expect(await store.edit({ planId: plan.id, userId: owner, templateId: 'expand', templateVersion: 2, params: {} })).toEqual({ status: 'not-runnable' });
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM ask_plans')).toEqual([{ n: 2 }]);
  });

  it('writes the run row with the plan becoming run, and not twice', async () => {
    const { database, owner, store } = await setup();
    const plan = await store.insert({ ...PLAN, userId: owner });
    expect(await store.finish({ planId: plan.id, userId: owner, outcome: 'partial', rowCount: 5, elapsedMs: 12 })).toEqual({ status: 'not-runnable' });
    expect((await store.claim(plan.id, owner)).status).toBe('claimed');
    const finished = await store.finish({ planId: plan.id, userId: owner, outcome: 'partial', rowCount: 5, elapsedMs: 12 });
    expect(finished.status).toBe('finished');
    expect(await store.finish({ planId: plan.id, userId: owner, outcome: 'partial', rowCount: 5, elapsedMs: 12 })).toEqual({ status: 'not-runnable' });
    expect(await rows(database.ownerUrl, 'SELECT plan_id, actor_id, outcome, row_count, elapsed_ms FROM ask_runs')).toEqual([{ plan_id: plan.id, actor_id: owner, outcome: 'partial', row_count: 5, elapsed_ms: 12 }]);
    expect(await stateOf(database, plan.id)).toBe('run');
  });

  it('rolls the plan back to confirmed when the run row is refused, so the finish can be tried again', async () => {
    const { database, owner, store } = await setup();
    const plan = await store.insert({ ...PLAN, userId: owner });
    await store.claim(plan.id, owner);
    await expect(store.finish({ planId: plan.id, userId: owner, outcome: 'complete', rowCount: -1, elapsedMs: 1 })).rejects.toMatchObject({ code: 'PLAN_STORE_FAILED' });
    expect(await stateOf(database, plan.id)).toBe('confirmed');
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM ask_runs')).toEqual([{ n: 0 }]);
  });
});

const SEARCH = { sourceId: 'demo', templateId: 'search', templateVersion: 1, params: { entityTypes: ['node_a'], text: 'ref 77-typed' }, planningTraceId: 'tr-1' } as const;

async function paramsOf(database: TestDatabase, id: string): Promise<unknown> {
  return (await rows(database.ownerUrl, 'SELECT params FROM ask_plans WHERE id = $1', [id]))[0]?.['params'];
}

describe('releasing a plan', () => {
  it('moves a confirmed plan back to proposed with its expiry and parameters as they were, and no run row', async () => {
    const { database, owner, store } = await setup();
    const plan = await store.insert({ ...PLAN, userId: owner });
    const [before] = await rows(database.ownerUrl, 'SELECT expires_at, params FROM ask_plans WHERE id = $1', [plan.id]);
    await store.claim(plan.id, owner);
    expect(await store.release(plan.id, owner)).toBe(true);
    const [after] = await rows(database.ownerUrl, 'SELECT state, expires_at, params FROM ask_plans WHERE id = $1', [plan.id]);
    expect(after).toEqual({ state: 'proposed', expires_at: before?.['expires_at'], params: before?.['params'] });
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM ask_runs')).toEqual([{ n: 0 }]);
    expect((await store.claim(plan.id, owner)).status).toBe('claimed');
  });

  it('changes nothing for a plan that is proposed, cancelled, run, another user\u2019s or not there', async () => {
    const { database, owner, other, store } = await setup();
    const proposed = await store.insert({ ...PLAN, userId: owner });
    const cancelled = await store.insert({ ...PLAN, userId: owner });
    await store.cancel(cancelled.id, owner);
    const ran = await store.insert({ ...PLAN, userId: owner });
    await store.claim(ran.id, owner);
    await store.finish({ planId: ran.id, userId: owner, outcome: 'complete', rowCount: 0, elapsedMs: 1 });
    const mine = await store.insert({ ...PLAN, userId: owner });
    await store.claim(mine.id, owner);
    for (const id of [proposed.id, cancelled.id, ran.id, uuidv7()]) expect(await store.release(id, owner)).toBe(false);
    expect(await store.release(mine.id, other)).toBe(false);
    expect(await stateOf(database, mine.id)).toBe('confirmed');
    expect([await stateOf(database, proposed.id), await stateOf(database, cancelled.id), await stateOf(database, ran.id)]).toEqual(['proposed', 'cancelled', 'run']);
  });

  it('lets exactly one of a release and a finish of one claimed plan win', async () => {
    const { owner, store, database } = await setup();
    const second = storeFor(database.appUrl);
    for (let round = 0; round < 10; round += 1) {
      const plan = await store.insert({ ...PLAN, userId: owner });
      await store.claim(plan.id, owner);
      const [released, finished] = await Promise.all([store.release(plan.id, owner), second.finish({ planId: plan.id, userId: owner, outcome: 'complete', rowCount: 0, elapsedMs: 1 })]);
      expect([released, finished.status === 'finished'].filter(Boolean)).toHaveLength(1);
    }
  });
});

describe('the typed value of a search plan', () => {
  it('is held while the plan can run, and no longer once it is claimed, which gives the run the value it had', async () => {
    const { database, owner, store } = await setup();
    const plan = await store.insert({ ...SEARCH, userId: owner });
    expect(await paramsOf(database, plan.id)).toEqual({ entityTypes: ['node_a'], text: 'ref 77-typed' });
    const claim = await store.claim(plan.id, owner);
    expect(claim).toMatchObject({ status: 'claimed', plan: { params: { entityTypes: ['node_a'], text: 'ref 77-typed' } } });
    expect(await paramsOf(database, plan.id)).toEqual({ entityTypes: ['node_a'] });
    await store.finish({ planId: plan.id, userId: owner, outcome: 'complete', rowCount: 1, elapsedMs: 1 });
    expect(await paramsOf(database, plan.id)).toEqual({ entityTypes: ['node_a'] });
  });

  it('is gone from the row of a cancelled plan, of the old plan of an edit, and of a plan that was marked expired by a read; the new plan of an edit holds its own until it too leaves proposed', async () => {
    const { database, owner, store } = await setup();
    const cancelled = await store.insert({ ...SEARCH, userId: owner });
    await store.cancel(cancelled.id, owner);
    const old = await store.insert({ ...SEARCH, userId: owner });
    const edited = await store.edit({ planId: old.id, userId: owner, templateId: 'search', templateVersion: 1, params: { entityTypes: ['node_a'], text: 'second-typed' } });
    const late = await store.insert({ ...SEARCH, userId: owner });
    await rows(database.ownerUrl, `UPDATE ask_plans SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [late.id]);
    await store.claim(late.id, owner);
    for (const id of [cancelled.id, old.id, late.id]) expect(await paramsOf(database, id)).toEqual({ entityTypes: ['node_a'] });
    if (edited.status !== 'edited') throw new Error('not edited');
    expect(await paramsOf(database, edited.plan.id)).toEqual({ entityTypes: ['node_a'], text: 'second-typed' });
    await store.cancel(edited.plan.id, owner);
    expect(await paramsOf(database, edited.plan.id)).toEqual({ entityTypes: ['node_a'] });
  });

  it('is removed by the sweep from plans that expired unread, once, and an unexpired plan is left alone', async () => {
    const { database, owner, store } = await setup();
    const expired = await store.insert({ ...SEARCH, userId: owner });
    const alive = await store.insert({ ...SEARCH, userId: owner });
    await rows(database.ownerUrl, `UPDATE ask_plans SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [expired.id]);
    expect(await store.sweep(500)).toBe(1);
    expect(await paramsOf(database, expired.id)).toEqual({ entityTypes: ['node_a'] });
    expect(await stateOf(database, expired.id)).toBe('expired');
    expect(await paramsOf(database, alive.id)).toEqual({ entityTypes: ['node_a'], text: 'ref 77-typed' });
    expect(await stateOf(database, alive.id)).toBe('proposed');
    expect(await store.sweep(500)).toBe(0);
  });

  it('is cleared by a sweep in batches: at most the limit at once, oldest first', async () => {
    const { database, owner, store } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push((await store.insert({ ...SEARCH, userId: owner })).id);
    await rows(database.ownerUrl, `UPDATE ask_plans SET expires_at = clock_timestamp() - interval '1 minute'`);
    expect(await store.sweep(2)).toBe(2);
    expect(await store.sweep(2)).toBe(2);
    expect(await store.sweep(2)).toBe(1);
    expect(await store.sweep(2)).toBe(0);
    for (const id of ids) expect(await paramsOf(database, id)).toEqual({ entityTypes: ['node_a'] });
  });

  it('does not touch the parameters of a plan of another template', async () => {
    const { database, owner, store } = await setup();
    const plan = await store.insert({ ...PLAN, userId: owner });
    await store.cancel(plan.id, owner);
    expect(await paramsOf(database, plan.id)).toEqual({ entityRef: 'node_a' });
  });

  it('lets two claims of one search plan race with one winner and the value in the row removed', async () => {
    const { database, owner, store } = await setup();
    const second = storeFor(database.appUrl);
    const plan = await store.insert({ ...SEARCH, userId: owner });
    const results = await Promise.all([store.claim(plan.id, owner), second.claim(plan.id, owner)]);
    expect(results.map((result) => result.status).sort()).toEqual(['claimed', 'not-runnable']);
    const claimed = results.find((result) => result.status === 'claimed');
    expect(claimed).toMatchObject({ plan: { params: { text: 'ref 77-typed' } } });
    expect(await paramsOf(database, plan.id)).toEqual({ entityTypes: ['node_a'] });
  });
});

describe('the audit events of a plan and of its run', () => {
  it('finds the events of the planning call by the trace ID of the plan, and writes the run event with a template, a hash and a count and no value', async () => {
    const { database, owner } = await setup();
    const audit = createAuditSink({ databaseUrl: database.appUrl, poolSize: 2, connectionTimeoutMs: 1000, statementTimeoutMs: 5000, queryTimeoutMs: 5000, newId: () => uuidv7(), onConnectionError: () => undefined });
    try {
      await audit.sink.record({ actorId: owner, actorRole: 'investigator', action: 'ask.plan', result: 'success', sourceId: 'demo', traceId: 'tr-plan-1', detail: { ai: { modelRef: 'model-a', promptId: 'ask.plan', promptVersion: '3', promptSha256: 'a'.repeat(64), tokensIn: 3 as never, tokensOut: 4 as never } } });
      await audit.sink.record({ actorId: owner, actorRole: 'investigator', action: 'ask.run', result: 'success', sourceId: 'demo', resourceType: 'ask-plan', resourceRef: uuidv7(), traceId: 'tr-run-1', detail: { askRun: { templateId: 'search', templateVersion: 1, paramsHash: 'b'.repeat(64), rowCount: 3 } } });
      await expect(audit.sink.record({ actorId: owner, actorRole: 'investigator', action: 'ask.run', result: 'success', traceId: 'tr-run-2', detail: { askRun: { templateId: 'search', templateVersion: 1, paramsHash: 'b'.repeat(64), rowCount: 3, params: { text: 'x' } } } as never })).rejects.toMatchObject({ code: 'AUDIT_DETAIL_REFUSED' });
    } finally {
      await audit.close();
    }
    const planning = await rows(database.ownerUrl, `SELECT action, detail FROM audit_events WHERE trace_id = $1 AND action IN ('ask.plan', 'ask.plan.repair')`, ['tr-plan-1']);
    expect(planning).toEqual([{ action: 'ask.plan', detail: expect.objectContaining({ ai: expect.objectContaining({ modelRef: 'model-a' }) }) }]);
    const runEvents = await rows(database.ownerUrl, `SELECT result, detail FROM audit_events WHERE action = 'ask.run'`);
    expect(runEvents).toEqual([{ result: 'success', detail: { askRun: { templateId: 'search', templateVersion: 1, paramsHash: 'b'.repeat(64), rowCount: 3 } } }]);
    expect(JSON.stringify(runEvents)).not.toContain('typed');
  });
});

