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
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId', 'nickname', 'ownerName'], reference: ['batchRef'], pii: [{ property: 'ownerName', class: 'name' }], link: 'https://records.fuzz.test/w/{widgetId}' },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId', 'region'], filterable: ['tier', 'weight'], sortable: ['weight'] },
  { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', search: ['phoneNumber'], pii: [{ property: 'phoneNumber', class: 'phone' }] },
  { type: 'holder', label: 'Holder', stable_id: 'holderCode', search: ['holderCode'], pii: [{ property: 'holderCode', class: 'text' }] },
];
export const FUZZ_RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'], evidence_link: 'https://records.fuzz.test/r/{recordId}', observed_at: 'seenAt', filterable: ['grade'], sortable: ['grade'] },
  { type: 'USES', from: 'widget', to: 'phone', observed_at: 'seenAt' },
];

export const FUZZ_DERIVED = [{ id: 'shared-gadget', from: 'widget', to: 'widget', via: ['MADE_FROM', 'gadget', 'MADE_FROM'], rule_version: 1, stop_list_property: 'weight' }, { id: 'shared-handle', from: 'phone', to: 'phone', via: ['USES', 'widget', 'USES'], rule_version: 1 }];

/** Two presets of the shared-attribute template: one over a relationship type with a stop-list rule, one over a type with no rule. */
export const FUZZ_SHARED_PRESETS = [
  { id: 'shared-gadgets', name: 'Shared gadgets', template: 'shared-attribute', bind: { anchor: 'widget', attribute: 'gadget', via: 'MADE_FROM' } },
  { id: 'shared-phones', name: 'Shared phones', template: 'shared-attribute', bind: { anchor: 'widget', attribute: 'phone', via: 'USES' } },
];

/** Two presets of the linked-entities template: one that reaches a different type in one hop, one whose target is its own anchor type, so that two hops cross a gadget. */
export const FUZZ_LINKED_PRESETS = [
  { id: 'linked-gadgets', name: 'Linked gadgets', template: 'linked-entities', bind: { anchor: 'widget', target: 'gadget', via: 'MADE_FROM' } },
  { id: 'linked-widgets', name: 'Linked widgets', template: 'linked-entities', bind: { anchor: 'widget', target: 'widget', via: 'MADE_FROM' } },
];

export const FUZZ_PRESETS = [...FUZZ_SHARED_PRESETS, ...FUZZ_LINKED_PRESETS];

/** A second source with the same shape, so a cursor of one can be replayed against the other. */
export const FUZZ_TWIN_SOURCE = 'twin';

/**
 * A third source for the pattern runs: a hop budget of one, and a relationship with no mapped time property, so that a run for two hops is over its cap and a run with a window over that
 * relationship is refused.
 */
export const FUZZ_TIGHT_SOURCE = 'tight';
export const FUZZ_TIGHT_RELATIONSHIPS = [{ type: 'HOLDS', from: 'holder', to: 'widget' }];
export const FUZZ_TIGHT_PRESETS = [{ id: 'linked-holders', name: 'Linked holders', template: 'linked-entities', bind: { anchor: 'widget', target: 'holder', via: 'HOLDS' } }, ...FUZZ_LINKED_PRESETS];

export const FUZZ_MAPPING = parseMapping(
  fileOf(
    baseSource({ id: FUZZ_SOURCE, entities: FUZZ_ENTITIES, relationships: FUZZ_RELATIONSHIPS, derived: FUZZ_DERIVED, patterns: FUZZ_PRESETS }),
    baseSource({ id: FUZZ_TWIN_SOURCE, entities: FUZZ_ENTITIES, relationships: FUZZ_RELATIONSHIPS, derived: FUZZ_DERIVED, patterns: FUZZ_PRESETS }),
    baseSource({ id: FUZZ_TIGHT_SOURCE, entities: FUZZ_ENTITIES, relationships: [...FUZZ_RELATIONSHIPS, ...FUZZ_TIGHT_RELATIONSHIPS], derived: FUZZ_DERIVED, patterns: FUZZ_TIGHT_PRESETS, budgets: { max_hops: 1 } }),
  ),
  'neburyx.yaml',
);

/** Names the mapping allows: entity types, relationship types, labels and properties. A statement may quote only these. */
export function allowedNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entity of FUZZ_ENTITIES) {
    names.add(entity.label);
    for (const property of [entity.stable_id, ...entity.search, ...(entity.reference ?? []), ...(entity.filterable ?? []), ...(entity.sortable ?? [])]) names.add(property);
  }
  for (const row of FUZZ_TIGHT_RELATIONSHIPS) names.add(row.type);
  for (const row of FUZZ_RELATIONSHIPS) {
    names.add(row.type);
    names.add(row.observed_at);
    names.add(row.stable_id ?? '');
    for (const property of [...(row.evidence ?? []), ...(row.filterable ?? []), ...(row.sortable ?? [])]) names.add(property);
  }
  names.delete('');
  return names;
}

