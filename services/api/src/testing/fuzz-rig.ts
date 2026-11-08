import { createHmac } from 'node:crypto';
import { appendFileSync, rmSync } from 'node:fs';
import { afterAll, expect } from 'vitest';
import { buildApp } from '../app.js';
import { assembleGate } from '../gate/assemble.js';
import { createCursorCodec } from '../gate/cursor/codec.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import type { RequestLimiter } from '../rate/request-limiter.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from './app-store.js';
import { fakeClock, TEST_CURSOR_KEY, TEST_REFERENCE_KEYS, TestExecutor } from './gate.js';
import { baseSource, fileOf } from './mapping.js';
import { plainNode, plainRelationship } from './normalize-fixtures.js';
import { searchModelOf, withOnlineIndexes, type StoredNode } from './search-fixtures.js';
import { makeWebRoot } from './web-root.js';

/** The source every fuzz request names. */
export const FUZZ_SOURCE = 'demo';

export const FUZZ_ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId', 'nickname', 'ownerName'], reference: ['batchRef'], pii: [{ property: 'ownerName', class: 'name' }] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId', 'region'], filterable: ['tier', 'weight'], sortable: ['weight'] },
  { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', search: ['phoneNumber'], pii: [{ property: 'phoneNumber', class: 'phone' }] },
  { type: 'holder', label: 'Holder', stable_id: 'holderCode', search: ['holderCode'], pii: [{ property: 'holderCode', class: 'text' }] },
];
export const FUZZ_RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'], observed_at: 'seenAt', filterable: ['grade'], sortable: ['grade'] },
  { type: 'USES', from: 'widget', to: 'phone', observed_at: 'seenAt' },
];

/** A second source with the same shape, so a cursor of one can be replayed against the other. */
export const FUZZ_TWIN_SOURCE = 'twin';

export const FUZZ_MAPPING = parseMapping(
  fileOf(baseSource({ id: FUZZ_SOURCE, entities: FUZZ_ENTITIES, relationships: FUZZ_RELATIONSHIPS }), baseSource({ id: FUZZ_TWIN_SOURCE, entities: FUZZ_ENTITIES, relationships: FUZZ_RELATIONSHIPS })),
  'neburyx.yaml',
);

/** Names the mapping allows: entity types, relationship types, labels and properties. A statement may quote only these. */
export function allowedNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entity of FUZZ_ENTITIES) {
    names.add(entity.label);
    for (const property of [entity.stable_id, ...entity.search, ...(entity.reference ?? []), ...(entity.filterable ?? []), ...(entity.sortable ?? [])]) names.add(property);
  }
  for (const row of FUZZ_RELATIONSHIPS) {
    names.add(row.type);
    names.add(row.observed_at);
    names.add(row.stable_id ?? '');
    for (const property of [...(row.evidence ?? []), ...(row.filterable ?? []), ...(row.sortable ?? [])]) names.add(property);
  }
  names.delete('');
  return names;
}

const MATCHES = 61;
export const FUZZ_TEXT = 'needle';
const widgets: StoredNode[] = Array.from({ length: MATCHES }, (_, index) => ({
  elementId: `4:w:${index}`,
  label: 'Widget',
  properties: { widgetId: `W-${index}`, nickname: FUZZ_TEXT, batchRef: FUZZ_TEXT, ownerName: `Owner ${index}` },
}));
const gadget: StoredNode = { elementId: '4:g:0', label: 'Gadget', properties: { gadgetId: 'GD-0', region: 'north' } };
const searchModel = searchModelOf([...widgets, gadget]);

const widget = plainNode(['Widget'], { widgetId: 'W-1' }, 'e-widget');
const neighbor = (id: string) => plainNode(['Gadget'], { gadgetId: id }, `e-${id}`);
const when = { $type: 'dateTime', value: '2026-03-01T10:00:00Z' };
const expandRow = (index: number) => ({ a: widget, m: neighbor(`g${index}`), rel: plainRelationship('MADE_FROM', widget, neighbor(`g${index}`), { linkId: `r${index}` }, `rel-${index}`), phase: 2, ts: when, id: `r${index}`, rtype: 'MADE_FROM', dir: 'out', ntype: null, flag: null, members: null, first: null });

const phoneRow = (index: number) => {
  const handle = plainNode(['Handle'], { phoneNumber: `+1-212-555-01${String(99 - index).padStart(2, '0')}` }, `e-phone-${index}`);
  return { a: widget, m: handle, rel: null, phase: 1, ts: when, id: `+1-212-555-01${String(99 - index).padStart(2, '0')}`, rtype: 'USES', dir: 'out', ntype: 'phone', flag: null, members: 2, first: when };
};

