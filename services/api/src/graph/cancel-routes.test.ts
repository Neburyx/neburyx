import { rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { edgeRefSegmentOf, sourceLinkSegmentOf, type CaseSummarizer, type ProfileExtension } from '@neburyx/contracts';
import { createEnterpriseExtension, createSummaryRoute, guardAiRouteGroup } from '@neburyx/ee-ask';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { createAgentScript } from '../testing/agent-script.js';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows } from '../testing/entity-fixtures.js';
import { plainNode } from '../testing/normalize-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { portOf } from '../testing/raw-request.js';
import { facetRowOf, onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
  removeAskFolders();
});

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'hub', label: 'Hub', stable_id: 'hubId', search: ['hubId'], link: 'https://records.example.test/{hubId}' },
        { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
      ],
      relationships: [{ type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt', evidence: ['recordId'], evidence_link: 'https://records.example.test/r/{recordId}' }],
      derived: [{ id: 'shared-leaf', from: 'hub', to: 'hub', via: ['LINKED', 'leaf', 'LINKED'], rule_version: 1 }],
      patterns: [
        { id: 'shared-hubs', name: 'Shared leaves', template: 'shared-attribute', bind: { anchor: 'hub', attribute: 'leaf', via: 'LINKED' } },
        { id: 'linked-leaves', name: 'Linked leaves', template: 'linked-entities', bind: { anchor: 'hub', target: 'leaf', via: 'LINKED' } },
      ],
    }),
  ),
  'neburyx.yaml',
);

const ref = { entityType: 'hub', stableId: 'H-1' };
const STORED = { sourceId: 'demo', type: 'LINKED', from: 'hub', to: 'leaf', stableId: 'L-1' };
const DERIVED = { sourceId: 'demo', derived: { ruleId: 'shared-leaf', from: { sourceId: 'demo', ...ref }, to: { sourceId: 'demo', entityType: 'hub', stableId: 'H-2' } } };

const SUMMARIZER: CaseSummarizer = {
  maxElements: 300,
  availability: () => ({ available: true }),
  summarize: async () => ({ status: 'ok', sentences: [], citations: [], coverage: { retrieval: '0 shown', summary: 'No sentence was kept.' }, removedCount: 0, sent: '', model: 'stub', calls: 1, summaryToken: 'v1.stub' }),
};
const SUMMARY_EXTENSION: ProfileExtension = { name: 'summary', routeGroups: [guardAiRouteGroup({ routes: [createSummaryRoute()] })] };