/** The anchor whose count probe answers more matches than the source's threshold (500 by default), so a run for it stops as heavy. */
export const FUZZ_HEAVY_ANCHOR = 'W-HEAVY';
export const FUZZ_HEAVY_MATCHES = 501;

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

const sharedRow = (index: number, call: ExecuteCall) => {
  const phones = call.cypher.includes('`Handle`');
  const attribute = phones ? plainNode(['Handle'], { phoneNumber: `+1-212-555-01${index}` }, `e-sp-${index}`) : neighbor(`gs${index}`);
  const match = plainNode(['Widget'], { widgetId: `W-S${index}` }, `e-ws-${index}`);
  const type = phones ? 'USES' : 'MADE_FROM';
  return { a: widget, skipped: false, bounded: false, b: match, xs: [attribute], ras: [plainRelationship(type, widget, attribute, phones ? {} : { linkId: `rsa${index}` }, `rel-sa${index}`)], rbs: [plainRelationship(type, match, attribute, phones ? {} : { linkId: `rsb${index}` }, `rel-sb${index}`)], shared: 1, evidenceCut: false };
};

/** One match of a linked-entities read: a gadget or a handle in one hop, or, at two hops over `MADE_FROM`, another widget through a gadget. */
const linkedRow = (index: number, call: ExecuteCall) => {
  if (call.parameters['entityType'] === 'gadget') {
    const anchor = neighbor('GD-0');
    const other = plainNode(['Widget'], { widgetId: `W-G${index}` }, `e-wg-${index}`);
    return { a: anchor, bounded: false, heavy: [], stopListed: false, x: other, mid: null, r1: plainRelationship('MADE_FROM', other, anchor, { linkId: `rg${index}` }, `rel-g${index}`), r2: null, hops: 1 };
  }
  const [type] = Array.isArray(call.parameters['via']) ? (call.parameters['via'] as string[]) : ['MADE_FROM'];
  const twoHops = Number(call.parameters['maxHops'] ?? 1) > 1 && type === 'MADE_FROM';
  const target = call.parameters['targetType'];
  if (twoHops) {
    const through = neighbor(`gl${index}`);
    const other = plainNode(['Widget'], { widgetId: `W-L${index}` }, `e-wl-${index}`);
    return { a: widget, bounded: false, heavy: [], stopListed: false, x: other, mid: through, r1: plainRelationship('MADE_FROM', widget, through, { linkId: `rl${index}a` }, `rel-l${index}a`), r2: plainRelationship('MADE_FROM', other, through, { linkId: `rl${index}b` }, `rel-l${index}b`), hops: 2 };
  }
  const phones = type === 'USES' || target === 'phone';
  const match = phones ? plainNode(['Handle'], { phoneNumber: `+1-212-555-02${index}` }, `e-pl-${index}`) : neighbor(`gl1-${index}`);
  return { a: widget, bounded: false, heavy: [], stopListed: false, x: match, mid: null, r1: plainRelationship(phones ? 'USES' : 'MADE_FROM', widget, match, phones ? {} : { linkId: `rl1-${index}` }, `rel-l1-${index}`), r2: null, hops: 1 };
};

const derivedRow = (index: number) => {
  const other = plainNode(['Widget'], { widgetId: `W-D${index}` }, `e-wd-${index}`);
  const via = neighbor(`gd${index}`);
  return {
    p: {
      $type: 'path',
      start: widget,
      segments: [
        { relationship: plainRelationship('MADE_FROM', widget, via, { linkId: `rd${index}a` }, `rel-d${index}a`), end: via },
        { relationship: plainRelationship('MADE_FROM', other, via, { linkId: `rd${index}b` }, `rel-d${index}b`), end: other },
      ],
    },
  };
};

const supportRow = (index: number) => {
  const other = plainNode(['Widget'], { widgetId: 'W-2' }, 'e-w2');
  const via = neighbor(`gs${index}`);
  return {
    p: {
      $type: 'path',
      start: widget,
      segments: [
        { relationship: plainRelationship('MADE_FROM', widget, via, { linkId: `rs${index}a` }, `rel-s${index}a`), end: via },
        { relationship: plainRelationship('MADE_FROM', other, via, { linkId: `rs${index}b` }, `rel-s${index}b`), end: other },
      ],
    },
  };
};

