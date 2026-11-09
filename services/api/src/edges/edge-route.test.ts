import { rmSync } from 'node:fs';
import { storedEdgeDetailSchema, edgeRefSegmentOf, MAX_EDGE_REF_SEGMENT, type StoredEdgeRef } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import type { AuditEvent } from '../seams/seams.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema, type IndexRow } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', title: '{ownerName}', pii: [{ property: 'ownerName', class: 'name' }] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
];
const RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', observed_at: 'seenAt', evidence: ['recordId', 'docId'], evidence_link: 'https://audit.example.test/records/{recordId}' },
  { type: 'PLAIN', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'] },
  { type: 'BARE', from: 'widget', to: 'gadget', stable_id: 'linkId' },
  { type: 'NO_ID', from: 'widget', to: 'gadget', evidence: ['recordId'] },
];
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: ENTITIES, relationships: RELATIONSHIPS })), 'neburyx.yaml');
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const widget = plainNode(['Widget'], { widgetId: 'W-1', ownerName: 'Ana Silva' }, '4:s:1');
const gadget = plainNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:2');
const row = (type: string, properties: Record<string, unknown>, elementId = '5:s:1') => ({ r: plainRelationship(type, widget, gadget, properties, elementId), a: widget, b: gadget });
const rows = (...list: readonly Record<string, unknown>[]): ExecuteOutcome => ({ status: 'rows', rows: [...list] });

const REF: StoredEdgeRef = { sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };
const urlOf = (ref: StoredEdgeRef, query = '') => `/v1/edges/${encodeURIComponent(edgeRefSegmentOf(ref))}${query}`;

interface Options {
  readonly answer?: ExecuteOutcome | ((call: ExecuteCall) => ExecuteOutcome);
  readonly indexes?: (online: readonly IndexRow[]) => readonly IndexRow[];
}

async function started(options: Options = {}) {
  const online = onlineIndexesOf(source ?? (() => { throw new Error('no source'); })());
  const answer = options.answer ?? rows(row('MADE_FROM', { linkId: 'L-1', recordId: 'R-1', seenAt: '2026-10-21T08:15:00Z' }));
  const executor = new TestExecutor(withSchema(() => schemaAnswer(options.indexes?.(online) ?? online), (call) => Promise.resolve(typeof answer === 'function' ? answer(call) : answer)));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const parts = testSourceGate(mapping, { executor, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event) => Promise.resolve(void events.push(event)) } } });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate });
  const edgeCalls = () => executor.calls.filter((call) => call.templateId === 'edge-load');
  return { app, executor, events, edgeCalls };
}

const get = (app: Awaited<ReturnType<typeof started>>['app'], url: string) => app.inject({ method: 'GET', url });

describe('GET /v1/edges/{ref}', () => {
  it('answers 200 with the edge, its two ends, its time and its records, reads it as one fixed statement of two rows and writes one audit event', async () => {
    const { app, edgeCalls, events } = await started();
    const response = await get(app, urlOf(REF));
    expect(response.statusCode).toBe(200);
    const detail = storedEdgeDetailSchema.parse(response.json());
    expect(detail.ref).toEqual(REF);
    expect(detail.type).toBe('MADE_FROM');
    expect(detail.semantics).toBe('stored');
    expect(detail.from).toEqual({ ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, title: 'Ana Silva', type: 'widget' });
    expect(detail.to.ref).toEqual({ sourceId: 'demo', entityType: 'gadget', stableId: 'GT-1' });
    expect(detail.observedAt).toBe('2026-10-21T08:15:00Z');
    expect(detail.evidence).toEqual({ status: 'available', records: [{ sourceRecordId: 'R-1', linkable: true }] });
    const [call] = edgeCalls();
    expect(call).toMatchObject({ templateId: 'edge-load', accessMode: 'READ', rowLimit: 2 });
    expect(call?.cypher).toBe('MATCH (a:`Widget`)-[r:`MADE_FROM`]->(b:`Gadget`) WHERE r.`linkId` IN [$stableId, $stableInteger] RETURN r, a, b ORDER BY elementId(r) LIMIT $limit + 1');
    expect(events.filter((event) => event.action === 'edge.load')).toEqual([expect.objectContaining({ result: 'success', sourceId: 'demo' })]);
    await app.close();
  });

  it('says linkable only when the mapping gives the evidence a link, and sends no URL', async () => {
    const plain = await started({ answer: rows(row('PLAIN', { linkId: 'L-1', recordId: 'R-1' })) });
    const detail = storedEdgeDetailSchema.parse((await get(plain.app, urlOf({ ...REF, type: 'PLAIN' }))).json());
    expect(detail.evidence).toEqual({ status: 'available', records: [{ sourceRecordId: 'R-1', linkable: false }] });
    expect(JSON.stringify(detail)).not.toContain('audit.example.test');
    await plain.app.close();
    const linked = await started();
    expect(JSON.stringify((await get(linked.app, urlOf(REF))).json())).not.toContain('audit.example.test');
    await linked.app.close();
  });

  it('masks the title of an end when asked, and sends no personal value either way in a property', async () => {
    const { app } = await started();
    const masked = storedEdgeDetailSchema.parse((await get(app, urlOf(REF, '?mask=true'))).json());
    expect(JSON.stringify(masked)).not.toContain('Ana Silva');
    const plain = storedEdgeDetailSchema.parse((await get(app, urlOf(REF))).json());
    expect(plain.from.title).toBe('Ana Silva');
    await app.close();
  });

  it('lists the readable and the unreadable record, once each', async () => {
    const { app } = await started({ answer: rows(row('MADE_FROM', { linkId: 'L-1', recordId: 'R-1', docId: [1, 2] })) });
    const detail = storedEdgeDetailSchema.parse((await get(app, urlOf(REF))).json());
    expect(detail.evidence).toEqual({ status: 'available', records: [{ sourceRecordId: 'R-1', linkable: true }, { property: 'docId', unreadable: true }] });
    await app.close();
  });

  it('answers 200 with the first edge flagged when the source holds two with the same type, ends and stable ID', async () => {
    const { app } = await started({ answer: rows(row('MADE_FROM', { linkId: 'L-1', recordId: 'R-1' }, '5:s:1'), row('MADE_FROM', { linkId: 'L-1', recordId: 'R-2' }, '5:s:2')) });
    const detail = storedEdgeDetailSchema.parse((await get(app, urlOf(REF))).json());
    expect(detail.qualityFlags).toContain('conflicting-duplicate');
    expect(detail.evidence).toEqual({ status: 'available', records: [{ sourceRecordId: 'R-1', linkable: true }] });
    await app.close();
  });
});

