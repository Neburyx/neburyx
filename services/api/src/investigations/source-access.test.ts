import { rmSync } from 'node:fs';
import { investigationResponseSchema, openInvestigationResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Decision, PolicyProvider, Seams } from '../seams/seams.js';
import { memoryAppStore, type MemoryAppStore } from '../testing/app-store.js';
import { entityCalls, entityRows, plainNode } from '../testing/entity-fixtures.js';
import { recordingObserver, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const entities = [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' }];
const relationships = [{ type: 'LINKS', from: 'widget', to: 'gadget' }];
const sources = [
  baseSource({ id: 'open', uri: 'neo4j+s://open.example.test:7687', entities, relationships }),
  baseSource({ id: 'secret', uri: 'neo4j+s://secret.example.test:7687', entities, relationships }),
];
const mapping = parseMapping(fileOf(...sources), 'neburyx.yaml');
const movedOpen = parseMapping(fileOf({ ...sources[0], uri: 'neo4j+s://elsewhere.example.test:7687' }, sources[1] ?? {}), 'neburyx.yaml');
const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });
const request = (sourceId: string, overrides: Record<string, unknown> = {}, entityType = 'widget') => ({ sourceId, entity: { sourceId, entityType, stableId: 'W-1' }, ...overrides });

type Rule = (sourceId: string, ask: number) => boolean;
const EXCEPT_SECRET: Rule = (sourceId) => sourceId !== 'secret';

function injectors(app: Awaited<ReturnType<typeof buildApp>>) {
  return {
    post: (payload: object) => app.inject({ method: 'POST', url: '/v1/investigations', payload }),
    get: (url: string) => app.inject({ method: 'GET', url }),
  };
}

interface Started {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly store: MemoryAppStore;
  readonly executor: TestExecutor;
  readonly events: AuditEvent[];
  readonly asks: string[];
  readonly auditStages: () => number;
  readonly post: ReturnType<typeof injectors>['post'];
  readonly get: ReturnType<typeof injectors>['get'];
}

async function started(rule: Rule = EXCEPT_SECRET, answer: ExecuteOutcome = entityRows(WIDGET), options: { readonly mapping?: typeof mapping; readonly store?: MemoryAppStore; readonly failAudit?: boolean } = {}): Promise<Started> {
  const events: AuditEvent[] = [];
  const asks: string[] = [];
  const policy: PolicyProvider = {
    authorizeSource: async ({ sourceId }): Promise<Decision> => {
      asks.push(sourceId);
      return rule(sourceId, asks.length) ? { allowed: true } : { allowed: false, reason: 'not permitted' };
    },
  };
  const defaults = communitySeams();
  const seams: Seams = { ...defaults, policy, audit: { record: async (event) => (options.failAudit === true ? Promise.reject(new Error('sink down')) : void events.push(event)) } };
  const used = options.mapping ?? mapping;
  const store = options.store ?? memoryAppStore();
  const executor = new TestExecutor(withOnlineIndexes(used.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), () => Promise.resolve(answer)));
  const observer = recordingObserver();
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: used, seams, gate: testSourceGate(used, { executor, seams, observer }).gate });
  return { app, store, executor, events, asks, auditStages: () => observer.events.filter((entry) => entry.stage === 'audit').length, ...injectors(app) };
}

const withoutTrace = (body: { error: object }): string => JSON.stringify({ ...body, error: { ...body.error, traceId: undefined } });

