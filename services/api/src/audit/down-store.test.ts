import { createEnterpriseExtension } from '@neburyx/ee-ask';
import type { AskClassifier, AuditEvent, AuditSink, CaseSummarizer } from '@neburyx/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { startExportRig } from '../testing/export-rig.js';
import { startSearchApp, widget } from '../testing/search-app.js';
import { createAuditQueue, createEventQueue } from './queue.js';

afterAll(removeAskFolders);

const INTENTS = { widgetById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'widget', stableId: '$id' } } } };
const SETTINGS = { queueSize: 50, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 60_000 };
const post = (app: Awaited<ReturnType<typeof startSearchApp>>['app'], url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
const readyz = async (app: Awaited<ReturnType<typeof startSearchApp>>['app']) => (await app.inject({ method: 'GET', url: '/readyz' })).json().audit;

function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function started(sink: AuditSink, size = SETTINGS.queueSize) {
  const lines: Record<string, unknown>[] = [];
  const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink }], settings: { ...SETTINGS, queueSize: size }, logger: { warn: (fields) => void lines.push(fields) } });
  const extension = createEnterpriseExtension();
  const configured = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['demo'], INTENTS) }, { sourceIds: ['demo'] });
  expect(configured?.ok).toBe(true);
  const classifier: AskClassifier = { availability: () => ({ available: true }), classify: async () => ({ ok: true, intent: 'widgetById', entities: { id: 'W-001' } }) };
  const seams = { ...communitySeams(), audit: queue.sink, askClassifier: classifier };
  const rig = await startSearchApp({ rows: [widget(1)], audit: queue.sink, appOptions: { extension, previewOn: true, seams, auditCounts: queue.counts } });
  return { ...rig, queue, lines };
}

const read = (app: Awaited<ReturnType<typeof startSearchApp>>['app']) => app.inject({ method: 'GET', url: '/v1/entities/demo/widget/W-001' });

