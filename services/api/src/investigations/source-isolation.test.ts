import { rmSync } from 'node:fs';
import { investigationResponseSchema, openInvestigationResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityCalls, entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const entities = [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' }];
const relationships = [{ type: 'LINKS', from: 'widget', to: 'gadget' }];
const north = baseSource({ id: 'north', uri: 'neo4j+s://north.example.test:7687', entities, relationships });
const south = baseSource({ id: 'south', uri: 'neo4j+s://south.example.test:7687', entities, relationships });
const mapping = parseMapping(fileOf(north, south), 'neburyx.yaml');
const movedSouth = parseMapping(fileOf(north, { ...south, uri: 'neo4j+s://elsewhere.example.test:7687' }), 'neburyx.yaml');

const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });
const request = (sourceId: string, overrides: Record<string, unknown> = {}) => ({ sourceId, entity: { sourceId, entityType: 'widget', stableId: 'W-1' }, ...overrides });

type Answer = (call: ExecuteCall) => ExecuteOutcome;

async function started(answer: Answer = () => entityRows(WIDGET), appMapping = mapping, store = memoryAppStore()) {
  const executor = new TestExecutor((call) => Promise.resolve(answer(call)));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: appMapping, gate: testSourceGate(appMapping, { executor }).gate });
  const post = (payload: object) => app.inject({ method: 'POST', url: '/v1/investigations', payload });
  const get = (url: string) => app.inject({ method: 'GET', url });
  return { app, store, executor, post, get };
}

const snapshot = (store: ReturnType<typeof memoryAppStore>, sourceId: string): string =>
  JSON.stringify({ rows: store.investigations.filter((row) => row.sourceId === sourceId), drafts: store.drafts.filter((draft) => store.investigations.some((row) => row.id === draft.investigationId && row.sourceId === sourceId)) });

const timeoutOnSouth: Answer = (call) => (call.sourceId === 'south' ? { status: 'timeout' } : entityRows(WIDGET));

describe('opening an entity of one source with another source configured', () => {
  it('answers 504 QUERY_TIMEOUT when the second source cannot be read, writes nothing, leaves the first source’s rows as they were, and still opens in the first', async () => {
    const { app, store, post } = await started(timeoutOnSouth);
    expect((await post(request('north', { caseRef: 'CASE-1' }))).statusCode).toBe(201);
    const before = snapshot(store, 'north');
    const rowsBefore = store.investigations.length;
    const response = await post(request('south'));
    expect(response.statusCode).toBe(504);
    expect(response.json().error).toMatchObject({ code: 'QUERY_TIMEOUT', retryable: true });
    expect(store.investigations).toHaveLength(rowsBefore);
    expect(snapshot(store, 'north')).toBe(before);
    expect((await post(request('north'))).statusCode).toBe(201);
    await app.close();
  });

  it('refuses a request that names one source and a reference that names the other, before any read or write', async () => {
    const { app, store, executor, post } = await started();
    const response = await post({ sourceId: 'north', entity: { sourceId: 'south', entityType: 'widget', stableId: 'W-1' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('SOURCE_MISMATCH');
    expect(executor.calls).toEqual([]);
    expect(store.investigations).toEqual([]);
    expect(store.drafts).toEqual([]);
    await app.close();
  });

  it('leaves the first source’s investigation and draft as they were, and reads only the second source, when an entity of the second is opened', async () => {
    const { app, store, executor, post } = await started();
    const first = openInvestigationResponseSchema.parse((await post(request('north'))).json());
    const before = snapshot(store, 'north');
    executor.calls.length = 0;
    const response = await post(request('south'));
    expect(response.statusCode).toBe(201);
    const second = openInvestigationResponseSchema.parse(response.json());
    expect(second.investigation).toMatchObject({ sourceId: 'south', sourceState: 'available' });
    expect(second.investigation.id).not.toBe(first.investigation.id);
    expect(second).toMatchObject({ entity: { ref: { sourceId: 'south', entityType: 'widget', stableId: 'W-1' } } });
    expect(entityCalls(executor.calls).map((call) => call.sourceId)).toEqual(['south']);
    expect(snapshot(store, 'north')).toBe(before);
    expect(store.investigations.filter((row) => row.sourceId === 'south')).toHaveLength(1);
    expect(store.drafts.filter((draft) => draft.investigationId === second.investigation.id)).toHaveLength(1);
    await app.close();
  });

  it('makes a new investigation in the second source for the same case reference, type and stable ID, and reuses it there only', async () => {
    const { app, store, post } = await started();
    const first = openInvestigationResponseSchema.parse((await post(request('north', { caseRef: 'CASE-1' }))).json());
    const before = snapshot(store, 'north');
    const opened = await post(request('south', { caseRef: 'CASE-1' }));
    expect(opened.statusCode).toBe(201);
    const second = openInvestigationResponseSchema.parse(opened.json());
    expect(second).toMatchObject({ created: true, investigation: { sourceId: 'south', caseRef: 'CASE-1' } });
    expect(second.investigation.id).not.toBe(first.investigation.id);
    expect(snapshot(store, 'north')).toBe(before);
    const again = await post(request('south', { caseRef: 'CASE-1' }));
    expect(again.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(again.json())).toMatchObject({ created: false, investigation: { id: second.investigation.id } });
    expect(store.investigations).toHaveLength(2);
    await app.close();
  });
});

describe('reading with another source configured', () => {
  it('answers each investigation with its own source, and a repointed second source leaves the first available', async () => {
    const parts = await started();
    const first = openInvestigationResponseSchema.parse((await parts.post(request('north'))).json());
    const second = openInvestigationResponseSchema.parse((await parts.post(request('south'))).json());
    for (const [created, sourceId] of [[first, 'north'], [second, 'south']] as const) {
      const read = investigationResponseSchema.parse((await parts.get(`/v1/investigations/${created.investigation.id}`)).json());
      expect(read.investigation).toMatchObject({ id: created.investigation.id, sourceId, sourceState: 'available' });
    }
    await parts.app.close();
    const moved = await started(undefined, movedSouth, parts.store);
    const states = await Promise.all([first, second].map(async (created) => investigationResponseSchema.parse((await moved.get(`/v1/investigations/${created.investigation.id}`)).json()).investigation.sourceState));
    expect(states).toEqual(['available', 'repointed']);
    expect(moved.executor.calls).toEqual([]);
    await moved.app.close();
  });

  it('answers a node of the source in the path when both sources hold the same type and stable ID', async () => {
    const { app, executor, get } = await started();
    for (const sourceId of ['north', 'south']) {
      executor.calls.length = 0;
      const response = await get(`/v1/entities/${sourceId}/widget/W-1`);
      expect(response.statusCode).toBe(200);
      expect(response.json().ref).toEqual({ sourceId, entityType: 'widget', stableId: 'W-1' });
      expect(executor.calls.map((call) => call.sourceId)).toEqual([sourceId]);
    }
    await app.close();
  });
});
