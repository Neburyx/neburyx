import { rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { edgeRefSegmentOf, type DerivedEdgeRef } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { DERIVED_EDGE_SUPPORT_ID } from '../gate/templates/derived-edge-support.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { chain, DERIVED_ENTITIES, DERIVED_RULE, DERIVED_STORED } from '../testing/derived-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { portOf } from '../testing/raw-request.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const QUEUE_WAIT_MS = 150;
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', budgets: { user_concurrency: 1, queue_wait_ms: QUEUE_WAIT_MS }, entities: DERIVED_ENTITIES, relationships: DERIVED_STORED, derived: [DERIVED_RULE] })), 'neburyx.yaml');
const end = (stableId: string) => ({ sourceId: 'demo', entityType: 'maker', stableId });
const REF: DerivedEdgeRef = { sourceId: 'demo', derived: { ruleId: 'shared-tool', from: end('A-1'), to: end('A-2') } };
const PATH = `/v1/edges/${edgeRefSegmentOf(REF)}`;
const rows = [chain('A-1', 'A-2', 'D-1')];

/** An executor whose first supports read is held until the test lets it go or the call's signal aborts, as the adapter ends a cancelled read. */
function heldExecutor() {
  let letGo: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => (letGo = resolve));
  let reads = 0;
  let readStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (readStarted = resolve));
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId !== DERIVED_EDGE_SUPPORT_ID) return Promise.resolve({ status: 'rows', rows: [] });
    reads += 1;
    if (reads > 1) return Promise.resolve({ status: 'rows', rows });
    readStarted();
    return new Promise<ExecuteOutcome>((resolve) => {
      void hold.then(() => resolve({ status: 'rows', rows }));
      call.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
    });
  };
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), respond));
  return { executor, letGo, started, reads: () => reads };
}

async function listening() {
  const held = heldExecutor();
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event: AuditEvent) => (events.push(event), Promise.resolve()) } };
  const parts = testSourceGate(mapping, { executor: held.executor, seams });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, events, ...held };
}

function get(app: Awaited<ReturnType<typeof listening>>['app']) {
  const request = httpRequest({ host: '127.0.0.1', port: portOf(app), path: PATH, method: 'GET' });
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request.on('response', (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
  });
  response.catch(() => undefined);
  request.end();
  return { request, response };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let waited = 0; !check() && waited < 2000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

describe('a person with their one read slot held by a derived read', () => {
  it('answers a second derived read SOURCE_BUSY after the wait with nothing read for it, and answers the held one when it ends', async () => {
    const { app, events, letGo, started, reads } = await listening();
    const first = get(app);
    await started;
    const startedAt = Date.now();
    const second = await get(app).response;
    expect(second.status).toBe(503);
    expect(JSON.parse(second.body)).toMatchObject({ error: { code: 'SOURCE_BUSY', retryable: true } });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(QUEUE_WAIT_MS - 5);
    expect(reads()).toBe(1);
    letGo();
    expect((await first.response).status).toBe(200);
    expect(events.filter((event) => event.action === 'edge.derived_support').map((event) => event.result).sort()).toEqual(['failed', 'success']);
    await app.close();
  });

  it('answers the second read when the first ends within the wait', async () => {
    const { app, letGo, started, reads } = await listening();
    const first = get(app);
    await started;
    const second = get(app);
    await new Promise((resolve) => setTimeout(resolve, QUEUE_WAIT_MS / 3));
    letGo();
    expect((await first.response).status).toBe(200);
    expect((await second.response).status).toBe(200);
    expect(reads()).toBe(2);
    await app.close();
  });
});

describe('a derived read whose client closes the connection while the source reads', () => {
  it('aborts the read, audits it as cancelled and frees the slot for the next read', async () => {
    const { app, events, executor, started } = await listening();
    const { request } = get(app);
    await started;
    const call = executor.calls.find((each) => each.templateId === DERIVED_EDGE_SUPPORT_ID);
    expect(call?.signal?.aborted).toBe(false);
    request.destroy();
    await until(() => call?.signal?.aborted === true);
    await until(() => events.some((event) => event.action === 'edge.derived_support'));
    expect(events.find((event) => event.action === 'edge.derived_support')).toMatchObject({ result: 'failed', detail: { reason: 'cancelled' } });
    expect((await get(app).response).status).toBe(200);
    await app.close();
  });
});