const phoneRow = (index: number) => {
  const handle = plainNode(['Handle'], { phoneNumber: `+1-212-555-01${String(99 - index).padStart(2, '0')}` }, `e-phone-${index}`);
  return { a: widget, m: handle, rel: null, phase: 1, ts: when, id: `+1-212-555-01${String(99 - index).padStart(2, '0')}`, rtype: 'USES', dir: 'out', ntype: 'phone', flag: null, members: 2, first: when };
};

/** What the source answers: the search model for the search templates, one full page of neighbors for an expansion, one widget for a load, nothing for the rest. */
export function respond(call: ExecuteCall): Promise<ExecuteOutcome> {
  if (call.templateId.startsWith('entity-search') || call.templateId === 'search-facets' || call.templateId === 'relationship-evidence' || call.templateId === 'entity-related') return searchModel(call);
  if (call.templateId === 'entity-load') return Promise.resolve({ status: 'rows', rows: call.cypher.includes('`Widget`') ? [{ n: widget, id: 'W-1' }] : call.cypher.includes('`Handle`') ? [{ n: plainNode(['Handle'], { phoneNumber: call.parameters['stableId'] }, 'e-phone-x'), id: 'p' }] : [] });
  if (call.templateId === 'entity-load-many') {
    const refs = call.parameters['refs'] as readonly { readonly stableId: string }[];
    if (call.cypher.includes('`Widget`')) return Promise.resolve({ status: 'rows', rows: refs.map((_ref, i) => ({ i, dup: false, n: widget, id: 'W-1' })) });
    if (call.cypher.includes('`Handle`')) return Promise.resolve({ status: 'rows', rows: refs.map((ref, i) => ({ i, dup: false, n: plainNode(['Handle'], { phoneNumber: ref.stableId }, `e-phone-x${i}`), id: 'p' })) });
    return Promise.resolve({ status: 'rows', rows: [] });
  }
  if (call.templateId === 'derived-edge-support') return Promise.resolve({ status: 'rows', rows: Array.from({ length: Math.min(call.rowLimit, 3) }, (_, index) => supportRow(index)) });
  if (call.templateId === 'shared-attribute-count') return Promise.resolve({ status: 'rows', rows: [{ matches: call.parameters['stableId'] === FUZZ_HEAVY_ANCHOR ? FUZZ_HEAVY_MATCHES : 0, anchorBounded: false, skipped: false }] });
  if (call.templateId === 'shared-attribute') return Promise.resolve({ status: 'rows', rows: Array.from({ length: Math.min(call.rowLimit, 3) }, (_, index) => sharedRow(index, call)) });
  if (call.templateId === 'linked-entities-count') return Promise.resolve({ status: 'rows', rows: [{ matches: call.parameters['stableId'] === FUZZ_HEAVY_ANCHOR ? FUZZ_HEAVY_MATCHES : 0, frontierBounded: false, supernodeSkipped: false }] });
  if (call.templateId === 'linked-entities') return Promise.resolve({ status: 'rows', rows: Array.from({ length: Math.min(call.rowLimit, 3) }, (_, index) => linkedRow(index, call)) });
  if (call.templateId === 'derived-rule-run') return Promise.resolve({ status: 'rows', rows: Array.from({ length: Math.min(call.rowLimit, 3) }, (_, index) => derivedRow(index)) });
  if (call.templateId === 'aggregate-sample') {
    const ends = call.parameters['ends'];
    const value = Array.isArray(ends) && typeof ends[1] === 'object' && ends[1] !== null && 'stableId' in ends[1] ? String(ends[1].stableId) : '+1-212-555-0100';
    return Promise.resolve({ status: 'rows', rows: [{ a: widget, b: plainNode(['Handle'], { phoneNumber: value }, 'e-phone-agg'), sample: Array.from({ length: Math.min(call.rowLimit, 3) }, () => ({ t: when })) }] });
  }
  if (call.templateId === 'aggregate-summary') return Promise.resolve({ status: 'rows', rows: [{ members: 3, first: when, last: when }] });
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
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: FUZZ_MAPPING, seams: { ...defaults, ...seams }, gate: parts.gate, indexes: parts.indexes, referenceKeys: TEST_REFERENCE_KEYS, limiter: neverRefuses, templateRunClock: () => new Date(clock.now()) });
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
  let keys = 0;
  const post = async (url: string, payload: unknown) => {
    last.url = url;
    const headers = url.startsWith('/v1/templates/') ? { 'content-type': 'application/json', 'idempotency-key': `fuzz-key-of-sixteen-${(keys += 1)}` } : { 'content-type': 'application/json' };
    const response = await app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers });
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
