import { rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { EXPAND_NEIGHBORS_ID } from '../gate/templates/expand-neighbors.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { portOf } from '../testing/raw-request.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'hub', label: 'Hub', stable_id: 'hubId' },
        { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
      ],
      relationships: [{ type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId' }],
    }),
  ),
  'neburyx.yaml',
);
const hub = plainNode(['Hub'], { hubId: 'H-1' }, 'e-hub');
const leaf = plainNode(['Leaf'], { leafId: 'L-1' }, 'e-leaf');
const rows = [{ a: hub, m: leaf, rel: plainRelationship('LINKED', hub, leaf, { relId: 'r1' }, 'rel-1'), phase: 2, ts: null, id: 'r1', rtype: 'LINKED', dir: 'out', ntype: null, flag: null, members: null, first: null }];
const BODY = JSON.stringify({ sourceId: 'demo', ref: { entityType: 'hub', stableId: 'H-1' }, neighborTypes: ['leaf'] });

/** An executor whose expansion read holds until the test says what it answers, and that ends as cancelled when its call's signal aborts, as the adapter does. */
function heldExecutor() {
  let answer: (outcome: ExecuteOutcome) => void = () => undefined;
  let readStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (readStarted = resolve));
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId === 'entity-load') return Promise.resolve(entityRows(plainNode(['Hub'], { hubId: 'H-1' })));
    if (call.templateId !== EXPAND_NEIGHBORS_ID) return Promise.resolve({ status: 'rows', rows });
    readStarted();
    return new Promise<ExecuteOutcome>((resolve) => {
      answer = resolve;
      call.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
    });
  };
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), respond));
  return { executor, started, answerRows: () => answer({ status: 'rows', rows }) };
}

async function listening() {
  const held = heldExecutor();
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event: AuditEvent) => (events.push(event), Promise.resolve()) } };
  const parts = testSourceGate(mapping, { executor: held.executor, seams });
  const lines: string[] = [];
  const app = await buildApp({ webRoot, logger: createLogger({ write: (line: string) => void lines.push(line) }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const logged = (): Record<string, unknown>[] => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { app, events, logged, ...held };
}

function post(app: Awaited<ReturnType<typeof listening>>['app']) {
  const request = httpRequest({ host: '127.0.0.1', port: portOf(app), path: '/v1/graph/expand', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(BODY) } });
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request.on('response', (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
  });
  response.catch(() => undefined);
  request.end(BODY);
  return { request, response };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let waited = 0; !check() && waited < 2000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

describe('an expansion whose client closes the connection while the source reads', () => {
  it('stops the read, writes no answer, and logs only the completion as aborted', async () => {
    const { app, events, logged, executor, started } = await listening();
    const { request } = post(app);
    await started;
    const call = executor.calls.find((each) => each.templateId === EXPAND_NEIGHBORS_ID);
    expect(call?.signal?.aborted).toBe(false);
    request.destroy();
    await until(() => call?.signal?.aborted === true);
    await until(() => events.some((event) => event.action === 'graph.expand'));
    expect(events.filter((event) => event.action === 'graph.expand').map((event) => event.result)).toEqual(['failed']);
    await until(() => logged().some((entry) => entry['event'] === 'request.completed'));
    const completed = logged().filter((entry) => entry['event'] === 'request.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ aborted: true });
    expect(logged().map((entry) => entry['event'])).not.toContain('request.failed');
    expect(logged().map((entry) => entry['event'])).not.toContain('gate.internal_error');
    await app.close();
  });
});

describe('an expansion whose body was read and whose answer is still being computed', () => {
  it('is not aborted, and is answered once the read ends', async () => {
    const { app, executor, started, answerRows } = await listening();
    const { response } = post(app);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const call = executor.calls.find((each) => each.templateId === EXPAND_NEIGHBORS_ID);
    expect(call?.signal?.aborted).toBe(false);
    answerRows();
    expect((await response).status).toBe(200);
    expect(call?.signal?.aborted).toBe(false);
    await app.close();
  });
});

describe('a connection closed after the answer was written', () => {
  it('changes nothing: the audit records success and the completion is not aborted', async () => {
    const { app, events, logged, started, answerRows } = await listening();
    const { response } = post(app);
    await started;
    answerRows();
    expect((await response).status).toBe(200);
    await until(() => logged().some((entry) => entry['event'] === 'request.completed'));
    expect(events.filter((event) => event.action === 'graph.expand').map((event) => event.result)).toEqual(['success']);
    expect(logged().find((entry) => entry['event'] === 'request.completed')).not.toHaveProperty('aborted');
    await app.close();
  });
});
