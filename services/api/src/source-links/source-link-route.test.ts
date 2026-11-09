import { rmSync } from 'node:fs';
import { storedEdgeDetailSchema, edgeRefSegmentOf, errorResponseSchema, sourceLinkSegmentOf, type StoredEdgeRef } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { RequestCancelled } from '../errors.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { deriveReferenceKeys } from '../reference/keys.js';
import { createSourceAccess } from '../investigations/source-access.js';
import { createSourceLinkService } from './source-link-service.js';
import { makeToken } from '../reference/token.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode as relatedNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const MARKER_HOST = 'records.marker.test';
const keys = deriveReferenceKeys(Buffer.alloc(32, 7));

const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', link: `https://${MARKER_HOST}/w/{widgetId}` },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
  { type: 'person', label: 'Person', stable_id: 'idNo', pii: [{ property: 'idNo', class: 'text' }], link: `https://${MARKER_HOST}/p?id={idNo}`, link_carries_value: true },
  { type: 'secret', label: 'Secret', stable_id: 'secretNo', pii: [{ property: 'secretNo', class: 'text' }] },
];
const RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId', 'docId'], evidence_link: `https://${MARKER_HOST}/r/{recordId}` },
  { type: 'PLAIN', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'] },
  { type: 'NO_ID', from: 'widget', to: 'gadget', evidence: ['recordId'], evidence_link: `https://${MARKER_HOST}/r/{recordId}` },
];
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: ENTITIES, relationships: RELATIONSHIPS })), 'neburyx.yaml');
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const widget = plainNode(['Widget'], { widgetId: 'W-1' }, '4:s:1');
const relatedWidget = relatedNode(['Widget'], { widgetId: 'W-1' }, '4:s:1');
const relatedGadget = relatedNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:2');
const edgeRow = (type: string, properties: Record<string, unknown>) => ({ r: plainRelationship(type, relatedWidget, relatedGadget, properties, '5:s:1'), a: relatedWidget, b: relatedGadget });

type Answer = ExecuteOutcome | ((call: ExecuteCall) => ExecuteOutcome);

async function started(answer: Answer, options: { readonly auditFails?: boolean } = {}) {
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), (call) => Promise.resolve(typeof answer === 'function' ? answer(call) : answer)));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const audit = { record: (event: AuditEvent) => (options.auditFails === true && event.action === 'source.link' && event.result === 'success' ? Promise.reject(new Error('sink down')) : Promise.resolve(void events.push(event))) };
  const parts = testSourceGate(mapping, { executor, referenceKeys: keys, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit } });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, referenceKeys: keys, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit } });
  const linkEvents = () => events.filter((event) => event.action === 'source.link');
  return { app, executor, events, linkEvents };
}

