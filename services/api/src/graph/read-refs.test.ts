import { rmSync } from 'node:fs';
import { readRefsResponseSchema, MAX_READ_REFS } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID } from '../gate/templates/aggregate-evidence.js';
import { DERIVED_EDGE_SUPPORT_ID } from '../gate/templates/derived-edge-support.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { makeToken } from '../reference/token.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { redactItems } from '../gate/redact/index.js';
import { account, chain, DERIVED_AGGREGATE, DERIVED_ENTITIES, DERIVED_RULE, DERIVED_STORED, device, hidingEdgeRedact, hidingRedact } from '../testing/derived-fixtures.js';
import { TestExecutor, TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', title: '{ownerName}', pii: [{ property: 'ownerName', class: 'name' }] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
  { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
];
const RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId' },
  { type: 'BARE', from: 'widget', to: 'gadget' },
];
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: ENTITIES, relationships: RELATIONSHIPS, budgets: { requests_per_minute: 60 } })), 'neburyx.yaml');
const limited = parseMapping(fileOf(baseSource({ id: 'demo', entities: ENTITIES, relationships: RELATIONSHIPS, budgets: { requests_per_minute: 2 } })), 'neburyx.yaml');

const widget = (id: string, name = 'Ana Silva') => plainNode(['Widget'], { widgetId: id, ownerName: name }, `4:s:${id}`);
const gadget = plainNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:g');
const el = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
const link = (id: string) => ({ r: plainRelationship('MADE_FROM', widget('W-1'), gadget, { linkId: id }, `5:s:${id}`), a: widget('W-1'), b: gadget });

interface Options {
  readonly answer?: (call: ExecuteCall) => ExecuteOutcome | Promise<ExecuteOutcome>;
  readonly deny?: boolean;
  readonly mapping?: typeof mapping;
  readonly hideNode?: string;
  readonly hideEdge?: string;
}

async function started(options: Options = {}) {
  const chosen = options.mapping ?? mapping;
  const [source] = chosen.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), async (call) => (await options.answer?.(call)) ?? { status: 'rows', rows: [] }));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy,
    coordinator: defaults.coordinator,
    audit: { record: (event) => (events.push(event), Promise.resolve()) },
  };
  const redact = options.hideNode !== undefined ? hidingRedact(options.hideNode, redactItems) : options.hideEdge !== undefined ? hidingEdgeRedact(options.hideEdge, redactItems) : undefined;
  const parts = testSourceGate(chosen, { executor, seams, referenceKeys: TEST_REFERENCE_KEYS, ...(redact === undefined ? {} : { redact }) });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: chosen, gate: parts.gate, seams, referenceKeys: TEST_REFERENCE_KEYS });
  return { app, executor, events };
}

type Started = Awaited<ReturnType<typeof started>>;
const post = (app: Started['app'], payload: unknown) => app.inject({ method: 'POST', url: '/v1/graph/read-refs', payload: payload as object });
const entityCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === 'entity-load-many');
/** The stable IDs a batched read was given, in order; the scripted source answers a row for each one it holds, as the statement does, with the position of the ID in the list. */
const idsOf = (call: ExecuteCall): readonly string[] => (call.parameters['refs'] as readonly { readonly stableId: string }[]).map((entry) => entry.stableId);
const asked = (executor: TestExecutor): number => entityCalls(executor).reduce((sum, call) => sum + idsOf(call).length, 0);
const answerWidgets = (known: readonly string[]) => (call: ExecuteCall): ExecuteOutcome =>
  call.templateId === 'entity-load-many' ? { status: 'rows', rows: idsOf(call).flatMap((id, i) => (known.includes(id) ? [{ i, n: widget(id), dup: false }] : [])) } : { status: 'rows', rows: [] };