describe('a source the person may not read', () => {
  it('answers an open as a source that is not configured and as an entity the source does not hold: one status, one body, no read, no row', async () => {
    const { app, post, store, executor } = await started();
    const missing = await started(EXCEPT_SECRET, entityRows());
    const unreadable = await Promise.all([post(request('secret')), post(request('secret', {}, 'nothing')), post(request('secret', { caseRef: 'CASE-1' }))]);
    const unconfigured = await post(request('nowhere'));
    const absent = await missing.post(request('open'));
    for (const response of [...unreadable, unconfigured, absent]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    }
    const bodies = [...unreadable, unconfigured, absent].map((response) => withoutTrace(response.json()));
    expect(new Set(bodies).size).toBe(1);
    expect(unreadable.map((response) => response.rawPayload.length)).toEqual(unreadable.map(() => unconfigured.rawPayload.length));
    expect(executor.calls).toEqual([]);
    expect(store.investigations).toEqual([]);
    expect(store.drafts).toEqual([]);
    await app.close();
    await missing.app.close();
  });

  it('answers an entity read as an unconfigured source and as a missing entity, whatever the type and ID', async () => {
    const { app, get, executor } = await started();
    const missing = await started(EXCEPT_SECRET, entityRows());
    const responses = await Promise.all([get('/v1/entities/secret/widget/W-1'), get('/v1/entities/secret/nothing/anything'), get('/v1/entities/nowhere/widget/W-1'), missing.get('/v1/entities/open/widget/W-1')]);
    for (const response of responses) expect(response.statusCode).toBe(404);
    expect(new Set(responses.map((response) => withoutTrace(response.json()))).size).toBe(1);
    expect(executor.calls).toEqual([]);
    await app.close();
    await missing.app.close();
  });

  it('does not return the investigation of the same case reference that the person owns, and reads nothing', async () => {
    let denySecret = false;
    const store = memoryAppStore();
    const first = await started((sourceId) => sourceId !== 'secret' || !denySecret, entityRows(WIDGET), { store });
    expect((await first.post(request('secret', { caseRef: 'CASE-1' }))).statusCode).toBe(201);
    const rows = JSON.stringify([store.investigations, store.drafts]);
    denySecret = true;
    first.executor.calls.length = 0;
    const again = await first.post(request('secret', { caseRef: 'CASE-1' }));
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('NOT_FOUND');
    expect(first.executor.calls).toEqual([]);
    expect(JSON.stringify([store.investigations, store.drafts])).toBe(rows);
    await first.app.close();
  });

  it('answers a readable source that now points elsewhere with its repointed investigation, no entity and no read', async () => {
    const store = memoryAppStore();
    const first = await started(EXCEPT_SECRET, entityRows(WIDGET), { store });
    expect((await first.post(request('open', { caseRef: 'CASE-1' }))).statusCode).toBe(201);
    await first.app.close();
    const moved = await started(EXCEPT_SECRET, entityRows(WIDGET), { store, mapping: movedOpen });
    const response = await moved.post(request('open', { caseRef: 'CASE-1' }));
    expect(response.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(response.json())).toMatchObject({ created: false, investigation: { sourceState: 'repointed' } });
    expect(response.json()).not.toHaveProperty('entity');
    expect(moved.executor.calls).toEqual([]);
    await moved.app.close();
  });

  it('answers an open the same when the policy allows both checks in front and the gate refuses the read, with no read and no row, and the gate records the one denial', async () => {
    const { app, post, store, executor, events, asks, auditStages } = await started((sourceId, ask) => sourceId !== 'secret' || ask < 3);
    const refused = await post(request('secret'));
    const unconfigured = await post(request('nowhere'));
    expect(asks.slice(0, 3)).toEqual(['secret', 'secret', 'secret']);
    expect(refused.statusCode).toBe(404);
    expect(withoutTrace(refused.json())).toBe(withoutTrace(unconfigured.json()));
    expect(executor.calls).toEqual([]);
    expect(store.investigations).toEqual([]);
    expect(events.filter((event) => event.sourceId === 'secret').map((event) => [event.action, event.result])).toEqual([['entity.load', 'denied']]);
    expect(auditStages(), 'the one event of the source was written by the gate').toBe(1);
    await app.close();
  });

  it('answers an entity read the same when the policy allows the check in front and the gate refuses the read, and the gate records the one denial', async () => {
    const { app, get, executor, events, auditStages } = await started((sourceId, ask) => sourceId !== 'secret' || ask < 2);
    const read = await get('/v1/entities/secret/widget/W-1');
    const unconfigured = await get('/v1/entities/nowhere/widget/W-1');
    expect(read.statusCode).toBe(404);
    expect(withoutTrace(read.json())).toBe(withoutTrace(unconfigured.json()));
    expect(executor.calls).toEqual([]);
    expect(events.filter((event) => event.sourceId === 'secret').map((event) => [event.action, event.result])).toEqual([['entity.load', 'denied']]);
    expect(auditStages()).toBe(1);
    await app.close();
  });
});

describe('the audit of a refused attempt', () => {
  it('records exactly one denied entity.load event with the person, the source and the trace ID and no entity ID, whichever check refused', async () => {
    const early = await started();
    const response = await early.post(request('secret'));
    expect(early.events).toHaveLength(1);
    expect(early.events[0]).toMatchObject({ actorId: '0192f000-0000-7000-8000-000000000001', actorRole: 'administrator', action: 'entity.load', result: 'denied', sourceId: 'secret' });
    expect(early.events[0]?.traceId).toBe(response.json().error.traceId);
    expect(JSON.stringify(early.events)).not.toContain('W-1');
    expect(early.auditStages(), 'the early denial is written by the service, not by the gate').toBe(0);
    await early.app.close();

    const late = await started((sourceId, ask) => sourceId !== 'secret' || ask < 3);
    await late.post(request('secret'));
    expect(late.events).toHaveLength(1);
    expect(late.events[0]).toMatchObject({ action: 'entity.load', result: 'denied', sourceId: 'secret' });
    expect(JSON.stringify(late.events)).not.toContain('W-1');
    expect(late.auditStages(), 'the later denial is written by the gate and not repeated by the translation').toBe(1);
    await late.app.close();
  });

  it('records a denial for a source that is not configured without naming it, and the answer does not change when the audit sink fails', async () => {
    const { app, post, events } = await started();
    await post(request('nowhere'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'entity.load', result: 'denied' });
    expect(events[0]).not.toHaveProperty('sourceId');
    await app.close();
    const failing = await started(EXCEPT_SECRET, entityRows(WIDGET), { failAudit: true });
    const response = await failing.post(request('secret'));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    await failing.app.close();
  });
});