/** `route` is the registered route a case sends to; the list below is compared with the routes that read the source. */
const ROUTES: readonly { readonly name: string; readonly route: string; readonly method: 'GET' | 'POST'; readonly path: string; readonly body?: unknown; readonly headers?: Readonly<Record<string, string>> }[] = [
  { name: 'entity load', route: 'GET /v1/entities/:sourceId/:entityType/:stableId', method: 'GET', path: '/v1/entities/demo/hub/H-1' },
  { name: 'entity lookup', route: 'POST /v1/entities/lookup', method: 'POST', path: '/v1/entities/lookup', body: { sourceId: 'demo', ref } },
  { name: 'search', route: 'POST /v1/search/entities', method: 'POST', path: '/v1/search/entities', body: { sourceId: 'demo', text: 'abc' } },
  { name: 'degree preview', route: 'POST /v1/graph/preview-expansion', method: 'POST', path: '/v1/graph/preview-expansion', body: { sourceId: 'demo', ref } },
  { name: 'derived neighbors', route: 'POST /v1/graph/derived-neighbors', method: 'POST', path: '/v1/graph/derived-neighbors', body: { sourceId: 'demo', ref } },
  { name: 'shortest paths', route: 'POST /v1/graph/paths', method: 'POST', path: '/v1/graph/paths', body: { sourceId: 'demo', from: ref, to: { entityType: 'leaf', stableId: 'L-1' }, relTypes: ['LINKED'], maxHops: 2, limit: 5 } },
  { name: 'template run', route: 'POST /v1/templates/:id/run', method: 'POST', path: '/v1/templates/shared-hubs/run', body: { sourceId: 'demo', params: { ref } }, headers: { 'idempotency-key': 'a-key-of-sixteen-characters' } },
  { name: 'template run of the linked-entities template', route: 'POST /v1/templates/:id/run', method: 'POST', path: '/v1/templates/linked-leaves/run', body: { sourceId: 'demo', params: { ref } }, headers: { 'idempotency-key': 'a-second-key-of-sixteen' } },
  { name: 'pattern run', route: 'POST /v1/patterns/run', method: 'POST', path: '/v1/patterns/run', body: { sourceId: 'demo', definition: { anchorType: 'hub', steps: [{ relationshipTypes: ['LINKED'], direction: 'out', arrivesAt: 'leaf' }] }, anchor: ref }, headers: { 'idempotency-key': 'a-third-key-of-sixteen-c' } },
  { name: 'read by references', route: 'POST /v1/graph/read-refs', method: 'POST', path: '/v1/graph/read-refs', body: { sourceId: 'demo', entities: [{ sourceId: 'demo', ...ref }], edges: [STORED], derived: [DERIVED] } },
  { name: 'expand', route: 'POST /v1/graph/expand', method: 'POST', path: '/v1/graph/expand', body: { sourceId: 'demo', ref, neighborTypes: ['leaf'] } },
  { name: 'expand with a window', route: 'POST /v1/graph/expand', method: 'POST', path: '/v1/graph/expand', body: { sourceId: 'demo', ref, neighborTypes: ['leaf'], window: { days: 7 } } },
  { name: 'source link', route: 'GET /v1/source-links/:ref', method: 'GET', path: `/v1/source-links/${sourceLinkSegmentOf({ form: 'entity', ref: { sourceId: 'demo', ...ref } })}` },
  { name: 'stored relationship evidence', route: 'GET /v1/edges/:ref', method: 'GET', path: `/v1/edges/${edgeRefSegmentOf(STORED)}` },
  { name: 'derived relationship evidence', route: 'GET /v1/edges/:ref', method: 'GET', path: `/v1/edges/${edgeRefSegmentOf(DERIVED)}` },
  { name: 'source link of a record', route: 'GET /v1/source-links/:ref', method: 'GET', path: `/v1/source-links/${sourceLinkSegmentOf({ form: 'stored', ref: STORED })}?record=R-1` },
  { name: 'open investigation', route: 'POST /v1/investigations', method: 'POST', path: '/v1/investigations', body: { sourceId: 'demo', entity: { sourceId: 'demo', ...ref } } },
];

/** Every data read waits until its call's signal aborts, as the adapter ends a cancelled read; the schema read answers at once. */
async function listening(extension: ProfileExtension = SUMMARY_EXTENSION) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const mode = { answering: false };
  const hubs = Array.from({ length: 30 }, (_, index) => plainNode(['Hub'], { hubId: `H-${index}` }, `4:s:${index}`));
  const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (mode.answering) return Promise.resolve(call.templateId === 'search-facets' ? facetRowOf(call, hubs.length) : entityRows(...hubs.slice(0, call.rowLimit)));
    return new Promise((resolve) => call.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
  };
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), respond));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event: AuditEvent) => (events.push(event), Promise.resolve()) } };
  const parts = testSourceGate(mapping, { executor, seams });
  const lines: string[] = [];
  const app = await buildApp({ webRoot, logger: createLogger({ write: (line: string) => void lines.push(line) }), store: memoryAppStore(), mapping, gate: parts.gate, seams: { ...seams, caseSummarizer: SUMMARIZER }, extension, previewOn: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, executor, events, lines, mode };
}