describe('POST /v1/graph/read-refs: entities', () => {
  it('returns each entity the source still holds, in the order asked, and lists the others as missing, in one read through the gate', async () => {
    const { app, executor, events } = await started({ answer: answerWidgets(['W-1', 'W-3']) });
    const response = await post(app, { sourceId: 'demo', entities: [el('widget', 'W-3'), el('widget', 'W-2'), el('widget', 'W-1')] });
    expect(response.statusCode).toBe(200);
    const body = readRefsResponseSchema.parse(response.json());
    expect(body.nodes.map((node) => node.ref.stableId)).toEqual(['W-3', 'W-1']);
    expect(body.missing).toEqual({ entities: [el('widget', 'W-2')], edges: [] });
    expect(entityCalls(executor)).toHaveLength(1);
    expect(asked(executor)).toBe(3);
    expect(events.filter((event) => event.action === 'entity.load')).toHaveLength(1);
    await app.close();
  });

  it('reads the references of one entity type in runs of at most the page of the source, the runs of a call under one audit event, and maps each answer back to its reference', async () => {
    const known = ['W-0', 'W-49', 'W-50', 'W-99'];
    const { app, executor, events } = await started({ answer: answerWidgets(known) });
    const ids = Array.from({ length: MAX_READ_REFS }, (_unused, index) => `W-${index}`);
    const body = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', entities: ids.map((id) => el('widget', id)) })).json());
    expect(entityCalls(executor).map((call) => idsOf(call).length)).toEqual([50, 50]);
    expect(entityCalls(executor).flatMap(idsOf)).toEqual(ids);
    expect(body.nodes.map((node) => node.ref.stableId)).toEqual(known);
    expect(body.missing.entities).toHaveLength(MAX_READ_REFS - known.length);
    expect(events.filter((event) => event.action === 'entity.load')).toHaveLength(1);
    await app.close();
  });

  it('reads each entity type in a statement of its own and keeps the order asked', async () => {
    const { app, executor } = await started({ answer: answerWidgets(['W-1', 'W-2']) });
    const body = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', entities: [el('widget', 'W-2'), el('gadget', 'GT-1'), el('widget', 'W-1')] })).json());
    expect(entityCalls(executor).map((call) => [call.cypher.includes('`Widget`'), idsOf(call)])).toEqual([
      [true, ['W-2', 'W-1']],
      [false, ['GT-1']],
    ]);
    expect(body.nodes.map((node) => node.ref.stableId)).toEqual(['W-2', 'W-1']);
    expect(body.missing.entities).toEqual([el('gadget', 'GT-1')]);
    await app.close();
  });

  it('masks the personal-data fields of every node of a run when asked, and lists a missing one the same', async () => {
    const { app } = await started({ answer: answerWidgets(['W-1', 'W-3']) });
    const masked = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', mask: true, entities: [el('widget', 'W-1'), el('widget', 'W-2'), el('widget', 'W-3')] })).json());
    expect(JSON.stringify(masked)).not.toContain('Ana Silva');
    expect(masked.nodes.map((node) => node.ref.stableId)).toEqual(['W-1', 'W-3']);
    expect(masked.missing.entities).toEqual([el('widget', 'W-2')]);
    await app.close();
  });

  it('lists a node the policy takes out of the middle of a run as missing, and keeps the others with the references they answer', async () => {
    const { app } = await started({ hideNode: 'W-2', answer: answerWidgets(['W-1', 'W-2', 'W-3']) });
    const body = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', entities: [el('widget', 'W-1'), el('widget', 'W-2'), el('widget', 'W-3')] })).json());
    expect(body.nodes.map((node) => node.ref.stableId)).toEqual(['W-1', 'W-3']);
    expect(body.missing.entities).toEqual([el('widget', 'W-2')]);
    await app.close();
  });

  it('reads the tokens of a keyed type in a batch and masks their values when asked', async () => {
    const tokens = ['+1-212-555-0100', '+1-212-555-0101'].map((value) => makeToken(TEST_REFERENCE_KEYS, { sourceId: 'demo', entityType: 'phone' }, value));
    const answer = (call: ExecuteCall): ExecuteOutcome =>
      call.templateId === 'entity-load-many' ? { status: 'rows', rows: idsOf(call).map((id, i) => ({ i, dup: false, n: plainNode(['Handle'], { phoneNumber: id }, `4:s:p${i}`) })) } : { status: 'rows', rows: [] };
    const { app, executor } = await started({ answer });
    const plain = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', entities: tokens.map((token) => el('phone', token)) })).json());
    const masked = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', mask: true, entities: tokens.map((token) => el('phone', token)) })).json());
    expect(plain.nodes.map((node) => node.ref.stableId)).toEqual(tokens);
    expect(masked.nodes.map((node) => node.ref.stableId)).toEqual(tokens);
    expect(JSON.stringify(masked)).not.toMatch(/555-010[01]/);
    expect(entityCalls(executor).flatMap(idsOf)).toEqual(['+1-212-555-0100', '+1-212-555-0101', '+1-212-555-0100', '+1-212-555-0101']);
    await app.close();
  });

  it('masks the personal-data fields when asked', async () => {
    const { app } = await started({ answer: answerWidgets(['W-1']) });
    const plain = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', entities: [el('widget', 'W-1')] })).json());
    const masked = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', mask: true, entities: [el('widget', 'W-1')] })).json());
    expect(JSON.stringify(plain)).toContain('Ana Silva');
    expect(JSON.stringify(masked)).not.toContain('Ana Silva');
    await app.close();
  });

  it('gives the same answer for an entity that is gone, one of a type the mapping no longer has and a repeat, and reads a repeat once', async () => {
    const { app, executor } = await started({ answer: answerWidgets([]) });
    const gone = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', entities: [el('widget', 'W-9')] })).json());
    const unmapped = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', entities: [el('retired', 'W-9')] })).json());
    expect(gone.missing.entities).toHaveLength(1);
    expect(unmapped.missing.entities).toHaveLength(1);
    expect(Object.keys(gone)).toEqual(Object.keys(unmapped));
    expect(gone.nodes).toEqual(unmapped.nodes);
    const before = asked(executor);
    await post(app, { sourceId: 'demo', entities: [el('widget', 'W-9'), el('widget', 'W-9')] });
    expect(asked(executor) - before).toBe(1);
    await app.close();
  });

  it('runs fixed statements with the stable ID as a parameter, never in the text', async () => {
    const { app, executor } = await started({ answer: answerWidgets(['W-1']) });
    await post(app, { sourceId: 'demo', entities: [el('widget', 'W-1')] });
    const [call] = entityCalls(executor);
    expect(call?.cypher).toBe(
      'UNWIND range(0, size($refs) - 1) AS i CALL { WITH i MATCH (n:`Widget`) USING INDEX SEEK n:`Widget`(`widgetId`) WHERE n.`widgetId` IN [$refs[i].stableId, $refs[i].stableInteger] RETURN n ORDER BY elementId(n) LIMIT 2 } WITH i, collect(n) AS found RETURN i, found[0] AS n, size(found) > 1 AS dup ORDER BY i LIMIT $limit + 1',
    );
    expect(call === undefined ? [] : idsOf(call)).toEqual(['W-1']);
    expect(call?.cypher).not.toContain('W-1');
    await app.close();
  });

  it.each([
    ['more than the limit of references', () => ({ sourceId: 'demo', entities: Array.from({ length: MAX_READ_REFS + 1 }, (_unused, index) => el('widget', `W-${index}`)) }), 400, 'INVALID_REQUEST'],
    ['a body with an unknown field', () => ({ sourceId: 'demo', extra: 1 }), 400, 'INVALID_REQUEST'],
    ['a reference of another source', () => ({ sourceId: 'demo', entities: [{ sourceId: 'other', entityType: 'widget', stableId: 'W-1' }] }), 400, 'SOURCE_MISMATCH'],
    ['a reference of a keyed type that is not a token', () => ({ sourceId: 'demo', entities: [el('phone', '+1-212-555-0100')] }), 400, 'INVALID_REQUEST'],
  ])('refuses %s and reads nothing', async (_name, payload, status, code) => {
    const { app, executor } = await started({ answer: answerWidgets(['W-1']) });
    const response = await post(app, payload());
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(entityCalls(executor)).toHaveLength(0);
    await app.close();
  });

  it('accepts the token of a keyed entity', async () => {
    const token = makeToken(TEST_REFERENCE_KEYS, { sourceId: 'demo', entityType: 'phone' }, '+1-212-555-0100');
    const { app } = await started({ answer: (call) => (call.templateId === 'entity-load-many' ? { status: 'rows', rows: [{ i: 0, dup: false, n: plainNode(['Handle'], { phoneNumber: '+1-212-555-0100' }, '4:s:p') }] } : { status: 'rows', rows: [] }) });
    const response = await post(app, { sourceId: 'demo', entities: [el('phone', token)] });
    expect(response.statusCode).toBe(200);
    expect(readRefsResponseSchema.parse(response.json()).nodes.map((node) => node.ref.stableId)).toEqual([token]);
    await app.close();
  });

  it.each([
    ['times out', { status: 'timeout' as const }, 504, 'QUERY_TIMEOUT'],
    ['is unavailable', { status: 'unavailable' as const, reason: 'unreachable' as const }, 503, 'SOURCE_UNAVAILABLE'],
  ])('returns no node when the source %s', async (_name, outcome, status, code) => {
    const { app } = await started({ answer: (call) => (call.templateId === 'entity-load-many' ? outcome : { status: 'rows', rows: [] }) });
    const response = await post(app, { sourceId: 'demo', entities: [el('widget', 'W-1')] });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(response.json()).not.toHaveProperty('nodes');
    await app.close();
  });

  it('answers NOT_FOUND for a source the person may not read, with nothing read', async () => {
    const { app, executor } = await started({ deny: true, answer: answerWidgets(['W-1']) });
    const response = await post(app, { sourceId: 'demo', entities: [el('widget', 'W-1')] });
    expect(response.statusCode).toBe(404);
    expect(entityCalls(executor)).toHaveLength(0);
    await app.close();
  });

  it('counts a call as one request however many references it holds, and refuses the call past the limit', async () => {
    const { app } = await started({ mapping: limited, answer: answerWidgets(['W-1']) });
    const refs = { sourceId: 'demo', entities: [el('widget', 'W-1'), el('widget', 'W-2'), el('widget', 'W-3')] };
    expect((await post(app, refs)).statusCode).toBe(200);
    expect((await post(app, refs)).statusCode).toBe(200);
    const refused = await post(app, refs);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    await app.close();
  });

  it('records one audit event of its own with counts only, never a value or an ID', async () => {
    const { app, events } = await started({ answer: answerWidgets(['W-1']) });
    await post(app, { sourceId: 'demo', entities: [el('widget', 'W-1'), el('widget', 'W-2')] });
    const own = events.filter((event) => event.action === 'graph.read_refs');
    expect(own).toEqual([expect.objectContaining({ result: 'success', sourceId: 'demo', detail: { counts: { nodes: 1, edges: 0, missing: 1 } } })]);
    expect(JSON.stringify(events)).not.toContain('W-1');
    await app.close();
  });
});

