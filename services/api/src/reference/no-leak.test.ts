import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { initialDraftDocuments } from '../investigations/draft.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY } from '../testing/app-store.js';
import { makeToken } from './token.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

/** A value no other text in a response can contain by chance, and the pieces of it a mask could leave. */
const VALUE = '+1-212-555-0100-zq7';
const FRAGMENTS = [VALUE, '212-555-0100', '555-0100-zq7', 'zq7'];
const MASTER = Buffer.alloc(32, 9);

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      synthetic: true,
      demo_case: { entity: { type: 'phone', id: VALUE }, case_ref: 'CASE-1' },
      entities: [
        { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', search: ['phoneNumber'], pii: [{ property: 'phoneNumber', class: 'phone' }], link: 'https://records.example.test/{phoneNumber}', link_carries_value: true },
        { type: 'person', label: 'Person', stable_id: 'personId', search: ['personId'] },
      ],
      relationships: [{ type: 'HAS_PHONE', from: 'person', to: 'phone' }],
    }),
  ),
  'neburyx.yaml',
);
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const place = (entityType = 'phone', sourceId = 'demo') => ({ sourceId, entityType });
const TOKEN = makeToken(TEST_REFERENCE_KEYS, place(), VALUE);

async function started() {
  const events: AuditEvent[] = [];
  const lines: string[] = [];
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId.startsWith('degree-preview')) return Promise.resolve({ status: 'rows', rows: [{ c0: 3 }] });
    return Promise.resolve(entityRows(plainNode(['Handle'], { phoneNumber: VALUE })));
  };
  const executor = new TestExecutor(withOnlineIndexes(source ?? (() => { throw new Error('no source'); })(), answer));
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event: AuditEvent) => Promise.resolve(void events.push(event)) } };
  const parts = testSourceGate(mapping, { executor, seams, referenceKeys: TEST_REFERENCE_KEYS });
  const store = memoryAppStore();
  await store.syncSources(mapping.sources);
  const app = await buildApp({ webRoot, logger: createLogger({ write: (line: string) => void lines.push(line) }), store, mapping, gate: parts.gate, indexes: parts.indexes, seams: { ...defaults, ...seams }, referenceKeys: TEST_REFERENCE_KEYS });
  const requests: string[] = [];
  const send = (method: 'GET' | 'POST', url: string, payload?: object) => (requests.push(url), app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }));
  return { app, send, requests, events, lines, store };
}

/** The response without the places a value is allowed to be in when the request is not masked: the properties of a node and its display title. */
function withoutPermitted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPermitted);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value).filter(([key]) => key !== 'properties').map(([key, inner]) => [key, key === 'display' && typeof inner === 'object' && inner !== null ? { ...inner, title: undefined } : withoutPermitted(inner)]);
  return Object.fromEntries(entries);
}

const holdsValue = (text: string): boolean => FRAGMENTS.some((fragment) => text.includes(fragment));
const forbidden = (response: { body: string }, masked: boolean): string => (masked ? response.body : JSON.stringify(withoutPermitted(JSON.parse(response.body))));