/** The cursor of the next page of the exact group of a search, from a search whose group has more hits than a page. */
async function nextCursorOf(listened: Awaited<ReturnType<typeof listening>>): Promise<string> {
  listened.mode.answering = true;
  const answer = await fetch(`http://127.0.0.1:${portOf(listened.app)}/v1/search/entities`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'demo', text: 'H-' }) });
  const body = (await answer.json()) as { exactNextCursor?: string };
  listened.mode.answering = false;
  if (body.exactNextCursor === undefined) throw new Error('the search gave no cursor for a next page');
  return body.exactNextCursor;
}

const until = async (check: () => boolean): Promise<void> => {
  for (let waited = 0; !check() && waited < 3000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

describe('a request that reads the source, when the client closes the connection', () => {
  it('stops the read of search more', async () => {
    const listened = await listening();
    const { app, executor, events } = listened;
    const cursor = await nextCursorOf(listened);
    const before = executor.calls.length;
    const text = JSON.stringify({ sourceId: 'demo', text: 'H-', group: 'exact', cursor });
    const request = httpRequest({ host: '127.0.0.1', port: portOf(app), path: '/v1/search/entities/more', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } });
    request.on('error', () => undefined);
    request.end(text);
    await until(() => executor.calls.slice(before).some((call) => call.templateId !== 'schema-indexes'));
    const reading = executor.calls.slice(before).filter((call) => call.templateId !== 'schema-indexes');
    request.destroy();
    await until(() => reading.every((call) => call.signal?.aborted === true));
    await until(() => events.some((event) => event.detail?.reason === 'cancelled'));
    await app.close();
  });

  it.each(ROUTES)('stops the read of $name, audits it failed with the reason cancelled, and writes no error', async ({ method, path, body, headers }) => {
    const { app, executor, events, lines } = await listening();
    const text = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({ host: '127.0.0.1', port: portOf(app), path, method, headers: text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers } });
    request.on('error', () => undefined);
    request.end(text);
    const isData = (call: ExecuteCall): boolean => call.templateId !== 'schema-indexes';
    await until(() => executor.calls.some(isData));
    const reading = executor.calls.filter(isData);
    request.destroy();
    await until(() => reading.every((call) => call.signal?.aborted === true));
    await until(() => events.some((event) => event.detail?.reason === 'cancelled'));
    expect(events.filter((event) => event.detail !== undefined).map((event) => event.result)).toEqual(['failed']);
    await until(() => lines.some((line) => line.includes('request.completed')));
    expect(lines.join('\n')).not.toContain('request.failed');
    expect(lines.join('\n')).not.toContain('gate.internal_error');
    // nothing further is read once the request is cancelled
    const readsAtCancel = executor.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(executor.calls).toHaveLength(readsAtCancel);
    await app.close();
  });
});