describe('POST /v1/graph/read-refs: one answer for an item the person may not read and one that is gone', () => {
  it('lists an entity the policy takes out of the result exactly as it lists one the source no longer holds', async () => {
    const hidden = await started({ hideNode: 'W-1', answer: answerWidgets(['W-1']) });
    const gone = await started({ answer: answerWidgets([]) });
    const shown = readRefsResponseSchema.parse((await post(hidden.app, { sourceId: 'demo', entities: [el('widget', 'W-1')] })).json());
    const absent = readRefsResponseSchema.parse((await post(gone.app, { sourceId: 'demo', entities: [el('widget', 'W-1')] })).json());
    expect(shown).toEqual(absent);
    await hidden.app.close();
    await gone.app.close();
  });

  it('lists a stored edge the policy takes out of the result exactly as it lists one the source no longer holds', async () => {
    const ref = { sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };
    const hidden = await started({ hideEdge: 'L-1', answer: (call) => (call.templateId === 'edge-load-many' ? { status: 'rows', rows: [{ i: 0, dup: false, ...link('L-1') }] } : { status: 'rows', rows: [] }) });
    const gone = await started({ answer: () => ({ status: 'rows', rows: [] }) });
    const shown = readRefsResponseSchema.parse((await post(hidden.app, { sourceId: 'demo', edges: [ref] })).json());
    const absent = readRefsResponseSchema.parse((await post(gone.app, { sourceId: 'demo', edges: [ref] })).json());
    expect(shown).toEqual(absent);
    expect(shown.missing.edges).toEqual([ref]);
    await hidden.app.close();
    await gone.app.close();
  });
});