describe('a source the person may read', () => {
  it('answers an entity type the mapping does not name with INVALID_REQUEST, a missing entity with NOT_FOUND and another source in the reference with SOURCE_MISMATCH', async () => {
    const { app, post } = await started();
    const missing = await started(EXCEPT_SECRET, entityRows());
    expect((await post(request('open', {}, 'nothing'))).json().error.code).toBe('INVALID_REQUEST');
    expect((await missing.post(request('open'))).json().error.code).toBe('NOT_FOUND');
    const mismatch = await post({ sourceId: 'open', entity: { sourceId: 'secret', entityType: 'widget', stableId: 'W-1' } });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('SOURCE_MISMATCH');
    await app.close();
    await missing.app.close();
  });

  it('answers a request that fails the strict schema with INVALID_REQUEST whether the source is readable or not, before the policy is asked', async () => {
    const { app, post, asks } = await started();
    for (const sourceId of ['open', 'secret', 'nowhere']) {
      const response = await post({ ...request(sourceId), extra: 1 });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
    }
    expect((await app.inject({ method: 'POST', url: '/v1/investigations', payload: 'nope', headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    expect(asks).toEqual([]);
    await app.close();
  });
});

describe('asking the policy first without replacing the gate', () => {
  it('asks the policy before any read, and the later denial of the gate still refuses the read: an allow in front does not skip the gate', async () => {
    const readsAtAsk: number[] = [];
    const parts = await started((sourceId) => {
      readsAtAsk.push(parts.executor.calls.length);
      return sourceId === 'open';
    });
    expect((await parts.post(request('open'))).statusCode).toBe(201);
    expect(readsAtAsk, 'the service, the entity reader and the gate each ask, all before the read').toEqual([0, 0, 0]);
    expect(entityCalls(parts.executor.calls)).toHaveLength(1);
    await parts.app.close();
  });

  it('answers NOT_FOUND to every open and entity read, with no read, when the policy allows nothing', async () => {
    const { app, post, get, executor } = await started(() => false);
    for (const response of [await post(request('open')), await post(request('secret')), await get('/v1/entities/open/widget/W-1')]) expect(response.statusCode).toBe(404);
    expect(executor.calls).toEqual([]);
    await app.close();
  });
});

describe('trying an open again after a failed read', () => {
  it('writes nothing for the failed read and makes exactly one investigation and one draft when the identical request is sent again, answering 201', async () => {
    let answer: ExecuteOutcome = { status: 'timeout' };
    const store = memoryAppStore();
    const parts = await started(EXCEPT_SECRET, answer, { store });
    parts.executor.calls.length = 0;
    const failed = await parts.post(request('open'));
    expect(failed.statusCode).toBe(504);
    expect([store.investigations.length, store.drafts.length]).toEqual([0, 0]);
    await parts.app.close();
    answer = entityRows(WIDGET);
    const again = await started(EXCEPT_SECRET, answer, { store });
    const retried = await again.post(request('open'));
    expect(retried.statusCode).toBe(201);
    expect([store.investigations.length, store.drafts.length]).toEqual([1, 1]);
    await again.app.close();
  });

  it('returns the existing investigation and answers 200 when the case reference matches one the person owns', async () => {
    const store = memoryAppStore();
    const first = await started(EXCEPT_SECRET, entityRows(WIDGET), { store });
    const created = openInvestigationResponseSchema.parse((await first.post(request('open', { caseRef: 'CASE-1' }))).json());
    await first.app.close();
    const failing = await started(EXCEPT_SECRET, { status: 'timeout' }, { store });
    expect((await failing.post(request('open', { caseRef: 'CASE-1' }))).statusCode).toBe(504);
    expect(store.investigations).toHaveLength(1);
    await failing.app.close();
    const retry = await started(EXCEPT_SECRET, entityRows(WIDGET), { store });
    const response = await retry.post(request('open', { caseRef: 'CASE-1' }));
    expect(response.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(response.json())).toMatchObject({ created: false, investigation: { id: created.investigation.id } });
    expect(investigationResponseSchema.safeParse(await retry.get(`/v1/investigations/${created.investigation.id}`).then((read) => read.json())).success).toBe(true);
    await retry.app.close();
  });
});