/** What the source answers: the search model for the search templates, one full page of neighbors for an expansion, one widget for a load, nothing for the rest. */
function respond(call: ExecuteCall): Promise<ExecuteOutcome> {
  if (call.templateId.startsWith('entity-search') || call.templateId === 'search-facets' || call.templateId === 'relationship-evidence' || call.templateId === 'entity-related') return searchModel(call);
  if (call.templateId === 'entity-load') return Promise.resolve({ status: 'rows', rows: call.cypher.includes('`Widget`') ? [{ n: widget, id: 'W-1' }] : call.cypher.includes('`Handle`') ? [{ n: plainNode(['Handle'], { phoneNumber: call.parameters['stableId'] }, 'e-phone-x'), id: 'p' }] : [] });
  if (call.templateId.startsWith('expand')) return Promise.resolve({ status: 'rows', rows: Array.from({ length: call.rowLimit }, (_, index) => (call.parameters['neighborType'] === 'phone' ? phoneRow(index) : expandRow(index))) });
  return Promise.resolve({ status: 'rows', rows: [] });
}

const neverRefuses: RequestLimiter = { admit: () => undefined, inspect: () => new Map(), close: () => undefined };

export interface FuzzRigOptions {
  readonly respond?: (call: ExecuteCall) => Promise<ExecuteOutcome>;
}

/**
 * The real app and gate over a recording executor, with one key set for the app and the gate (as `start.ts` does), a cursor key and clock the test holds, a policy version it can change, and a request
 * limiter that never refuses (rate behaviour belongs to other suites).
 */
export async function startFuzzRig(options: FuzzRigOptions = {}) {
  const [source] = FUZZ_MAPPING.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const clock = fakeClock();
  const policy = { version: 'p1' };
  const executor = new TestExecutor(withOnlineIndexes(source, options.respond ?? respond));
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit };
  const cursors = createCursorCodec({ key: TEST_CURSOR_KEY, clock: clock.now });
  const parts = assembleGate({ mapping: FUZZ_MAPPING, seams, executor, logger: { warn: () => undefined }, clock: clock.now, cursors, referenceKeys: TEST_REFERENCE_KEYS, policyVersion: () => policy.version });
  const webRoot = makeWebRoot();
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: FUZZ_MAPPING, seams: { ...defaults, ...seams }, gate: parts.gate, indexes: parts.indexes, referenceKeys: TEST_REFERENCE_KEYS, limiter: neverRefuses });
  const tally = { answers: new Map<string, number>(), statements: 0, distinct: new Set<string>() };
  const fold = (): void => {
    for (const call of executor.calls) {
      tally.statements += 1;
      tally.distinct.add(call.cypher);
    }
  };
  afterAll(async () => {
    await app.close();
    rmSync(webRoot, { recursive: true, force: true });
    const file = process.env['NBX_FUZZ_RECORD'];
    if (file === undefined || file === '') return;
    fold();
    const answers = Object.fromEntries([...tally.answers].sort(([first], [second]) => first.localeCompare(second)));
    appendFileSync(file, `${JSON.stringify({ file: expect.getState().testPath?.split('/').pop(), requests: [...tally.answers.values()].reduce((sum, count) => sum + count, 0), answers, statementsSeen: tally.statements, distinctStatements: tally.distinct.size })}\n`);
  });
  const last = { url: '' };
  const post = async (url: string, payload: unknown) => {
    last.url = url;
    const response = await app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
    let code = String(response.statusCode);
    try {
      code = (JSON.parse(response.body) as { error?: { code?: string } }).error?.code ?? 'served';
    } catch {
      code = String(response.statusCode);
    }
    const key = `${url} ${code}`;
    tally.answers.set(key, (tally.answers.get(key) ?? 0) + 1);
    return response;
  };
  return {
    app,
    executor,
    clock,
    policy,
    cursors,
    gate: parts.gate,
    post,
    last,
    reset: () => {
      fold();
      executor.calls.length = 0;
    },
  };
}

/** A cursor signed with the cursor key over any payload text: how a test makes a cursor that is signed right and is wrong in some other way. */
export function signCursor(payload: unknown, key: Uint8Array = TEST_CURSOR_KEY): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signed = `v1.${Buffer.from(text, 'utf8').toString('base64url')}`;
  return `${signed}.${createHmac('sha256', key).update(signed).digest().toString('base64url')}`;
}

/** The payload a cursor carries (the signature is not checked). */
export const payloadOfCursor = (cursor: string): Record<string, unknown> => JSON.parse(Buffer.from(cursor.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

export type FuzzRig = Awaited<ReturnType<typeof startFuzzRig>>;