describe('an audit store that does not answer', () => {
  it('holds no read and no Ask question back: each is answered before the store is released, and its events are written after', async () => {
    const held = deferred();
    const written: string[] = [];
    const { app, queue } = await started({ record: async (event: AuditEvent) => (await held.promise, void written.push(event.action)) });
    expect((await read(app)).statusCode).toBe(200);
    const asked = await post(app, '/v1/ask', { sourceId: 'demo', question: 'Show widget W-001' });
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toMatchObject({ answered: { intent: 'widgetById', outcome: 'complete' } });
    expect(written).toEqual([]);
    expect((await readyz(app)).queued).toBeGreaterThan(1);
    held.release();
    await vi.waitFor(() => expect(queue.counts()).toMatchObject({ queued: 0, failed: 0, dropped: 0 }));
    expect(written).toEqual(expect.arrayContaining(['entity.load', 'ask.question']));
    await app.close();
  });

  it('with a full queue still answers, drops the events it cannot take, counts them in /readyz and logs no text of the requests', async () => {
    const { app, lines } = await started({ record: () => new Promise<void>(() => undefined) }, 1);
    for (let index = 0; index < 5; index += 1) expect((await read(app)).statusCode).toBe(200);
    expect((await post(app, '/v1/ask', { sourceId: 'demo', question: 'SENTINEL-QUESTION-TEXT' })).statusCode).toBe(200);
    expect(await readyz(app)).toMatchObject({ queued: 1 });
    expect((await readyz(app)).dropped).toBeGreaterThan(3);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toMatch(/SENTINEL|W-001/);
    await app.close();
  });

  it('with a store that fails every write still answers, and /readyz counts the failures without changing its status', async () => {
    const { app } = await started({ record: () => Promise.reject(new Error('the audit store is down')) });
    expect((await read(app)).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await readyz(app)).failed).toBeGreaterThan(0));
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('a stub caller that stands for the assistant', () => {
  it('records its events and its stored run through the queues without being blocked, failed or delayed by a store that is down', async () => {
    const events = createAuditQueue({ sinks: [{ name: 'postgres', sink: { record: () => new Promise<void>(() => undefined) } }], settings: { ...SETTINGS, queueSize: 2 }, logger: { warn: () => undefined } });
    const records = createEventQueue<{ ids: Record<string, string>; write(): Promise<void> }>({
      sinks: [{ name: 'run-records', sink: { record: (job) => job.write() } }],
      idFields: (job) => job.ids,
      settings: { ...SETTINGS, queueSize: 2 },
      logger: { warn: () => undefined },
    });
    const turn = async (index: number): Promise<string> => {
      await events.sink.record({ actorId: 'u', actorRole: 'investigator', action: 'assistant.turn', result: 'success', traceId: `t-${index}` });
      await records.sink.record({ ids: { runId: `r-${index}` }, write: () => new Promise<void>(() => undefined) });
      return 'answered';
    };
    const answers = await Promise.all(Array.from({ length: 10 }, (_unused, index) => turn(index)));
    expect(answers).toEqual(Array.from({ length: 10 }, () => 'answered'));
    expect(events.counts()).toMatchObject({ queued: 2, dropped: 8 });
    expect(records.counts()).toMatchObject({ queued: 2, dropped: 8 });
  });
});

describe('a privileged action with the store down', () => {
  it('is refused and leaves no published export, while a read through the queue is unaffected', async () => {
    const rig = await startExportRig({ failAudit: (action) => action === 'export.create' });
    const investigation = await rig.open();
    const refused = await rig.create(investigation.id, { kind: 'view', format: 'json', entities: [], edges: [], aggregates: [], derived: [] });
    expect(refused.statusCode).toBe(500);
    expect(rig.store.exports.rows.filter((row) => row.status === 'ready')).toEqual([]);
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });
});

describe('stored records that a store does not take', () => {
  const context = { databaseUrl: 'postgres://app@db.example.test/neburyx', poolSize: 1, connectionTimeoutMs: 1000, statementTimeoutMs: 1000, queryTimeoutMs: 1000, newId: () => '00000000-0000-7000-8000-000000000001', onConnectionError: () => undefined };

  async function withRecords(write: (row: { id: string }) => Promise<void>, recordQueueSize = SETTINGS.queueSize) {
    const lines: Record<string, unknown>[] = [];
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: { record: () => Promise.resolve() } }], settings: SETTINGS, logger: { warn: () => undefined } });
    const records = createEventQueue<{ ids: Record<string, string>; write(): Promise<void> }>({
      sinks: [{ name: 'run-records', sink: { record: (job) => job.write() } }],
      idFields: (job) => job.ids,
      settings: { ...SETTINGS, retryLimit: 0, queueSize: recordQueueSize },
      logger: { warn: (fields) => void lines.push(fields) },
    });
    const extension = createEnterpriseExtension({
      runStore: () => ({ record: (row) => write(row), close: () => Promise.resolve() }),
      summaryRunStore: () => ({ begin: () => Promise.resolve(), beginCall: () => Promise.resolve(), endCall: () => Promise.resolve(), finish: () => Promise.resolve(), removeStartedBefore: () => Promise.resolve(0), close: () => Promise.resolve() }),
    });
    const configured = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['demo'], INTENTS) }, { sourceIds: ['demo'] });
    expect(configured?.ok).toBe(true);
    extension.createAuditSink?.(context);
    extension.attachRecordQueue?.({ enqueue: (job) => void records.sink.record(job) });
    const classifier: AskClassifier = { availability: () => ({ available: true }), classify: async () => ({ ok: true, intent: 'widgetById', entities: { id: 'W-001' } }) };
    const seams = { ...communitySeams(), audit: queue.sink, askClassifier: classifier };
    const rig = await startSearchApp({ rows: [widget(1)], audit: queue.sink, appOptions: { extension, previewOn: true, seams, auditCounts: () => ({ ...records.counts() }) } });
    return { ...rig, records, lines };
  }

  it('answers an Ask question before the run record is written, and writes the record once the store takes it', async () => {
    const held = deferred();
    const rows: string[] = [];
    const { app, records } = await withRecords(async (row) => (await held.promise, void rows.push(row.id)));
    const asked = await post(app, '/v1/ask', { sourceId: 'demo', question: 'Show widget W-001' });
    expect(asked.statusCode).toBe(200);
    expect(rows).toEqual([]);
    expect((await readyz(app)).queued).toBe(1);
    held.release();
    await vi.waitFor(() => expect(records.counts()).toMatchObject({ written: 1, queued: 0 }));
    expect(rows).toHaveLength(1);
    await app.close();
  });

  it('answers an Ask question when the store fails the run record, and counts the failure by ids without the record', async () => {
    const { app, records, lines } = await withRecords(() => Promise.reject(new Error('the run store is down, CANARY')));
    expect((await post(app, '/v1/ask', { sourceId: 'demo', question: 'SENTINEL-QUESTION' })).statusCode).toBe(200);
    await vi.waitFor(() => expect(records.counts().failed).toBe(1));
    expect(JSON.stringify(lines)).not.toMatch(/CANARY|SENTINEL|W-001/);
    await app.close();
  });

  it('with a full queue of run records, answers every Ask question unchanged, drops the records it cannot take, counts the drops in /readyz and logs no text', async () => {
    const written: string[] = [];
    const { app, lines } = await (async () => {
      const never = new Promise<void>(() => undefined);
      return withRecords(async (row) => (await never, void written.push(row.id)), 1);
    })();
    for (const text of ['SENTINEL-ONE', 'SENTINEL-TWO', 'SENTINEL-THREE']) {
      const answer = await post(app, '/v1/ask', { sourceId: 'demo', question: text });
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toMatchObject({ answered: { intent: 'widgetById', outcome: 'complete' } });
    }
    expect(await readyz(app)).toMatchObject({ queued: 1, dropped: 2 });
    expect(JSON.stringify(lines)).not.toMatch(/SENTINEL|W-001/);
    expect(lines.filter((line) => line['event'] === 'audit.event_dropped')).toHaveLength(2);
    await app.close();
  });
});

