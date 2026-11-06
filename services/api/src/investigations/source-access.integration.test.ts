import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openInvestigationResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { testSourceGate } from '../testing/source-gate.js';
import { webRoot } from '../testing/start-api.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' }], relationships: [{ type: 'LINKS', from: 'widget', to: 'gadget' }] })), 'neburyx.yaml');
const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });
const request = (overrides: Record<string, unknown> = {}) => ({ sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, ...overrides });

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

async function running() {
  const database = await postgres.newDatabase();
  expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
  const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  let closing: Promise<void> | undefined;
  const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
  stores.push(store);
  await store.initialize();
  await store.syncSources(mapping.sources);
  let answer: ExecuteOutcome = entityRows(WIDGET);
  let allowed = true;
  const defaults = communitySeams();
  const seams: Seams = { ...defaults, policy: { authorizeSource: async () => (allowed ? { allowed: true } : { allowed: false, reason: 'not permitted' }) } };
  const executor = new TestExecutor(() => Promise.resolve(answer));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, seams, gate: testSourceGate(mapping, { executor, seams }).gate });
  const post = (payload: object) => app.inject({ method: 'POST', url: '/v1/investigations', payload });
  const counts = async () => ({ investigations: Number((await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM investigations'))[0]?.['n']), drafts: Number((await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM saved_views'))[0]?.['n']) });
  return { app, post, counts, executor, answer: (next: ExecuteOutcome) => void (answer = next), allow: (next: boolean) => void (allowed = next), all: () => rows(database.ownerUrl, 'SELECT * FROM investigations') };
}

describe('opening against Postgres when access changes', () => {
  it('answers NOT_FOUND, reads nothing and leaves the rows as they were, for the case reference of an investigation in a source the person may no longer read', async () => {
    const { app, post, executor, allow, all, counts } = await running();
    expect((await post(request({ caseRef: 'CASE-1' }))).statusCode).toBe(201);
    const before = JSON.stringify([await all(), await counts()]);
    allow(false);
    executor.calls.length = 0;
    const response = await post(request({ caseRef: 'CASE-1' }));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(executor.calls).toEqual([]);
    expect(JSON.stringify([await all(), await counts()])).toBe(before);
    await app.close();
  });

  it('writes nothing when the read fails, and the identical request sent again makes exactly one investigation and one draft', async () => {
    const { app, post, answer, counts } = await running();
    answer({ status: 'timeout' });
    expect((await post(request())).statusCode).toBe(504);
    expect(await counts()).toEqual({ investigations: 0, drafts: 0 });
    answer(entityRows(WIDGET));
    const retried = await post(request());
    expect(retried.statusCode).toBe(201);
    expect(openInvestigationResponseSchema.parse(retried.json()).created).toBe(true);
    expect(await counts()).toEqual({ investigations: 1, drafts: 1 });
    await app.close();
  });

  it('returns the existing investigation and answers 200 when the retried request carries a case reference the person already has', async () => {
    const { app, post, answer, counts } = await running();
    const created = openInvestigationResponseSchema.parse((await post(request({ caseRef: 'CASE-1' }))).json());
    answer({ status: 'timeout' });
    expect((await post(request({ caseRef: 'CASE-1' }))).statusCode).toBe(504);
    answer(entityRows(WIDGET));
    const retried = await post(request({ caseRef: 'CASE-1' }));
    expect(retried.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(retried.json())).toMatchObject({ created: false, investigation: { id: created.investigation.id } });
    expect(await counts()).toEqual({ investigations: 1, drafts: 1 });
    await app.close();
  });
});
