import { rmSync } from 'node:fs';
import { MAX_REFERENCE_VALUE_CHARACTERS, nodeSchema, openInvestigationResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { makeToken } from './token.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const PHONE = '+1-212-555-0100';
const mapping = mappingOf(
  sourceWith('alpha', {
    entities: [
      { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
      { type: 'thing', label: 'Thing', stable_id: 'thingId', display: { name: 'Thing record' } },
    ],
    relationships: [{ type: 'USES', from: 'thing', to: 'phone' }],
    derived: [],
  }),
);
const [source] = mapping.sources;
if (source === undefined) throw new Error('no source');
const token = (value: string, sourceId = 'alpha', entityType = 'phone') => makeToken(TEST_REFERENCE_KEYS, { sourceId, entityType }, value);

async function started() {
  const loads: ExecuteCall[] = [];
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    loads.push(call);
    const value = call.parameters['stableId'];
    const isHandle = call.cypher.includes('`Handle`');
    return Promise.resolve(entityRows(isHandle ? plainNode(['Handle'], { phoneNumber: value }) : plainNode(['Thing'], { thingId: value })));
  };
  const executor = new TestExecutor(withOnlineIndexes(source ?? (() => { throw new Error('no source'); })(), answer));
  const store = memoryAppStore();
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor, referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
  const lookup = (payload: object) => app.inject({ method: 'POST', url: '/v1/entities/lookup', payload });
  const open = (payload: object) => app.inject({ method: 'POST', url: '/v1/investigations', payload });
  return { app, store, lookup, open, loads: () => loads.filter((call) => call.templateId === 'entity-load') };
}

const byRef = (entityType: string, stableId: string, extra: object = {}) => ({ sourceId: 'alpha', ref: { entityType, stableId }, ...extra });
const byValue = (entityType: string, value: string, extra: object = {}) => ({ sourceId: 'alpha', value: { entityType, value }, ...extra });

describe('POST /v1/entities/lookup', () => {
  it('answers a keyed node by its token, and the statement gets the value', async () => {
    const { app, lookup, loads } = await started();
    const response = await lookup(byRef('phone', token(PHONE)));
    expect(response.statusCode).toBe(200);
    expect(nodeSchema.parse(response.json()).ref.stableId).toBe(token(PHONE));
    expect(loads()[0]?.parameters['stableId']).toBe(PHONE);
    await app.close();
  });

  it('answers a keyed node by its raw value when the request is not masked, with the token as its reference', async () => {
    const { app, lookup } = await started();
    for (const extra of [{}, { mask: false }]) {
      const response = await lookup(byValue('phone', PHONE, extra));
      expect(response.statusCode).toBe(200);
      expect(response.json().ref).toEqual({ sourceId: 'alpha', entityType: 'phone', stableId: token(PHONE) });
    }
    await app.close();
  });

  it('refuses a raw value of a keyed type while masked, and reads nothing', async () => {
    const { app, lookup, loads } = await started();
    const response = await lookup(byValue('phone', PHONE, { mask: true }));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(loads()).toEqual([]);
    await app.close();
  });

  it('answers a keyed node by its token while masked, with its value masked', async () => {
    const { app, lookup } = await started();
    const response = await lookup(byRef('phone', token(PHONE), { mask: true }));
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain(PHONE);
    await app.close();
  });

  it.each([
    ['a long ID', 'x'.repeat(2000)],
    ['an ID of dots only', '..'],
    ['a lone dot', '.'],
    ['an ID with a control character', 'a\u0000b'],
    ['an unpaired surrogate', '\ud800'],
    ['an ID with a slash and a percent sign', 'a/b%2Fc'],
  ])('answers a node of a type that is not keyed with %s, by reference and by value', async (_name, id) => {
    const { app, lookup, loads } = await started();
    for (const payload of [byRef('thing', id), byValue('thing', id)]) {
      const response = await lookup(payload);
      expect(response.statusCode, _name).toBe(200);
      expect(response.json().ref.stableId).toBe(id);
    }
    expect(loads().every((call) => call.parameters['stableId'] === id)).toBe(true);
    await app.close();
  });

  it('reads a raw value that starts with the tag as a value when it is sent as one, and as a bad token when it is sent as a reference', async () => {
    const { app, lookup, loads } = await started();
    const asValue = await lookup(byValue('phone', 'p1.not-a-token'));
    expect(asValue.statusCode).toBe(200);
    expect(loads()[0]?.parameters['stableId']).toBe('p1.not-a-token');
    expect((await lookup(byRef('phone', 'p1.not-a-token'))).statusCode).toBe(400);
    await app.close();
  });

  it('carries the largest value through a body and its token through the next request', async () => {
    const { app, lookup } = await started();
    const value = '😀'.repeat(MAX_REFERENCE_VALUE_CHARACTERS / 2);
    const first = await lookup(byValue('phone', value));
    expect(first.statusCode).toBe(200);
    const reference = first.json().ref.stableId;
    expect(reference).toBe(token(value));
    const second = await lookup(byRef('phone', reference));
    expect(second.statusCode).toBe(200);
    expect(second.json().ref.stableId).toBe(reference);
    await app.close();
  });

  it('refuses a value over the limit', async () => {
    const { app, lookup, loads } = await started();
    expect((await lookup(byValue('thing', 'x'.repeat(MAX_REFERENCE_VALUE_CHARACTERS + 1)))).statusCode).toBe(400);
    expect(loads()).toEqual([]);
    await app.close();
  });

  it.each([
    ['a token of another source', () => byRef('phone', token(PHONE, 'beta'))],
    ['a token of another entity type', () => byRef('phone', token(PHONE, 'alpha', 'thing'))],
    ['a raw value as a reference', () => byRef('phone', PHONE)],
    ['a bit-flipped token', () => byRef('phone', token(PHONE).replace(/.$/, (last) => (last === 'A' ? 'B' : 'A')))],
  ])('refuses %s with the same body as any other bad reference', async (_name, payload) => {
    const { app, lookup, loads } = await started();
    const response = await lookup(payload());
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(loads()).toEqual([]);
    await app.close();
  });

  it.each([
    ['both forms at once', { sourceId: 'alpha', ref: { entityType: 'thing', stableId: 'a' }, value: { entityType: 'thing', value: 'a' } }],
    ['an empty value', byValue('thing', '')],
    ['an unknown field', byValue('thing', 'a', { cap: 5 })],
    ['no node', { sourceId: 'alpha' }],
  ])('refuses %s as INVALID_REQUEST', async (_name, payload) => {
    const { app, lookup } = await started();
    expect((await lookup(payload)).statusCode).toBe(400);
    await app.close();
  });

  it('answers NOT_FOUND for a source that is not configured', async () => {
    const { app, lookup, loads } = await started();
    expect((await lookup({ sourceId: 'nope', value: { entityType: 'thing', value: 'a' } })).statusCode).toBe(404);
    expect(loads()).toEqual([]);
    await app.close();
  });

  it('is the only way into a keyed node by its token when a path cannot carry it: GET takes tokens that fit and refuses a raw value', async () => {
    const { app } = await started();
    const fits = await app.inject({ method: 'GET', url: `/v1/entities/alpha/phone/${encodeURIComponent(token(PHONE))}` });
    expect(fits.statusCode).toBe(200);
    const raw = await app.inject({ method: 'GET', url: `/v1/entities/alpha/phone/${encodeURIComponent(PHONE)}` });
    expect(raw.statusCode).toBe(400);
    const long = await app.inject({ method: 'GET', url: `/v1/entities/alpha/phone/${encodeURIComponent(token('x'.repeat(200)))}` });
    expect(long.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /v1/investigations with a keyed entity', () => {
  const entity = (value: string) => ({ sourceId: 'alpha', entityType: 'phone', value });
  const reference = (stableId: string) => ({ sourceId: 'alpha', entityType: 'phone', stableId });

  it('opens by a raw value and stores only the token: the starting entity, the draft and the title', async () => {
    const { app, store, open } = await started();
    const response = await open({ sourceId: 'alpha', entity: entity(PHONE) });
    expect(response.statusCode).toBe(201);
    const answer = openInvestigationResponseSchema.parse(response.json());
    expect(answer.investigation.startingEntity).toEqual({ entityType: 'phone', stableId: token(PHONE) });
    expect('entity' in answer && answer.entity.ref.stableId).toBe(token(PHONE));
    const [row] = store.investigations;
    expect(row?.startingStableId).toBe(token(PHONE));
    expect(JSON.stringify(store.drafts)).toContain(token(PHONE));
    expect(JSON.stringify([store.investigations, store.drafts])).not.toContain(PHONE);
    expect(answer.investigation.title).not.toContain(PHONE);
    expect(answer.investigation.title).not.toContain('p1.');
    expect(answer.investigation.title.startsWith('Handle')).toBe(true);
    await app.close();
  });

  it('builds the title from the masked display title also when the request is masked', async () => {
    const { app, open } = await started();
    const response = await open({ sourceId: 'alpha', entity: reference(token(PHONE)), mask: true });
    expect(response.statusCode).toBe(201);
    const title = openInvestigationResponseSchema.parse(response.json()).investigation.title;
    expect(title).not.toContain('212-555');
    expect(title).not.toContain('p1.');
    await app.close();
  });

  it('refuses a raw value while masked, and opens by the token while masked', async () => {
    const { app, store, open } = await started();
    expect((await open({ sourceId: 'alpha', entity: entity(PHONE), mask: true })).statusCode).toBe(400);
    expect(store.investigations).toEqual([]);
    expect((await open({ sourceId: 'alpha', entity: reference(token(PHONE)), mask: true })).statusCode).toBe(201);
    await app.close();
  });

  it('reuses one investigation for the raw value and for the token where a case reference is given, and creates as before where it is not', async () => {
    const { app, store, open } = await started();
    const first = await open({ sourceId: 'alpha', caseRef: 'REF-1', entity: entity(PHONE) });
    const second = await open({ sourceId: 'alpha', caseRef: 'REF-1', entity: reference(token(PHONE)) });
    expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
    expect(store.investigations).toHaveLength(1);
    await open({ sourceId: 'alpha', entity: entity(PHONE) });
    await open({ sourceId: 'alpha', entity: reference(token(PHONE)) });
    expect(store.investigations).toHaveLength(3);
    await app.close();
  });

  it('refuses a token of another source or entity type, and a raw value as a reference', async () => {
    const { app, open } = await started();
    for (const stableId of [token(PHONE, 'beta'), token(PHONE, 'alpha', 'thing'), PHONE]) {
      const response = await open({ sourceId: 'alpha', entity: reference(stableId) });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it('opens a node of a type that is not keyed by an ID of any length, and keeps its title as before', async () => {
    const { app, open } = await started();
    const id = 'q'.repeat(3000);
    const response = await open({ sourceId: 'alpha', entity: { sourceId: 'alpha', entityType: 'thing', stableId: id } });
    expect(response.statusCode).toBe(201);
    expect(openInvestigationResponseSchema.parse(response.json()).investigation.startingEntity?.stableId).toBe(id);
    await app.close();
  });

  it('refuses a control character in a path and answers the same ID, or one with an unpaired surrogate, in a body, for a type that is not keyed', async () => {
    const { app, lookup } = await started();
    // a lone surrogate cannot be written as a URL at all, so it is only sent in a body
    for (const id of ['a\u0000b', 'a\u0085b']) {
      const path = await app.inject({ method: 'GET', url: `/v1/entities/alpha/thing/${encodeURIComponent(id)}` });
      expect(path.statusCode, JSON.stringify(id)).toBe(400);
    }
    for (const id of ['a\u0000b', 'a\u0085b', 'a\ud800b']) {
      const body = await lookup(byValue('thing', id));
      expect(body.statusCode, JSON.stringify(id)).toBe(200);
    }
    await app.close();
  });
});