describe('a keyed node goes through every flow and its value stays where it may be', () => {
  it('leaves the value only in unmasked properties and an unmasked display title, in every response of every flow', async () => {
    const { send } = await started();
    const flows: [string, boolean, () => ReturnType<typeof send>][] = [
      ['search unmasked', false, () => send('POST', '/v1/search/entities', { sourceId: 'demo', text: VALUE })],
      ['search masked by the value', true, () => send('POST', '/v1/search/entities', { sourceId: 'demo', text: VALUE, mask: true })],
      ['entity read', false, () => send('GET', `/v1/entities/demo/phone/${encodeURIComponent(TOKEN)}`)],
      ['entity read masked', true, () => send('GET', `/v1/entities/demo/phone/${encodeURIComponent(TOKEN)}?mask=true`)],
      ['lookup by value', false, () => send('POST', '/v1/entities/lookup', { sourceId: 'demo', value: { entityType: 'phone', value: VALUE } })],
      ['lookup by reference masked', true, () => send('POST', '/v1/entities/lookup', { sourceId: 'demo', ref: { entityType: 'phone', stableId: TOKEN }, mask: true })],
      ['open by value', false, () => send('POST', '/v1/investigations', { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'phone', value: VALUE } })],
      ['open by reference masked', true, () => send('POST', '/v1/investigations', { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'phone', stableId: TOKEN }, mask: true })],
      ['degree preview', false, () => send('POST', '/v1/graph/preview-expansion', { sourceId: 'demo', ref: { entityType: 'phone', stableId: TOKEN } })],
      ['degree preview masked', true, () => send('POST', '/v1/graph/preview-expansion', { sourceId: 'demo', ref: { entityType: 'phone', stableId: TOKEN }, mask: true })],
      ['source list with the demo case', true, () => send('GET', '/v1/sources')],
      ['source profile', true, () => send('GET', '/v1/sources/demo/profile')],
    ];
    for (const [name, masked, run] of flows) {
      const response = await run();
      expect(response.statusCode, name).toBeLessThan(300);
      expect(holdsValue(forbidden(response, masked)), name).toBe(false);
      expect(leaksIn(response.body).includes('key'), `${name}: the key or a derived key`).toBe(false);
    }
    const list = await send('GET', '/v1/investigations');
    expect(holdsValue(list.body), 'stored list').toBe(false);
    expect(leaksIn(list.body).includes('key'), 'stored list: the key').toBe(false);
    const [item] = list.json().items;
    const read = await send('GET', `/v1/investigations/${item.id}`);
    expect(holdsValue(read.body), 'stored read').toBe(false);
    expect(leaksIn(read.body).includes('key'), 'stored read: the key').toBe(false);
  });

  it('puts the value in no URL, log line or audit row, and the key, derived keys and tokens in no log line or audit row', async () => {
    const { send, requests, events, lines } = await started();
    await send('POST', '/v1/entities/lookup', { sourceId: 'demo', value: { entityType: 'phone', value: VALUE } });
    await send('GET', `/v1/entities/demo/phone/${encodeURIComponent(TOKEN)}`);
    await send('POST', '/v1/investigations', { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'phone', value: VALUE } });
    await send('POST', '/v1/graph/preview-expansion', { sourceId: 'demo', ref: { entityType: 'phone', stableId: TOKEN } });
    await send('POST', '/v1/search/entities', { sourceId: 'demo', text: VALUE });
    await send('GET', `/v1/entities/demo/phone/${encodeURIComponent(VALUE)}`);
    await send('GET', `/v1/entities/demo/phone/${encodeURIComponent(`${TOKEN}x`)}`);
    expect(events.length).toBeGreaterThan(0);
    const secrets = [MASTER, ...Object.values(TEST_REFERENCE_KEYS)].flatMap((key) => [key.toString('hex'), key.toString('base64'), key.toString('base64url')]);
    const logged = JSON.stringify([lines, events]);
    expect(requests.some(holdsValue) && requests.filter((url) => holdsValue(decodeURIComponent(url))).length).toBe(1);
    for (const text of [logged]) {
      expect(holdsValue(text)).toBe(false);
      expect(text).not.toContain(TOKEN);
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
    expect(logged).not.toContain(TOKEN.slice(3, 30));
  });

  it('refuses a token of another source, another type, a changed byte or a truncation with one and the same body on every route that takes a reference', async () => {
    const { send } = await started();
    const flipped = `${TOKEN.slice(0, 20)}${TOKEN[20] === 'A' ? 'B' : 'A'}${TOKEN.slice(21)}`;
    const bad = [makeToken(TEST_REFERENCE_KEYS, place('phone', 'other'), VALUE), makeToken(TEST_REFERENCE_KEYS, place('person'), VALUE), flipped, TOKEN.slice(0, -2)];
    const routes = (token: string) => [
      () => send('GET', `/v1/entities/demo/phone/${encodeURIComponent(token)}`),
      () => send('POST', '/v1/entities/lookup', { sourceId: 'demo', ref: { entityType: 'phone', stableId: token } }),
      () => send('POST', '/v1/investigations', { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'phone', stableId: token } }),
      () => send('POST', '/v1/graph/preview-expansion', { sourceId: 'demo', ref: { entityType: 'phone', stableId: token } }),
    ];
    const bodies = new Set<string>();
    for (const token of bad) {
      for (const run of routes(token)) {
        const response = await run();
        expect(response.statusCode).toBe(400);
        bodies.add(JSON.stringify({ ...response.json(), error: { ...response.json().error, traceId: '' } }));
      }
    }
    expect(bodies.size).toBe(1);
    const [only] = [...bodies];
    expect(holdsValue(only ?? '')).toBe(false);
  });

  it('refuses a raw value of a keyed type in a masked lookup or open with that same body, and reads nothing', async () => {
    const { send } = await started();
    const bodyOf = async (response: Awaited<ReturnType<typeof send>>) => JSON.stringify({ ...response.json(), error: { ...response.json().error, traceId: '' } });
    const lookup = await send('POST', '/v1/entities/lookup', { sourceId: 'demo', value: { entityType: 'phone', value: VALUE }, mask: true });
    const open = await send('POST', '/v1/investigations', { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'phone', value: VALUE }, mask: true });
    const refusedToken = await send('GET', `/v1/entities/demo/phone/${encodeURIComponent(`${TOKEN}x`)}`);
    expect([lookup.statusCode, open.statusCode]).toEqual([400, 400]);
    expect(await bodyOf(lookup)).toBe(await bodyOf(open));
    expect(await bodyOf(lookup)).toBe(await bodyOf(refusedToken));
  });
});