describe('POST /v1/graph/read-refs: stored edges', () => {
  const ref = (id: string) => ({ sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: id });
  const answer = (known: readonly string[]) => (call: ExecuteCall): ExecuteOutcome =>
    call.templateId === 'edge-load-many' ? { status: 'rows', rows: idsOf(call).flatMap((id, i) => (known.includes(id) ? [{ i, dup: false, ...link(id) }] : [])) } : { status: 'rows', rows: [] };

  it('returns each stored edge the source still holds and lists the others as missing, including a type with no stable ID in the mapping', async () => {
    const { app, events } = await started({ answer: answer(['L-1']) });
    const none = { sourceId: 'demo', type: 'BARE', from: 'widget', to: 'gadget', stableId: 'L-1' };
    const response = await post(app, { sourceId: 'demo', edges: [ref('L-1'), ref('L-2'), none] });
    expect(response.statusCode).toBe(200);
    const body = readRefsResponseSchema.parse(response.json());
    expect(body.edges.map((edge) => edge.ref)).toEqual([ref('L-1')]);
    expect(body.missing.edges).toEqual([ref('L-2'), none]);
    expect(events.filter((event) => event.action === 'edge.load')).toHaveLength(1);
    await app.close();
  });

  it('reads the stored edges of a call in runs of at most the page of the source under one audit event, and maps each answer back to its reference', async () => {
    const known = ['L-0', 'L-49', 'L-50', 'L-99'];
    const { app, executor, events } = await started({ answer: answer(known) });
    const asked = Array.from({ length: MAX_READ_REFS }, (_unused, index) => ref(`L-${index}`));
    const body = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', edges: asked })).json());
    const calls = executor.calls.filter((call) => call.templateId === 'edge-load-many');
    expect(calls.map((call) => idsOf(call).length)).toEqual([50, 50]);
    expect(body.edges.map((edge) => edge.ref)).toEqual(known.map(ref));
    expect(body.missing.edges).toHaveLength(MAX_READ_REFS - known.length);
    expect(events.filter((event) => event.action === 'edge.load')).toHaveLength(1);
    await app.close();
  });

  it('returns an edge whose ends are not asked for in the same call', async () => {
    const { app } = await started({ answer: answer(['L-1']) });
    const body = readRefsResponseSchema.parse((await post(app, { sourceId: 'demo', edges: [ref('L-1')] })).json());
    expect(body.edges).toHaveLength(1);
    expect(body.nodes).toHaveLength(0);
    await app.close();
  });

  it('refuses more than the limit, and an end of another source, and reads nothing', async () => {
    const { app, executor } = await started({ answer: answer(['L-1']) });
    expect((await post(app, { sourceId: 'demo', edges: Array.from({ length: MAX_READ_REFS + 1 }, (_unused, index) => ref(`L-${index}`)) })).statusCode).toBe(400);
    const other = await post(app, { sourceId: 'demo', edges: [{ ...ref('L-1'), sourceId: 'other' }] });
    expect(other.json()).toMatchObject({ error: { code: 'SOURCE_MISMATCH' } });
    expect(executor.calls.filter((call) => call.templateId === 'edge-load-many')).toHaveLength(0);
    await app.close();
  });

  it('returns no edge when the source is slow', async () => {
    const { app } = await started({ answer: (call) => (call.templateId === 'edge-load-many' ? { status: 'timeout' } : { status: 'rows', rows: [] }) });
    const response = await post(app, { sourceId: 'demo', edges: [ref('L-1')] });
    expect(response.statusCode).toBe(504);
    expect(response.json()).not.toHaveProperty('edges');
    await app.close();
  });
});