describe('a summary click with the audit store held', () => {
  it('is answered before the store is released: the closing event of a click that ends in the route is queued', async () => {
    const held = deferred();
    const written: string[] = [];
    const lines: Record<string, unknown>[] = [];
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: { record: async (event: AuditEvent) => (await held.promise, void written.push(event.action)) } }], settings: SETTINGS, logger: { warn: (fields) => void lines.push(fields) } });
    const extension = createEnterpriseExtension();
    const configured = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['demo'], INTENTS) }, { sourceIds: ['demo'] });
    expect(configured?.ok).toBe(true);
    const tooLarge = { maxElements: 0, availability: () => ({ available: true }), summarize: () => Promise.reject(new Error('not reached')) } as unknown as CaseSummarizer;
    const seams = { ...communitySeams(), audit: queue.sink, caseSummarizer: tooLarge };
    const { app } = await startSearchApp({ rows: [widget(1)], audit: queue.sink, appOptions: { extension, previewOn: true, seams, auditCounts: queue.counts } });
    const answer = await app.inject({ method: 'POST', url: '/v1/summary', payload: JSON.stringify({ sourceId: 'demo', investigationId: '0192f000-0000-7000-8000-0000000000aa', entities: [{ sourceId: 'demo', entityType: 'widget', stableId: 'W-001' }] }), headers: { 'content-type': 'application/json', 'idempotency-key': '0192f000-0000-7000-8000-0000000000bb' } });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ status: 'tooLarge' });
    expect(written).toEqual([]);
    held.release();
    await vi.waitFor(() => expect(written).toContain('ai.case-summary.closed'));
    await app.close();
  });
});