describe('the scan itself', () => {
  const node = (ref: string, title: string) => JSON.stringify({ entity: { ref: { stableId: ref }, display: { title, type: 'phone' }, properties: [{ key: 'phoneNumber', value: VALUE }] } });

  it('ignores the permitted places of an unmasked response and flags the value anywhere else, and everywhere in a masked one', () => {
    expect(holdsValue(forbidden({ body: node(TOKEN, VALUE) }, false))).toBe(false);
    expect(holdsValue(forbidden({ body: node(VALUE, 'x') }, false))).toBe(true);
    expect(holdsValue(forbidden({ body: JSON.stringify({ error: { message: `no ${VALUE}` } }) }, false))).toBe(true);
    expect(holdsValue(forbidden({ body: node(TOKEN, 'x') }, true))).toBe(true);
    expect(holdsValue(forbidden({ body: node(TOKEN, '+1 ••••••00').replace(VALUE, '••••') }, true))).toBe(false);
  });
});

/** Every kind of leak a scan looks for, in a text that must hold none of them: the value, its pieces, the key and the keys derived from it, and (when asked) a token. */
function leaksIn(text: string, options: { readonly tokens?: readonly string[] } = {}): string[] {
  const found: string[] = [];
  if (holdsValue(text)) found.push('value');
  for (const key of [MASTER, ...Object.values(TEST_REFERENCE_KEYS)]) {
    if ([key.toString('hex'), key.toString('base64'), key.toString('base64url')].some((form) => text.includes(form))) found.push('key');
  }
  if ((options.tokens ?? []).some((token) => text.includes(token))) found.push('token');
  return found;
}

describe('every artifact of the flows is scanned, and each scan can fail', () => {
  it('finds no value, key or token in a log line, an audit row or an error body, and no key in any response', async () => {
    const { send, events, lines, store } = await started();
    expect((await store.listSources()).length).toBeGreaterThan(0);
    const sources = await send('GET', '/v1/sources');
    const [source] = sources.json().items;
    expect(source.demoCase.stableId).toMatch(/^p1\./);
    expect(holdsValue(sources.body)).toBe(false);
    const bodies = [sources.body];
    const errors: string[] = [];
    for (const [method, url, payload] of [
      ['GET', `/v1/entities/demo/phone/${encodeURIComponent(VALUE)}`, undefined],
      ['GET', `/v1/entities/demo/phone/${encodeURIComponent(`${TOKEN}x`)}`, undefined],
      ['POST', '/v1/entities/lookup', { sourceId: 'demo', value: { entityType: 'phone', value: VALUE }, mask: true }],
      ['POST', '/v1/investigations', { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'phone', stableId: VALUE }, mask: true }],
      ['POST', '/v1/graph/preview-expansion', { sourceId: 'demo', ref: { entityType: 'phone', stableId: `${TOKEN}x` } }],
    ] as const) {
      const response = await send(method, url, payload);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      errors.push(response.body);
    }
    for (const [url, payload] of [['/v1/entities/lookup', { sourceId: 'demo', value: { entityType: 'phone', value: VALUE } }], ['/v1/investigations', { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'phone', value: VALUE } }]] as const) bodies.push((await send('POST', url, payload)).body);
    for (const text of errors) expect(leaksIn(text, { tokens: [TOKEN] }), text).toEqual([]);
    for (const text of bodies) expect(leaksIn(text).filter((kind) => kind === 'key'), text).toEqual([]);
    expect(leaksIn(JSON.stringify([lines, events]), { tokens: [TOKEN] })).toEqual([]);
  });

  it('shows a stored investigation of a type that became keyed with no value, in the list and the read', async () => {
    const { send, store } = await started();
    const [stored] = store.investigations;
    expect(stored).toBeUndefined();
    store.investigations.push({ id: '0192f000-0000-7000-8000-0000000000e1', sourceId: 'demo', sourceIdentityHash: identityHashOf(source), ownerId: LOCAL_IDENTITY.principal.id, title: `Handle ${VALUE}`, caseRef: null, startingEntityType: 'phone', startingStableId: VALUE, status: 'open', createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', closedAt: null, archivedAt: null, version: 1 });
    const initial = initialDraftDocuments({ entityType: 'phone', stableId: VALUE });
    store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000e2', version: 1, notes: null, investigationId: '0192f000-0000-7000-8000-0000000000e1', layout: initial.layout, queryContext: initial.queryContext, mappingHash: source.configHash });
    for (const response of [await send('GET', '/v1/investigations'), await send('GET', '/v1/investigations/0192f000-0000-7000-8000-0000000000e1')]) {
      expect(response.statusCode).toBe(200);
      expect(leaksIn(response.body)).toEqual([]);
    }
  });

  it('flags each kind of leak when one is injected into each artifact', () => {
    const [phoneLine, keyLine] = [`opened ${VALUE}`, `key ${TEST_REFERENCE_KEYS.tokenMac.toString('hex')}`];
    expect(leaksIn(JSON.stringify([{ msg: phoneLine }]))).toEqual(['value']);
    expect(leaksIn(JSON.stringify([{ target: TOKEN }]), { tokens: [TOKEN] })).toEqual(['token']);
    expect(leaksIn(JSON.stringify({ error: { message: keyLine } }))).toEqual(['key']);
    expect(leaksIn(`${MASTER.toString('base64')}`)).toEqual(['key']);
    expect(leaksIn('nothing here')).toEqual([]);
  });
});