describe('POST /v1/graph/read-refs: aggregate and derived edges', () => {
  const derivedMapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: DERIVED_ENTITIES, relationships: [...DERIVED_AGGREGATE], derived: [DERIVED_RULE] })), 'neburyx.yaml');
  const storedMapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: DERIVED_ENTITIES, relationships: DERIVED_STORED, derived: [DERIVED_RULE] })), 'neburyx.yaml');
  const end = (stableId: string, entityType = 'maker') => ({ sourceId: 'demo', entityType, stableId });
  const time = (day: number) => ({ $type: 'dateTime', value: `2026-01-${String(day).padStart(2, '0')}T10:00:00Z` });
  const sampleRow = (count: number) => ({ a: account('A-1'), b: device('D-1'), sample: Array.from({ length: count }, (_unused, index) => ({ t: time(index + 1) })) });
  const aggregateRef = (from = 'A-1') => ({ sourceId: 'demo', aggregate: { type: 'USES_TOOL', from: end(from), to: end('D-1', 'tool') } });
  const derivedRef = { sourceId: 'demo', derived: { ruleId: 'shared-tool', from: end('A-1'), to: end('A-2') } };

  it('returns an aggregate with its member count and the count labelled, and lists one with no member as missing', async () => {
    const { app } = await started({
      mapping: derivedMapping,
      answer: (call) => {
        if (call.templateId === AGGREGATE_SAMPLE_ID) return { status: 'rows', rows: call.parameters['ends'] !== undefined && JSON.stringify(call.parameters).includes('A-1') ? [sampleRow(3)] : [] };
        if (call.templateId === AGGREGATE_SUMMARY_ID) return { status: 'rows', rows: [{ members: 3, first: time(1), last: time(3) }] };
        return { status: 'rows', rows: [] };
      },
    });
    const response = await post(app, { sourceId: 'demo', aggregates: [aggregateRef('A-1'), aggregateRef('A-9')] });
    expect(response.statusCode).toBe(200);
    const body = readRefsResponseSchema.parse(response.json());
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0]).toMatchObject({ ref: aggregateRef('A-1'), memberCount: { value: 3, quality: 'exact', scope: 'aggregate:members' } });
    expect(JSON.stringify(body.edges)).not.toContain('sample');
    expect(body.missing.edges).toEqual([aggregateRef('A-9')]);
    await app.close();
  });

  it('returns a derived relationship with its rule and its supports, and lists one the rule no longer finds, or whose rule is gone, as missing', async () => {
    const { app, executor } = await started({ mapping: storedMapping, answer: (call) => (call.templateId === DERIVED_EDGE_SUPPORT_ID && JSON.stringify(call.parameters).includes('A-2') ? { status: 'rows', rows: [chain('A-1', 'A-2', 'D-1'), chain('A-1', 'A-2', 'D-2')] } : { status: 'rows', rows: [] }) });
    const gone = { sourceId: 'demo', derived: { ruleId: 'no-such-rule', from: end('A-1'), to: end('A-2') } };
    const empty = { sourceId: 'demo', derived: { ruleId: 'shared-tool', from: end('A-1'), to: end('A-7') } };
    const response = await post(app, { sourceId: 'demo', derived: [derivedRef, empty, gone] });
    expect(response.statusCode).toBe(200);
    const body = readRefsResponseSchema.parse(response.json());
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0]).toMatchObject({ ref: derivedRef, semantics: 'derived', derivation: { ruleId: 'shared-tool', ruleVersion: 2 } });
    expect(body.edges[0]?.derivation?.supportingEdgeRefs.length).toBeGreaterThan(0);
    expect(body.missing.edges).toEqual([empty, gone]);
    expect(executor.calls.filter((call) => call.templateId === DERIVED_EDGE_SUPPORT_ID).length).toBeGreaterThan(0);
    await app.close();
  });

  it('refuses an end of a keyed type that is not a token of this deployment, for an aggregate and for a derived relationship, and reads nothing', async () => {
    const keyed = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ ...DERIVED_ENTITIES[0], pii: [{ property: 'makerId', class: 'text' }] }, DERIVED_ENTITIES[1]], relationships: [...DERIVED_AGGREGATE], derived: [DERIVED_RULE] })), 'neburyx.yaml');
    const { app, executor } = await started({ mapping: keyed });
    const viaAggregate = await post(app, { sourceId: 'demo', aggregates: [aggregateRef('RAW-ID')] });
    expect(viaAggregate.statusCode).toBe(400);
    expect(viaAggregate.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    const viaRule = await post(app, { sourceId: 'demo', derived: [derivedRef] });
    expect(viaRule.statusCode).toBe(400);
    expect(viaRule.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(executor.calls.filter((call) => [AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID, DERIVED_EDGE_SUPPORT_ID].includes(call.templateId))).toHaveLength(0);
    await app.close();
  });

  it('refuses more than the limit and an end of another source, and reads nothing', async () => {
    const { app, executor } = await started({ mapping: storedMapping });
    expect((await post(app, { sourceId: 'demo', derived: Array.from({ length: MAX_READ_REFS + 1 }, () => derivedRef) })).statusCode).toBe(400);
    const other = await post(app, { sourceId: 'demo', derived: [{ ...derivedRef, derived: { ...derivedRef.derived, to: { ...end('A-2'), sourceId: 'other' } } }] });
    expect(other.json()).toMatchObject({ error: { code: 'SOURCE_MISMATCH' } });
    expect(executor.calls.filter((call) => call.templateId === DERIVED_EDGE_SUPPORT_ID)).toHaveLength(0);
    await app.close();
  });

  it('returns nothing when the source is busy or slow during a derived read', async () => {
    const { app } = await started({ mapping: storedMapping, answer: (call) => (call.templateId === DERIVED_EDGE_SUPPORT_ID ? { status: 'timeout' } : { status: 'rows', rows: [] }) });
    const response = await post(app, { sourceId: 'demo', derived: [derivedRef] });
    expect(response.statusCode).toBe(504);
    expect(response.json()).not.toHaveProperty('edges');
    await app.close();
  });
});