const entityUrl = (entityType: string, stableId: string, query = '') => `/v1/source-links/${encodeURIComponent(sourceLinkSegmentOf({ form: 'entity', ref: { sourceId: 'demo', entityType, stableId } }))}${query}`;
const edgeRef = (type = 'MADE_FROM'): StoredEdgeRef => ({ sourceId: 'demo', type, from: 'widget', to: 'gadget', stableId: 'L-1' });
const edgeUrl = (ref: StoredEdgeRef, query = '') => `/v1/source-links/${encodeURIComponent(edgeRefSegmentOf(ref))}${query}`;
type App = Awaited<ReturnType<typeof started>>['app'];
const withoutTrace = (body: unknown) => {
  const { traceId: _trace, ...error } = errorResponseSchema.parse(body).error;
  return error;
};
const pageWithoutTrace = (response: { readonly body: string; readonly headers: Record<string, unknown> }): string => response.body.replaceAll(String(response.headers['x-trace-id']), 'TRACE');
const get = (app: App, url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

const widgetAnswer = entityRows(widget);
const personAnswer = entityRows(plainNode(['Person'], { idNo: 'ID 12/3' }, '4:s:3'));
const linkedEdge = edgeRow('MADE_FROM', { linkId: 'L-1', recordId: 'R-1', docId: 'D-1' });

describe('GET /v1/source-links/{ref} for an entity', () => {
  it('redirects to the template with the ID percent-encoded, with no body, no cache and no referrer, and writes one source.link event holding neither the address nor the ID', async () => {
    const { app, linkEvents } = await started(widgetAnswer);
    const response = await get(app, entityUrl('widget', 'W-1'));
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe(`https://${MARKER_HOST}/w/W-1`);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).toBe('');
    expect(linkEvents()).toEqual([{ actorId: expect.any(String), actorRole: expect.any(String), action: 'source.link', result: 'success', sourceId: 'demo', traceId: expect.any(String), detail: { target: 'entity', type: 'widget' } }]);
    expect(JSON.stringify(linkEvents())).not.toContain(MARKER_HOST);
    expect(JSON.stringify(linkEvents())).not.toContain('W-1');
    await app.close();
  });

  it('reads the entity through the gate before it redirects', async () => {
    const { app, executor } = await started(widgetAnswer);
    await get(app, entityUrl('widget', 'W-1'));
    expect(executor.calls.filter((call) => call.templateId === 'entity-load')).toHaveLength(1);
    await app.close();
  });

  it('builds the address of a keyed type from the token when the request is not masked and the mapping opts in', async () => {
    const { app } = await started(personAnswer);
    const token = makeToken(keys, { sourceId: 'demo', entityType: 'person' }, 'ID 12/3');
    const response = await get(app, entityUrl('person', token));
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe(`https://${MARKER_HOST}/p?id=ID%2012%2F3`);
    await app.close();
  });

  it('answers one NOT_FOUND, with the same body and headers, for every refusal, and writes no success event', async () => {
    const token = makeToken(keys, { sourceId: 'demo', entityType: 'person' }, 'ID 12/3');
    const secretToken = makeToken(keys, { sourceId: 'demo', entityType: 'secret' }, 'S-1');
    const cases: readonly { readonly name: string; readonly url: string; readonly headers?: Record<string, string>; readonly answer?: Answer }[] = [
      { name: 'no template', url: entityUrl('gadget', 'GT-1') },
      { name: 'an entity type the mapping does not have', url: entityUrl('nothing', 'X') },
      { name: 'a source that is not configured', url: `/v1/source-links/${encodeURIComponent(sourceLinkSegmentOf({ form: 'entity', ref: { sourceId: 'other', entityType: 'widget', stableId: 'W-1' } }))}` },
      { name: 'an entity the source does not have', url: entityUrl('widget', 'W-9'), answer: entityRows() },
      { name: 'a keyed type while masked', url: entityUrl('person', token, '?mask=true'), answer: personAnswer },
      { name: 'a keyed type without the opt-in', url: entityUrl('secret', secretToken), answer: entityRows(plainNode(['Secret'], { secretNo: 'S-1' }, '4:s:4')) },
      { name: 'a value that is only dots', url: entityUrl('widget', '..'), answer: entityRows(plainNode(['Widget'], { widgetId: '..' }, '4:s:5')) },
      { name: 'a request another site started', url: entityUrl('widget', 'W-1'), headers: { 'sec-fetch-site': 'cross-site' } },
      { name: 'a prefetch', url: entityUrl('widget', 'W-1'), headers: { 'sec-purpose': 'prefetch' } },
    ];
    const answers: { status: number; body: unknown; headers: Record<string, unknown> }[] = [];
    for (const refused of cases) {
      const { app, linkEvents } = await started(refused.answer ?? widgetAnswer);
      const response = await get(app, refused.url, refused.headers);
      expect(response.statusCode, refused.name).toBe(404);
      expect(response.headers['location'], refused.name).toBeUndefined();
      expect(linkEvents().filter((event) => event.result === 'success'), refused.name).toEqual([]);
      const { 'x-trace-id': _trace, 'content-length': _length, date: _date, ...headers } = response.headers;
      expect(response.headers['content-type'], refused.name).toBe('text/html; charset=utf-8');
      answers.push({ status: response.statusCode, body: pageWithoutTrace(response), headers });
      await app.close();
    }
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it('shows one short page for every refusal: the same words, the trace ID, no reason, no record, no script, no cache, no referrer', async () => {
    const { app } = await started(widgetAnswer);
    const response = await get(app, entityUrl('gadget', 'GT-1'));
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
    expect(response.headers['content-security-policy']).not.toMatch(/script|unsafe/);
    expect(response.body).toContain("This source record can't be opened from Neburyx.");
    expect(response.body).toContain(String(response.headers['x-trace-id']));
    expect(response.body).not.toMatch(/<script|gadget|GT-1|widget|records\.marker|not found|template/i);
    await app.close();
  });

  it('keeps the JSON body, byte-identical apart from the trace ID for every refusal kind, for a request that asks for JSON and not for a page, and shows the page for a browser that asks for both', async () => {
    const token = makeToken(keys, { sourceId: 'demo', entityType: 'person' }, 'ID 12/3');
    const kinds: readonly { readonly url: string; readonly answer?: Answer }[] = [
      { url: entityUrl('gadget', 'GT-1') },
      { url: entityUrl('widget', 'W-9'), answer: entityRows() },
      { url: entityUrl('person', token, '?mask=true'), answer: personAnswer },
      { url: `/v1/source-links/${encodeURIComponent(sourceLinkSegmentOf({ form: 'entity', ref: { sourceId: 'other', entityType: 'widget', stableId: 'W-1' } }))}` },
      { url: edgeUrl(edgeRef(), '?record=R-9'), answer: rows(linkedEdge) },
    ];
    const bodies: unknown[] = [];
    for (const kind of kinds) {
      const { app } = await started(kind.answer ?? widgetAnswer);
      const response = await get(app, kind.url, { accept: 'application/json' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['cache-control']).toBe('no-store');
      bodies.push(withoutTrace(response.json()));
      await app.close();
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    const { app } = await started(widgetAnswer);
    const browser = await get(app, entityUrl('gadget', 'GT-1'), { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' });
    expect(browser.headers['content-type']).toBe('text/html; charset=utf-8');
    await app.close();
  });

  it('serves a request that is same-origin, started by the address bar, or sent with neither header', async () => {
    const same: readonly Record<string, string>[] = [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}];
    for (const headers of same) {
      const { app } = await started(widgetAnswer);
      expect((await get(app, entityUrl('widget', 'W-1'), headers)).statusCode).toBe(302);
      await app.close();
    }
  });

  it('audits denied for an unreadable source and refused for the other refusals', async () => {
    const { app, linkEvents } = await started(widgetAnswer);
    await get(app, entityUrl('gadget', 'GT-1'));
    await get(app, `/v1/source-links/${encodeURIComponent(sourceLinkSegmentOf({ form: 'entity', ref: { sourceId: 'other', entityType: 'widget', stableId: 'W-1' } }))}`);
    expect(linkEvents().map((event) => event.result)).toEqual(['refused', 'denied']);
    await app.close();
  });

  it('answers INVALID_REQUEST for a segment that does not parse, an aggregate or derived reference, a record on an entity link and an unknown query key, and reads nothing', async () => {
    const { app, executor, events } = await started(widgetAnswer);
    const aggregate = encodeURIComponent(Buffer.from(JSON.stringify({ sourceId: 'demo', type: 'MADE_FROM', from: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, to: { sourceId: 'demo', entityType: 'gadget', stableId: 'GT-1' } })).toString('base64url'));
    for (const url of ['/v1/source-links/not-base64!', `/v1/source-links/${'a'.repeat(2049)}`, `/v1/source-links/${aggregate}`, entityUrl('widget', 'W-1', '?record=R-1'), entityUrl('widget', 'W-1', '?other=1')]) {
      expect((await get(app, url)).statusCode, url).toBe(400);
    }
    expect(executor.calls.filter((call) => call.templateId === 'entity-load')).toEqual([]);
    expect(events).toEqual([]);
    await app.close();
  });

  it('sends no redirect and answers INTERNAL_ERROR when the success event cannot be written', async () => {
    const { app } = await started(widgetAnswer, { auditFails: true });
    const response = await get(app, entityUrl('widget', 'W-1'));
    expect(response.statusCode).toBe(500);
    expect(response.headers['location']).toBeUndefined();
    await app.close();
  });

  it('answers the gate\'s SOURCE_UNAVAILABLE as the entity route does and audits failed', async () => {
    const { app, linkEvents } = await started({ status: 'failure', reason: 'unreachable' } as unknown as ExecuteOutcome);
    const response = await get(app, entityUrl('widget', 'W-1'));
    expect([503, 504, 500]).toContain(response.statusCode);
    expect(response.headers['location']).toBeUndefined();
    expect(linkEvents().map((event) => event.result)).toEqual(['failed']);
    await app.close();
  });

  it('has no HEAD route', async () => {
    const { app } = await started(widgetAnswer);
    const response = await app.inject({ method: 'HEAD', url: entityUrl('widget', 'W-1') });
    expect(response.statusCode).not.toBe(302);
    await app.close();
  });
});

describe('GET /v1/source-links/{edgeRef}?record=', () => {
  it('redirects to the evidence template with the record percent-encoded and writes one source.link event of target evidence', async () => {
    const { app, linkEvents } = await started(rows(linkedEdge));
    const response = await get(app, edgeUrl(edgeRef(), '?record=R-1'));
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe(`https://${MARKER_HOST}/r/R-1`);
    expect(response.body).toBe('');
    expect(linkEvents()).toEqual([expect.objectContaining({ result: 'success', detail: { target: 'evidence', type: 'MADE_FROM' } })]);
    await app.close();
  });

  it('refuses, with the same NOT_FOUND, a record in the property the template does not name, a record the edge does not carry, a row without a template, an edge that is not there, and a record that cannot be an address', async () => {
    const cases: readonly { readonly url: string; readonly answer: Answer }[] = [
      { url: edgeUrl(edgeRef(), '?record=D-1'), answer: rows(linkedEdge) },
      { url: edgeUrl(edgeRef(), '?record=R-9'), answer: rows(linkedEdge) },
      { url: edgeUrl(edgeRef('PLAIN'), '?record=R-1'), answer: rows(edgeRow('PLAIN', { linkId: 'L-1', recordId: 'R-1' })) },
      { url: edgeUrl(edgeRef(), '?record=R-1'), answer: { status: 'rows', rows: [] } },
      { url: edgeUrl(edgeRef(), '?record=..'), answer: rows(edgeRow('MADE_FROM', { linkId: 'L-1', recordId: '..' })) },
      { url: edgeUrl(edgeRef(), `?record=${'x'.repeat(5000)}`), answer: rows(edgeRow('MADE_FROM', { linkId: 'L-1', recordId: 'x'.repeat(5000) })) },
    ];
    const bodies: unknown[] = [];
    for (const refused of cases) {
      const { app, linkEvents } = await started(refused.answer);
      const response = await get(app, refused.url);
      expect(response.statusCode, refused.url.slice(-30)).toBe(404);
      expect(response.headers['location']).toBeUndefined();
      expect(linkEvents().filter((event) => event.result === 'success')).toEqual([]);
      bodies.push(pageWithoutTrace(response));
      await app.close();
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
  });

  it('opens a record whose text is held by two evidence properties when one of them is the placeholder', async () => {
    const { app } = await started(rows(edgeRow('MADE_FROM', { linkId: 'L-1', recordId: 'SAME', docId: 'SAME' })));
    expect((await get(app, edgeUrl(edgeRef(), '?record=SAME'))).statusCode).toBe(302);
    await app.close();
  });

  it('opens a record the doc property holds first when the placeholder property holds the same text too', async () => {
    const { app } = await started(rows(edgeRow('MADE_FROM', { linkId: 'L-1', recordId: 'SAME', docId: 'SAME' })));
    const edge = await get(app, `/v1/edges/${encodeURIComponent(edgeRefSegmentOf(edgeRef()))}`);
    expect(storedEdgeDetailSchema.parse(edge.json()).evidence).toEqual({ status: 'available', records: [{ sourceRecordId: 'SAME', linkable: true }] });
    await app.close();
  });

  it('answers INVALID_REQUEST for no record, an empty record, an entity-sized record over the bound, and an aggregate-form segment', async () => {
    const { app } = await started(rows(linkedEdge));
    for (const url of [edgeUrl(edgeRef()), edgeUrl(edgeRef(), '?record='), edgeUrl(edgeRef(), `?record=${'x'.repeat(100_001)}`)]) {
      expect((await get(app, url)).statusCode, url.slice(-20)).toBe(400);
    }
    await app.close();
  });

  it('marks a record linkable on the edge route exactly when the link would open it', async () => {
    const cases: readonly [Record<string, unknown>, string, boolean][] = [
      [{ linkId: 'L-1', recordId: 'R-1' }, 'R-1', true],
      [{ linkId: 'L-1', docId: 'D-1' }, 'D-1', false],
      [{ linkId: 'L-1', recordId: '..' }, '..', false],
      [{ linkId: 'L-1', recordId: 'y'.repeat(5000) }, 'y'.repeat(5000), false],
    ];
    for (const [properties, record, linkable] of cases) {
      const { app } = await started(rows(edgeRow('MADE_FROM', properties)));
      const edge = await get(app, `/v1/edges/${encodeURIComponent(edgeRefSegmentOf(edgeRef()))}`);
      expect(storedEdgeDetailSchema.parse(edge.json()).evidence).toEqual({ status: 'available', records: [{ sourceRecordId: record, linkable }] });
      await app.close();
    }
  });

  it('writes no source.link event for a request whose read was cancelled', async () => {
    const events: AuditEvent[] = [];
    const cancelled = { read: cancelledRead };
    const defaults = communitySeams();
    const service = createSourceLinkService({ mapping, access: createSourceAccess({ mapping, seams: defaults, logger: { warn: () => undefined } }), entities: cancelled, edges: cancelled, audit: { record: (event) => Promise.resolve(void events.push(event)) }, references: keys, logger: { warn: () => undefined } });
    const principal = (await memoryAppStore().current()).principal;
    await expect(service.open({ traceId: 'tr-1', principal, link: { form: 'stored', ref: edgeRef() }, record: 'R-1', mask: false, headers: {} })).rejects.toBeInstanceOf(RequestCancelled);
    expect(events).toEqual([]);
  });
});

function cancelledRead(): never {
  throw new RequestCancelled();
}

const rows = (...list: readonly Record<string, unknown>[]): ExecuteOutcome => ({ status: 'rows', rows: [...list] });
