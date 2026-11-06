import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openInvestigationResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { testSourceGate } from '../testing/source-gate.js';
import { webRoot } from '../testing/start-api.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const entities = [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' }];
const relationships = [{ type: 'LINKS', from: 'widget', to: 'gadget' }];
const mapping = parseMapping(
  fileOf(
    baseSource({ id: 'north', uri: 'neo4j+s://north.example.test:7687', entities, relationships }),
    baseSource({ id: 'south', uri: 'neo4j+s://south.example.test:7687', entities, relationships }),
  ),
  'neburyx.yaml',
);
const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });

let postgres: TestPostgres;
const stores: AppStore[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

async function running(answer: (call: ExecuteCall) => ExecuteOutcome = () => entityRows(WIDGET)) {
  const database = await postgres.newDatabase();
  expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
  const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  let closing: Promise<void> | undefined;
  const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
  stores.push(store);
  await store.initialize();
  await store.syncSources(mapping.sources);
  const executor = new TestExecutor((call) => Promise.resolve(answer(call)));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor }).gate });
  const post = (payload: object) => app.inject({ method: 'POST', url: '/v1/investigations', payload });
  const stored = (sourceId: string) => rows(database.ownerUrl, 'SELECT * FROM investigations WHERE source_id = $1 ORDER BY id', [sourceId]);
  const drafts = (sourceId: string) => rows(database.ownerUrl, 'SELECT v.* FROM saved_views v JOIN investigations i ON i.id = v.investigation_id WHERE i.source_id = $1 ORDER BY v.id', [sourceId]);
  return { app, post, stored, drafts, executor };
}

const request = (sourceId: string, overrides: Record<string, unknown> = {}) => ({ sourceId, entity: { sourceId, entityType: 'widget', stableId: 'W-1' }, ...overrides });

describe('opening in a second source against Postgres', () => {
  it('leaves every column of the first investigation and its draft as they were, and stores the second under its own source', async () => {
    const { app, post, stored, drafts } = await running();
    expect((await post(request('north', { caseRef: 'CASE-1' }))).statusCode).toBe(201);
    const before = JSON.stringify([await stored('north'), await drafts('north')]);
    const opened = openInvestigationResponseSchema.parse((await post(request('south'))).json());
    expect(JSON.stringify([await stored('north'), await drafts('north')])).toBe(before);
    expect(await stored('south')).toHaveLength(1);
    expect((await stored('south'))[0]).toMatchObject({ id: opened.investigation.id, source_id: 'south' });
    expect(await drafts('south')).toMatchObject([{ investigation_id: opened.investigation.id, kind: 'draft' }]);
    await app.close();
  });

  it('makes a second investigation for the same case reference, type and stable ID in the other source, and reuses it there only', async () => {
    const { app, post, stored } = await running();
    const first = openInvestigationResponseSchema.parse((await post(request('north', { caseRef: 'CASE-1' }))).json());
    const before = JSON.stringify(await stored('north'));
    const second = await post(request('south', { caseRef: 'CASE-1' }));
    expect(second.statusCode).toBe(201);
    const created = openInvestigationResponseSchema.parse(second.json());
    expect(created.investigation.id).not.toBe(first.investigation.id);
    expect(JSON.stringify(await stored('north'))).toBe(before);
    const again = await post(request('south', { caseRef: 'CASE-1' }));
    expect(again.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(again.json())).toMatchObject({ created: false, investigation: { id: created.investigation.id } });
    await app.close();
  });

  it('writes nothing for a reference that names the other source, and nothing when the second source times out, and leaves the first source’s rows as they were', async () => {
    const { app, post, stored, drafts, executor } = await running((call) => (call.sourceId === 'south' ? { status: 'timeout' } : entityRows(WIDGET)));
    expect((await post(request('north'))).statusCode).toBe(201);
    const before = JSON.stringify([await stored('north'), await drafts('north')]);
    executor.calls.length = 0;
    const mismatch = await post({ sourceId: 'north', entity: { sourceId: 'south', entityType: 'widget', stableId: 'W-1' } });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('SOURCE_MISMATCH');
    expect(executor.calls).toEqual([]);
    const timeout = await post(request('south'));
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json().error).toMatchObject({ code: 'QUERY_TIMEOUT', retryable: true });
    expect(await stored('south')).toEqual([]);
    expect(await drafts('south')).toEqual([]);
    expect(JSON.stringify([await stored('north'), await drafts('north')])).toBe(before);
    expect((await post(request('north'))).statusCode).toBe(201);
    await app.close();
  });
});
