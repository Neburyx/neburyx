import { rmSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { createAuditedModelCall, createCaseSummarizer, createEnterpriseExtension, createMemorySummaryRunStore, buildSummaryInstructions, promptRecordOf, type ModelAnswer, type ModelProvider, type ModelRequest } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it } from 'vitest';
import { el, exportWebRoot, startExportRig, type ExportRigOptions } from '../testing/export-rig.js';
import { portOf } from '../testing/raw-request.js';

afterAll(() => rmSync(exportWebRoot, { recursive: true, force: true }));

const keys = { current: { kid: 'abcd1234', bytes: Buffer.alloc(32, 9) } };
const GOOD = JSON.stringify({ sentences: [{ text: 'Two widgets are listed.', cites: ['n1', 'n2'] }] });

const until = async (check: () => boolean): Promise<void> => {
  for (let waited = 0; !check() && waited < 2000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

/** A provider that holds each call until the test answers it; `honorsSignal` says whether an abort ends the call, as the real provider's does. */
function heldProvider(honorsSignal: boolean) {
  const received: ModelRequest[] = [];
  const signals: AbortSignal[] = [];
  const waiting: ((text: string) => void)[] = [];
  const provider: ModelProvider = {
    complete: (request, signal) => {
      received.push(request);
      signals.push(signal);
      return new Promise<ModelAnswer>((resolve, reject) => {
        waiting.push((text) => resolve({ status: 'ok', text, usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) }));
        if (honorsSignal) signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  const answer = (text: string): void => waiting.shift()?.(text);
  return { provider, received, signals, answer };
}

async function listening(provider: ModelProvider, rigOptions: Pick<ExportRigOptions, 'answer'> = {}) {
  const store = createMemorySummaryRunStore();
  const closing: { readonly action: string; readonly result?: string; readonly detail?: unknown }[] = [];
  const model = createAuditedModelCall({ provider, configuration: { model: 'claude-sonnet-5-5' }, sink: { record: async () => undefined } });
  const summarizer = createCaseSummarizer({
    settings: { model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 5, maxElements: 300, maxOutputTokens: 4000, maxInputTokens: 100_000, retentionDays: 30 },
    instructions: buildSummaryInstructions('PROMPT', 'TYPOLOGY'),
    model: () => model,
    audit: () => ({ record: async (event) => void closing.push(event) }),
    tokenKeys: () => keys,
    runs: () => store,
    availability: () => ({ available: true }),
  });
  const rig = await startExportRig({ extension: createEnterpriseExtension(), caseSummarizer: summarizer, ...rigOptions });
  await rig.app.listen({ port: 0, host: '127.0.0.1' });
  const investigation = await rig.open();
  const body = JSON.stringify({ investigationId: investigation.id, sourceId: 'demo', entities: [el('widget', 'W-1'), el('widget', 'W-2')] });
  const post = (): { request: ClientRequest; response: Promise<{ status: number }> } => {
    const request = httpRequest({ host: '127.0.0.1', port: portOf(rig.app), path: '/v1/summary', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'idempotency-key': 'key-0000000000000001' } });
    const response = new Promise<{ status: number }>((resolve, reject) => {
      request.on('response', (incoming) => (incoming.resume(), incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0 }))));
      request.on('error', reject);
    });
    response.catch(() => undefined);
    request.end(body);
    return { request, response };
  };
  const closed = () => closing.filter((event) => event.action === 'ai.case-summary.closed');
  return { rig, store, post, closed };
}

describe('a case summary click that the client cancels while the model call is in flight', () => {
  it.each([true, false])('aborts the call, makes no second call, reads the source no more, and closes the click and its record as cancelled (provider honors the signal: %s)', async (honors) => {
    const held = heldProvider(honors);
    const { rig, store, post, closed } = await listening(held.provider);
    const { request } = post();
    await until(() => held.received.length === 1);
    const readsAtCancel = rig.executor.calls.length;
    request.destroy();
    await until(() => held.signals[0]?.aborted === true);
    // a provider that ignores the abort answers late with a reply that would earn a second call
    if (!honors) held.answer('not json');
    await until(() => closed().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held.received).toHaveLength(1);
    expect(rig.executor.calls).toHaveLength(readsAtCancel);
    expect(closed()).toHaveLength(1);
    expect(closed()[0]).toMatchObject({ result: 'failed', detail: { summary: { outcome: 'cancelled', calls: 1 } } });
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ outcome: 'cancelled', calls: 1 });
    expect(store.runs[0]?.callEnds[0]).toMatchObject({ number: 1, status: 'cancelled' });
    await rig.stop();
  });
});

describe('a connection closed after the draft was answered', () => {
  it('changes nothing: one call, the click closed ok, the record ok', async () => {
    const held = heldProvider(true);
    const { rig, store, post, closed } = await listening(held.provider);
    const { request, response } = post();
    await until(() => held.received.length === 1);
    held.answer(GOOD);
    expect((await response).status).toBe(200);
    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held.signals[0]?.aborted).toBe(false);
    expect(held.received).toHaveLength(1);
    expect(closed()).toHaveLength(1);
    expect(closed()[0]).toMatchObject({ result: 'success', detail: { summary: { outcome: 'ok', calls: 1 } } });
    expect(store.runs[0]).toMatchObject({ outcome: 'ok', calls: 1 });
    await rig.stop();
  });
});

describe('a click the client cancels while the gate reads the view', () => {
  it('aborts the read, makes no further read and no model call, and closes the click and its run as cancelled', async () => {
    const held = heldProvider(true);
    let reading: AbortSignal | undefined;
    const { rig, store, post, closed } = await listening(held.provider, {
      answer: (call) => {
        if (call.templateId !== 'entity-load-many') return undefined;
        reading = call.signal;
        return new Promise((resolve) => call.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
      },
    });
    const { request } = post();
    await until(() => reading !== undefined);
    const readsAtCancel = rig.executor.calls.length;
    request.destroy();
    await until(() => reading?.aborted === true);
    await until(() => store.runs[0]?.outcome === 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rig.executor.calls).toHaveLength(readsAtCancel);
    expect(held.received).toEqual([]);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ outcome: 'cancelled', calls: 0 });
    expect(closed()).toHaveLength(1);
    expect(closed()[0]).toMatchObject({ result: 'failed', detail: { summary: { outcome: 'cancelled', calls: 0 } } });
    await rig.stop();
  });
});