describe('an edge with no retained records', () => {
  it.each([
    ['a mapping row with no evidence property', 'BARE', { linkId: 'L-1' }],
    ['evidence properties that are empty on this edge', 'MADE_FROM', { linkId: 'L-1', recordId: '', docId: null }],
    ['evidence properties the edge lacks', 'MADE_FROM', { linkId: 'L-1' }],
  ])('answers 200 with the not-available state, and the time and properties still there, for %s', async (_name, type, properties) => {
    const { app } = await started({ answer: rows(row(type, { ...properties, seenAt: '2026-10-21T08:15:00Z' })) });
    const response = await get(app, urlOf({ ...REF, type }));
    expect(response.statusCode).toBe(200);
    const detail = storedEdgeDetailSchema.parse(response.json());
    expect(detail.evidence).toEqual({ status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' });
    expect(detail.observedAt).toBe(type === 'MADE_FROM' ? '2026-10-21T08:15:00Z' : undefined);
    expect(detail.properties.map((property) => property.key)).not.toContain('linkId');
    await app.close();
  });

  it('never answers EVIDENCE_NOT_AVAILABLE as an error response', async () => {
    const { app } = await started({ answer: rows(row('BARE', { linkId: 'L-1' })) });
    const response = await get(app, urlOf({ ...REF, type: 'BARE' }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('error');
    await app.close();
  });
});

describe('a reference the route refuses before any read', () => {
  const encode = (text: string) => Buffer.from(text).toString('base64url');
  const aggregate = { sourceId: 'demo', aggregate: { type: 'T', from: { sourceId: 'demo', entityType: 'a', stableId: '1' }, to: { sourceId: 'demo', entityType: 'b', stableId: '2' } } };
  const REFUSED: readonly (readonly [string, string])[] = [
    ['text outside the base64url alphabet', '/v1/edges/ab+c'],
    ['padding', `/v1/edges/${edgeRefSegmentOf(REF)}=`],
    ['text that is not JSON', `/v1/edges/${encode('not json')}`],
    ['a reference with an unknown key', `/v1/edges/${encode(JSON.stringify({ ...REF, extra: 1 }))}`],
    ['a reference with a missing key', `/v1/edges/${encode(JSON.stringify({ sourceId: 'demo', type: 'T', from: 'a', to: 'b' }))}`],
    ['an aggregate reference', `/v1/edges/${encode(JSON.stringify(aggregate))}`],
    ['a derived reference', `/v1/edges/${encode(JSON.stringify({ sourceId: 'demo', derived: { ruleId: 'R', from: aggregate.aggregate.from, to: aggregate.aggregate.to } }))}`],
    ['a segment over the bound', `/v1/edges/${'a'.repeat(MAX_EDGE_REF_SEGMENT + 1)}`],
    ['a query parameter other than mask', `${urlOf(REF)}?limit=1`],
    ['a mask that is not true or false', `${urlOf(REF)}?mask=yes`],
    ['an edge type the mapping does not name', urlOf({ ...REF, type: 'NOTHING' })],
    ['ends the row does not map', urlOf({ ...REF, from: 'gadget', to: 'widget' })],
    ['a row with no stable ID', urlOf({ ...REF, type: 'NO_ID' })],
  ];

  it.each(REFUSED)('answers INVALID_REQUEST for %s and reads nothing', async (_name, url) => {
    const { app, edgeCalls } = await started();
    const response = await get(app, url);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(edgeCalls()).toEqual([]);
    await app.close();
  });

  it('accepts a segment at the bound as far as the reference goes, and a valid encoding with the keys in another order', async () => {
    const { app, edgeCalls } = await started();
    const reordered = encode(JSON.stringify({ stableId: 'L-1', to: 'gadget', from: 'widget', type: 'MADE_FROM', sourceId: 'demo' }));
    expect((await get(app, `/v1/edges/${reordered}`)).statusCode).toBe(200);
    expect(edgeCalls()).toHaveLength(1);
    await app.close();
  });
});

describe('an edge the person cannot be told about', () => {
  it('answers NOT_FOUND for an edge the source does not hold, with the same body whatever the ID', async () => {
    const { app } = await started({ answer: rows() });
    const first = await get(app, urlOf({ ...REF, stableId: 'L-404' }));
    const second = await get(app, urlOf({ ...REF, stableId: 'other' }));
    expect(first.statusCode).toBe(404);
    expect(first.json().error.code).toBe('NOT_FOUND');
    expect({ ...second.json().error, traceId: undefined }).toEqual({ ...first.json().error, traceId: undefined });
    await app.close();
  });

  it('answers NOT_FOUND for a source that is not configured, without reading anything', async () => {
    const { app, executor } = await started();
    const response = await get(app, urlOf({ ...REF, sourceId: 'nope' }));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(executor.calls).toEqual([]);
    await app.close();
  });
});

describe('a read that cannot be answered', () => {
  it.each([
    ['a source that is down', { status: 'unavailable', reason: 'unreachable' } as const, 503, 'SOURCE_UNAVAILABLE'],
    ['a read that outlasts the source timeout', { status: 'timeout' } as const, 504, 'QUERY_TIMEOUT'],
  ])('answers %s with the code of the error table, the trace ID and no partial answer', async (_name, answer, status, code) => {
    const { app, events } = await started({ answer });
    const response = await get(app, urlOf(REF));
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toMatchObject({ code, traceId: expect.any(String) });
    expect(response.json()).not.toHaveProperty('evidence');
    expect(events.filter((event) => event.action === 'edge.load').map((event) => event.result)).toEqual(['failed']);
    await app.close();
  });

  it.each([
    ['no index', (online: readonly IndexRow[]) => online.filter((entry) => !(entry.entityType === 'RELATIONSHIP' && entry.name === 'MADE_FROM' && entry.property === 'linkId'))],
    ['a failed index', (online: readonly IndexRow[]) => online.map((entry) => (entry.entityType === 'RELATIONSHIP' && entry.name === 'MADE_FROM' && entry.property === 'linkId' ? { ...entry, state: 'FAILED' } : entry))],
    ['an index being built', (online: readonly IndexRow[]) => online.map((entry) => (entry.entityType === 'RELATIONSHIP' && entry.name === 'MADE_FROM' && entry.property === 'linkId' ? { ...entry, state: 'POPULATING' } : entry))],
  ])('answers SOURCE_UNAVAILABLE with an index reason and reads no data for %s on the stable ID', async (_name, indexes) => {
    const { app, edgeCalls } = await started({ indexes });
    const response = await get(app, urlOf(REF));
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('SOURCE_UNAVAILABLE');
    expect(response.json().error.details.reason).toMatch(/^index-/);
    expect(edgeCalls()).toEqual([]);
    await app.close();
  });

  it('answers SOURCE_UNAVAILABLE with index-list-unreadable and reads no data when the index list is cut', async () => {
    const online = onlineIndexesOf(source ?? (() => { throw new Error('no source'); })());
    const executor = new TestExecutor(withSchema(() => schemaAnswer(online, true), () => Promise.resolve(rows(row('MADE_FROM', { linkId: 'L-1', recordId: 'R-1' })))));
    const parts = testSourceGate(mapping, { executor });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate });
    const response = await get(app, urlOf(REF));
    expect(response.json().error.details.reason).toBe('index-list-unreadable');
    expect(executor.calls.filter((call) => call.templateId === 'edge-load')).toEqual([]);
    await app.close();
  });

  it('answers INTERNAL_ERROR, never NOT_FOUND, for an edge whose end cannot be made a node', async () => {
    const { app } = await started({ answer: rows({ r: plainRelationship('MADE_FROM', widget, gadget, { linkId: 'L-1' }), a: plainNode(['Widget'], { widgetId: null }, '4:s:1'), b: gadget }) });
    const response = await get(app, urlOf(REF));
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.json().error).not.toHaveProperty('details');
    await app.close();
  });
});

describe('what the answer holds beside the evidence', () => {
  it('leaves the stable ID and the observed time to their own fields and keeps the other mapped properties', async () => {
    const { app } = await started({ answer: rows(row('MADE_FROM', { linkId: 'L-1', recordId: 'R-1', seenAt: '2026-10-21T08:15:00Z', docId: 'D-1' })) });
    const detail = storedEdgeDetailSchema.parse((await get(app, urlOf(REF))).json());
    expect(detail.observedAt).toBe('2026-10-21T08:15:00Z');
    expect(detail.properties.map((property) => property.key)).toEqual(['recordId', 'docId']);
    await app.close();
  });
});