describe('a summary request, when the client closes the connection', () => {
  it('stops the re-read of its elements, calls no summarizer and records one closing event as cancelled', async () => {
    const { app, executor, events, mode } = await listening();
    const base = `http://127.0.0.1:${portOf(app)}`;
    mode.answering = true;
    const opened = await fetch(`${base}/v1/investigations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'demo', entity: { sourceId: 'demo', ...ref } }) });
    const { investigation } = (await opened.json()) as { investigation: { id: string } };
    mode.answering = false;
    const before = executor.calls.length;
    const text = JSON.stringify({ investigationId: investigation.id, sourceId: 'demo', entities: [{ sourceId: 'demo', ...ref }] });
    const request = httpRequest({ host: '127.0.0.1', port: portOf(app), path: '/v1/summary', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'idempotency-key': 'a-key-of-sixteen-chars' } });
    request.on('error', () => undefined);
    request.end(text);
    const isData = (call: ExecuteCall): boolean => call.templateId !== 'schema-indexes';
    await until(() => executor.calls.slice(before).some(isData));
    const reading = executor.calls.slice(before).filter(isData);
    request.destroy();
    await until(() => reading.every((call) => call.signal?.aborted === true));
    await until(() => events.some((event) => event.action === 'ai.case-summary.closed'));
    expect(events.filter((event) => event.action === 'ai.case-summary.closed')).toHaveLength(1);
    expect(events.find((event) => event.action === 'ai.case-summary.closed')?.detail).toMatchObject({ summary: { outcome: 'cancelled', calls: 0 } });
    const readsAtCancel = executor.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(executor.calls).toHaveLength(readsAtCancel);
    await app.close();
  });
});

describe('a pattern run, when the client closes the connection while its estimate is read', () => {
  it.each([
    ['shared-hubs', 'shared-attribute-count', 'shared-attribute'],
    ['linked-leaves', 'linked-entities-count', 'linked-entities'],
  ])('stops the estimate of %s and does not start the run', async (preset, count, run) => {
    const { app, executor, events } = await listening();
    const text = JSON.stringify({ sourceId: 'demo', params: { ref } });
    const request = httpRequest({ host: '127.0.0.1', port: portOf(app), path: `/v1/templates/${preset}/run`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'idempotency-key': 'a-key-of-sixteen-characters' } });
    request.on('error', () => undefined);
    request.end(text);
    const isData = (call: ExecuteCall): boolean => call.templateId !== 'schema-indexes';
    await until(() => executor.calls.some(isData));
    const reading = executor.calls.filter(isData);
    request.destroy();
    await until(() => reading.every((call) => call.signal?.aborted === true));
    await until(() => events.some((event) => event.detail?.reason === 'cancelled'));
    expect(reading.map((call) => call.templateId)).toEqual([count]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(executor.calls.some((call) => call.templateId === run)).toBe(false);
    await app.close();
  });
});

describe('a pattern run through the pattern route, when the client closes the connection while its estimate is read', () => {
  it('stops the estimate and does not start the run, and the call is audited as cancelled', async () => {
    const { app, executor, events } = await listening();
    const text = JSON.stringify({ sourceId: 'demo', definition: { anchorType: 'hub', steps: [{ relationshipTypes: ['LINKED'], direction: 'out', arrivesAt: 'leaf' }] }, anchor: ref });
    const request = httpRequest({ host: '127.0.0.1', port: portOf(app), path: '/v1/patterns/run', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'idempotency-key': 'a-key-of-sixteen-characters-p' } });
    request.on('error', () => undefined);
    request.end(text);
    const isData = (call: ExecuteCall): boolean => call.templateId !== 'schema-indexes';
    await until(() => executor.calls.some(isData));
    const reading = executor.calls.filter(isData);
    request.destroy();
    await until(() => reading.every((call) => call.signal?.aborted === true));
    await until(() => events.some((event) => event.detail?.reason === 'cancelled' && event.action === 'pattern.count'));
    expect(reading.map((call) => call.templateId)).toEqual(['pattern-count']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(executor.calls.some((call) => call.templateId === 'pattern')).toBe(false);
    await app.close();
  });
});

describe('a saved pattern run, when the client closes the connection while its estimate is read', () => {
  it.each([
    ['a pattern built in the app', { kind: 'definition', definition: { anchorType: 'hub', steps: [{ relationshipTypes: ['LINKED'], direction: 'out', arrivesAt: 'leaf' }] } }, 'pattern-count', 'pattern'],
    ['a saved run of a preset', { kind: 'preset-run', presetId: 'linked-leaves', params: {} }, 'linked-entities-count', 'linked-entities'],
  ])('stops the estimate of %s, does not start the run, audits the call as cancelled and records no run', async (_name, saving, count, run) => {
    const { app, executor, events } = await listening();
    const base = `http://127.0.0.1:${portOf(app)}`;
    const made = await fetch(`${base}/v1/patterns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'demo', name: 'A pattern', ...saving }) });
    const { id } = (await made.json()) as { id: string };
    const text = JSON.stringify({ anchor: ref });
    const request = httpRequest({ host: '127.0.0.1', port: portOf(app), path: `/v1/patterns/${id}/run`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'idempotency-key': 'a-saved-key-of-sixteen-chars' } });
    request.on('error', () => undefined);
    request.end(text);
    const isData = (call: ExecuteCall): boolean => call.templateId !== 'schema-indexes';
    await until(() => executor.calls.some(isData));
    const reading = executor.calls.filter(isData);
    request.destroy();
    await until(() => reading.every((call) => call.signal?.aborted === true));
    await until(() => events.some((event) => event.detail?.reason === 'cancelled'));
    expect(reading.map((call) => call.templateId)).toEqual([count]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(executor.calls.some((call) => call.templateId === run)).toBe(false);
    const listed = (await (await fetch(`${base}/v1/patterns?sourceId=demo`)).json()) as { items: { lastRunAt: string | null }[] };
    expect(listed.items.map((item) => item.lastRunAt)).toEqual([null]);
    await app.close();
  });
});

/** Routes that read the source and are cancelled in a case of their own above (search more), and routes that read no source, each with its reason. */
const OTHER_CASES: Readonly<Record<string, string>> = {
  'POST /v1/search/entities/more': 'its own case, which first needs a cursor',
  'GET /v1/me': 'reads no source',
  'GET /v1/me/preferences': 'reads no source',
  'PUT /v1/me/preferences': 'reads no source',
  'GET /v1/ai/status': 'reads no source',
  'GET /v1/sources': 'reads no source',
  'GET /v1/sources/:id/profile': 'reads no source',
  'GET /v1/templates': 'reads no source',
  'POST /v1/sources/:id/test': 'the tester is called with no signal (below)',
  'POST /v1/graph/coverage': 'reads no source (below)',
  'POST /v1/patterns/:id/run': 'its own case above, which first needs a saved pattern',
  'POST /v1/patterns/validate': 'reads no source: it answers from the mapping and the definition, so there is nothing to cancel',
  'PUT /v1/patterns/:id': 'reads no source: it writes to the application database, so there is no source read to cancel',
  'DELETE /v1/patterns/:id': 'reads no source: it writes to the application database, so there is no source read to cancel',
  'GET /v1/patterns': 'reads no source: it reads the application database, so there is no source read to cancel',
  'POST /v1/patterns': 'reads no source: it writes to the application database, so there is no source read to cancel',
  'POST /v1/patterns/:id/copy': 'reads no source: it writes to the application database, so there is no source read to cancel',
  'POST /v1/patterns/preview': 'reads no source: it answers from the mapping and the definition, so there is nothing to cancel',
  'GET /v1/investigations': 'reads no source',
  'GET /v1/investigations/:id': 'reads no source',
  'PUT /v1/investigations/:id/draft': 'reads no source',
  'PUT /v1/investigations/:id': 'reads no source',
  'DELETE /v1/investigations/:id': 'reads no source',
  'POST /v1/investigations/:id/restore': 'reads no source',
  'POST /v1/investigations/:id/views/:viewId/delete': 'reads no source',
  'POST /v1/investigations/:id/status': 'reads no source',
  'POST /v1/investigations/:id/views': 'reads no source',
  'POST /v1/investigations/:id/views/:viewId/restore': 'reads no source',
  'GET /v1/views': 'reads no source',
  'GET /v1/investigations/:id/views': 'reads no source',
  'PUT /v1/investigations/:id/views/:viewId': 'reads no source',
};

/** The routes under /v1 that neither a case of ROUTES nor the list above names. */
export const uncancelledRoutes = (registered: readonly { readonly method: string; readonly url: string }[], cases: readonly string[]): string[] =>
  registered.filter((route) => route.method !== 'HEAD' && route.url.startsWith('/v1')).map((route) => `${route.method} ${route.url}`).filter((key) => !cases.includes(key) && !(key in OTHER_CASES));

describe('every route that reads the source has a cancellation case', () => {
  it('names each registered route in the cases or in the list of routes with a reason, so a new route cannot be left out', async () => {
    const { app } = await listening();
    const registered = registeredRoutesOf(app);
    const cases = [...ROUTES.map((route) => route.route), 'POST /v1/summary'];
    expect(uncancelledRoutes(registered, cases)).toEqual([]);
    expect(uncancelledRoutes(registered, cases.filter((key) => key !== 'GET /v1/edges/:ref'))).toEqual(['GET /v1/edges/:ref']);
    expect(uncancelledRoutes([...registered, { method: 'GET', url: '/v1/new-read/:id' }], cases)).toEqual(['GET /v1/new-read/:id']);
    for (const key of Object.keys(OTHER_CASES)) expect(registered.map((route) => `${route.method} ${route.url}`), key).toContain(key);
    await app.close();
  });
});

describe('the source test and the graph coverage routes', () => {
  it('are not cancelled by this: the tester is called with no signal, and coverage reads no source', async () => {
    const { app, executor } = await listening();
    const calls: object[] = [];
    const other = await buildApp({
      webRoot,
      logger: createLogger({ write: () => undefined }),
      store: memoryAppStore(),
      mapping,
      gate: testSourceGate(mapping, { executor }).gate,
      sourceTester: { run: (request) => (calls.push(request), Promise.reject(new Error('stop'))) },
    });
    await other.inject({ method: 'POST', url: '/v1/sources/demo/test' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('signal');
    const coverage = await other.inject({ method: 'POST', url: '/v1/graph/coverage', payload: { sourceId: 'demo', entities: [] } });
    expect(coverage.statusCode).toBeLessThan(500);
    expect(executor.calls).toEqual([]);
    await other.close();
    await app.close();
  });
});

async function routerStub(reply: string): Promise<Server> {
  const script = createAgentScript();
  let replies = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const content = script.content(body, () => reply);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `msg_${++replies}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: content.some((block) => block['type'] === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

describe('an assistant turn that runs an intent, when the client closes the connection', () => {
  it('stops the read of the intent and starts no further read', async () => {
    const stub = await routerStub('{"route":"ask","intent":"hubById","entities":{"id":"H-1"}}');
    const extension = createEnterpriseExtension({ modelBaseUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}` });
    const folder = makeAskFolder(['demo'], { hubById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'hub', stableId: '$id' } } } });
    expect(await extension.configure?.({}, { NEBURYX_ASK_API_KEY: 'a-test-key', NEBURYX_ASK_MAPPING_FOLDER: folder }, { sourceIds: ['demo'], features: { ask: false, summary: false, assistant: true } })).toEqual({ ok: true });
    extension.attachAudit?.({ record: async () => undefined });
    const { app, executor, events, mode } = await listening(extension);
    const base = `http://127.0.0.1:${portOf(app)}`;
    mode.answering = true;
    const opened = await fetch(`${base}/v1/investigations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'demo', entity: { sourceId: 'demo', ...ref } }) });
    const { investigation } = (await opened.json()) as { investigation: { id: string } };
    mode.answering = false;
    const before = executor.calls.length;
    const text = JSON.stringify({ sourceId: 'demo', investigationId: investigation.id, message: 'Show hub H-1', viewElementKeys: [] });
    const request = httpRequest({ host: '127.0.0.1', port: portOf(app), path: '/v1/assistant/turns', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } });
    request.on('error', () => undefined);
    request.end(text);
    const isData = (call: ExecuteCall): boolean => call.templateId !== 'schema-indexes';
    await until(() => executor.calls.slice(before).some(isData));
    const reading = executor.calls.slice(before).filter(isData);
    request.destroy();
    await until(() => reading.every((call) => call.signal?.aborted === true));
    await until(() => events.some((event) => event.action === 'assistant.ask'));
    expect(events.filter((event) => event.action === 'assistant.ask').map((event) => event.result)).toEqual(['failed']);
    const readsAtCancel = executor.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(executor.calls).toHaveLength(readsAtCancel);
    await app.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });
});
