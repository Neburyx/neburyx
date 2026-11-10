import { rmSync } from 'node:fs';
import { derivedEdgeDetailSchema, edgeRefSegmentOf, sourceLinkSegmentOf, type DerivedEdgeRef } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { redactItems } from '../gate/redact/index.js';
import { DERIVED_EDGE_SUPPORT_ID } from '../gate/templates/derived-edge-support.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { account, chain, DERIVED_AGGREGATE, DERIVED_ENTITIES, DERIVED_RULE, DERIVED_STORED, device, hidingEdgeRedact, hidingRedact, pathOf } from '../testing/derived-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainRelationship } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const piiEntities = [{ ...DERIVED_ENTITIES[0], title: '{displayName}', pii: [{ property: 'displayName', class: 'name' }] }, DERIVED_ENTITIES[1]];
const mappingOf = (overrides: Record<string, unknown> = {}) => parseMapping(fileOf(baseSource({ id: 'demo', entities: DERIVED_ENTITIES, relationships: DERIVED_STORED, derived: [DERIVED_RULE], ...overrides })), 'neburyx.yaml');

interface Options {
  readonly rows?: readonly Record<string, unknown>[];
  readonly outcome?: ExecuteOutcome;
  readonly answer?: (call: ExecuteCall) => ExecuteOutcome;
  readonly deny?: boolean;
  readonly mapping?: ReturnType<typeof mappingOf>;
  readonly hideStableId?: string;
  readonly hideEdgeStableId?: string;
}

async function started(options: Options = {}) {
  const mapping = options.mapping ?? mappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve(options.answer?.(call) ?? options.outcome ?? { status: 'rows', rows: options.rows ?? [] });
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy,
    coordinator: defaults.coordinator,
    audit: { record: (event) => (events.push(event), Promise.resolve()) },
  };
  const parts = testSourceGate(mapping, { executor, seams, ...(options.hideStableId !== undefined ? { redact: hidingRedact(options.hideStableId, redactItems) } : options.hideEdgeStableId !== undefined ? { redact: hidingEdgeRedact(options.hideEdgeStableId, redactItems) } : {}) });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
  return { app, executor, events };
}

type Started = Awaited<ReturnType<typeof started>>;
const end = (stableId: string, entityType = 'maker') => ({ sourceId: 'demo', entityType, stableId });
const REF: DerivedEdgeRef = { sourceId: 'demo', derived: { ruleId: 'shared-tool', from: end('A-1'), to: end('A-2') } };
const urlOf = (ref: unknown, query = '') => `/v1/edges/${encodeURIComponent(edgeRefSegmentOf(ref as DerivedEdgeRef))}${query}`;
const get = (app: Started["app"], url: string) => app.inject({ method: "GET", url });
const withoutTrace = (body: string): string => body.replace(/"traceId":"[^"]*"/, "");
const reads = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === DERIVED_EDGE_SUPPORT_ID);
const chains = (count: number) => Array.from({ length: count }, (_unused, index) => chain('A-1', 'A-2', `D-${index + 1}`));

describe('GET /v1/edges/{ref} for a derived relationship', () => {
  it('answers 200 with the rule and its version from the mapping, both ends and the supports grouped by middle entity, as one fixed read and one audit event', async () => {
    const { app, executor, events } = await started({ rows: chains(2) });
    const response = await get(app, urlOf(REF));
    expect(response.statusCode).toBe(200);
    const body = derivedEdgeDetailSchema.parse(response.json());
    expect(body).toMatchObject({ semantics: 'derived', type: 'shared-tool', rule: { id: 'shared-tool', version: 2 }, from: { ref: end('A-1') }, to: { ref: end('A-2') } });
    expect(body.supports.count).toEqual({ value: 2, quality: 'exact', scope: 'derived:supports' });
    expect(body.supports.groups.map((group) => group.middle.map((middle) => middle.ref.stableId))).toEqual([['D-1'], ['D-2']]);
    const [first] = body.supports.groups;
    expect(first?.supports).toHaveLength(2);
    expect(first?.supports[0]).toMatchObject({ type: 'USES_TOOL', evidence: { status: 'not-available' } });
    expect(reads(executor)).toHaveLength(1);
    expect(events.filter((event) => event.action === 'edge.derived_support')).toHaveLength(1);
  });

  it('shows the source records of a stored support', async () => {
    const mapping = mappingOf({ relationships: [{ type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId', evidence: ['recordId'] }] });
    const a = account('A-1');
    const b = account('A-2');
    const d = device('D-1');
    const row = pathOf(a, [
      { relationship: plainRelationship('USES_TOOL', a, d, { useId: 'U-1', recordId: 'AUTH-1' }), end: d },
      { relationship: plainRelationship('USES_TOOL', b, d, { useId: 'U-2', recordId: 'AUTH-2' }), end: b },
    ]);
    const { app } = await started({ rows: [row], mapping });
    const body = derivedEdgeDetailSchema.parse((await get(app, urlOf(REF))).json());
    expect(body.supports.groups[0]?.supports.map((support) => support.evidence)).toEqual([
      { status: 'available', records: [{ sourceRecordId: 'AUTH-1', linkable: false }] },
      { status: 'available', records: [{ sourceRecordId: 'AUTH-2', linkable: false }] },
    ]);
  });

  it('marks a support record linkable only when the property the link names holds it and an address can be built, and opens it through the support\'s own stored reference', async () => {
    const mapping = mappingOf({ relationships: [{ type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId', evidence: ['recordId', 'docId'], evidence_link: 'https://records.example.test/r/{recordId}' }] });
    const a = account('A-1');
    const b = account('A-2');
    const d = device('D-1');
    const first = plainRelationship('USES_TOOL', a, d, { useId: 'U-1', recordId: 'AUTH-1', docId: 'DOC-1' });
    const second = plainRelationship('USES_TOOL', b, d, { useId: 'U-2', recordId: '..' });
    const row = pathOf(a, [
      { relationship: first, end: d },
      { relationship: second, end: b },
    ]);
    const edgeRow = (relationship: Record<string, unknown>) => ({ status: 'rows' as const, rows: [{ r: relationship, a, b: d }] });
    const { app } = await started({ rows: [row], mapping, answer: (call) => (call.templateId === 'edge-load' ? edgeRow(first) : { status: 'rows', rows: [row] }) });
    const body = derivedEdgeDetailSchema.parse((await get(app, urlOf(REF))).json());
    const [one, two] = body.supports.groups[0]?.supports ?? [];
    expect(one?.evidence).toEqual({ status: 'available', records: [{ sourceRecordId: 'AUTH-1', linkable: true }, { sourceRecordId: 'DOC-1', linkable: false }] });
    expect(two?.evidence).toEqual({ status: 'available', records: [{ sourceRecordId: '..', linkable: false }] });
    if (one === undefined || !('stableId' in one.ref)) throw new Error('the first support is a stored relationship');
    const opened = await get(app, `/v1/source-links/${encodeURIComponent(sourceLinkSegmentOf({ form: 'stored', ref: one.ref }))}?record=AUTH-1`);
    expect(opened.statusCode).toBe(302);
    expect(opened.headers['location']).toBe('https://records.example.test/r/AUTH-1');
  });

  it('shows a support with no stable ID as an aggregate with the no-stable-id state and no member value', async () => {
    const a = account('A-1');
    const b = account('A-2');
    const d = device('D-1');
    const row = pathOf(a, [
      { relationship: plainRelationship('USES_TOOL', a, d, { recordId: 'SECRET-1' }, 'rel-aaa'), end: d },
      { relationship: plainRelationship('USES_TOOL', b, d, { recordId: 'SECRET-2' }, 'rel-bbb'), end: b },
    ]);
    const { app } = await started({ rows: [row], mapping: mappingOf({ relationships: DERIVED_AGGREGATE }) });
    const response = await get(app, urlOf(REF));
    const body = derivedEdgeDetailSchema.parse(response.json());
    for (const support of body.supports.groups[0]?.supports ?? []) {
      expect('aggregate' in support.ref).toBe(true);
      expect(support.evidence).toEqual({ status: 'no-stable-id' });
    }
    expect(response.body).not.toContain('SECRET');
    expect(response.body).not.toContain('rel-aaa');
  });

  it('is bounded by the cap: 25 chains are exact, 26 are a lower bound of 25, and a lowered max_page lowers the cap', async () => {
    const whole = derivedEdgeDetailSchema.parse((await get((await started({ rows: chains(25) })).app, urlOf(REF))).json());
    expect(whole.supports.count).toMatchObject({ value: 25, quality: 'exact' });
    const run = await started({ rows: chains(26) });
    const cut = derivedEdgeDetailSchema.parse((await get(run.app, urlOf(REF))).json());
    expect(cut.supports.groups).toHaveLength(25);
    expect(cut.supports.count).toMatchObject({ value: 25, quality: 'lowerBound' });
    const lowered = await started({ rows: chains(11), mapping: mappingOf({ budgets: { max_page: 10 } }) });
    const small = derivedEdgeDetailSchema.parse((await get(lowered.app, urlOf(REF))).json());
    expect(small.supports.count).toMatchObject({ value: 10, quality: 'lowerBound' });
    expect(reads(lowered.executor)[0]?.parameters).toMatchObject({ limit: 10 });
  });

  it('is a lower bound when a chain was left out as not mapped, and says so in the warnings', async () => {
    const stranger = { ...account('X-9'), labels: ['Stranger'] };
    const a = account('A-1');
    const d = device('D-9');
    const bad = pathOf(a, [
      { relationship: plainRelationship('USES_TOOL', a, d, { useId: 'E-1' }), end: d },
      { relationship: plainRelationship('USES_TOOL', stranger, d, { useId: 'E-2' }), end: stranger as never },
    ]);
    const { app } = await started({ rows: [chain('A-1', 'A-2'), bad] });
    const body = derivedEdgeDetailSchema.parse((await get(app, urlOf(REF))).json());
    expect(body.supports.count).toMatchObject({ value: 1, quality: 'lowerBound' });
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it('follows masking: the titles of the ends are masked', async () => {
    const mapping = mappingOf({ entities: piiEntities });
    const { app } = await started({ rows: [chain('A-1', 'A-2', 'D-1', { displayName: 'Ana Silva' })], mapping });
    const masked = derivedEdgeDetailSchema.parse((await get(app, urlOf(REF, '?mask=true'))).json());
    expect(masked.from.title).not.toContain('Ana');
    const plain = derivedEdgeDetailSchema.parse((await get(app, urlOf(REF))).json());
    expect(plain.from.title).toContain('Ana');
  });

  it('has no confidence, score, element ID or URL anywhere in the body', async () => {
    const { app } = await started({ rows: chains(2) });
    const text = (await get(app, urlOf(REF))).body;
    expect(text).not.toMatch(/confidence|score|elementId|https?:/i);
  });
});

describe('the refusals of a derived relationship', () => {
  it('is NOT_FOUND, with the body of every other NOT_FOUND, for no chain, an unknown source and a source the person may not read', async () => {
    const none = await get((await started({ rows: [] })).app, urlOf(REF));
    expect(none.statusCode).toBe(404);
    const unknown = await get((await started({ rows: chains(1) })).app, urlOf({ ...REF, sourceId: 'nowhere', derived: { ...REF.derived, from: end('A-1'), to: end('A-2') } }));
    const denied = await get((await started({ rows: chains(1), deny: true })).app, urlOf(REF));
    expect(unknown.statusCode).toBe(404);
    expect(denied.statusCode).toBe(404);
    expect(withoutTrace(denied.body)).toBe(withoutTrace(none.body));
    expect(withoutTrace(unknown.body)).toBe(withoutTrace(none.body));
  });

  it('is NOT_FOUND, and holds no title of the hidden element, when an end, a middle entity or a support is not visible', async () => {
    for (const hidden of ['A-2', 'D-2']) {
      const { app } = await started({ rows: chains(3), hideStableId: hidden });
      const response = await get(app, urlOf(REF));
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(hidden);
      expect(withoutTrace(response.body)).toBe(withoutTrace((await get((await started({ rows: [] })).app, urlOf(REF))).body));
    }
  });

  it('is NOT_FOUND, with no trace of the support, when one supporting relationship is hidden and both its ends are shown', async () => {
    const { app } = await started({ rows: chains(3), hideEdgeStableId: 'A-2-D-2' });
    const response = await get(app, urlOf(REF));
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('A-2-D-2');
    expect(withoutTrace(response.body)).toBe(withoutTrace((await get((await started({ rows: [] })).app, urlOf(REF))).body));
  });

  it('is INVALID_REQUEST, and reads nothing, for a rule not in the mapping, ends of the wrong types, the same entity at both ends and an end of another source', async () => {
    const { app, executor } = await started({ rows: chains(1) });
    const refs = [
      { ...REF, derived: { ...REF.derived, ruleId: 'unknown' } },
      { ...REF, derived: { ...REF.derived, to: end('T-1', 'tool') } },
      { ...REF, derived: { ...REF.derived, to: end('A-1') } },
      { ...REF, derived: { ...REF.derived, to: { ...end('A-2'), sourceId: 'other' } } },
    ];
    for (const ref of refs) expect((await get(app, urlOf(ref))).statusCode).toBe(400);
    expect(reads(executor)).toHaveLength(0);
  });
});

describe('the failures of the derived read', () => {
  it('answers QUERY_TIMEOUT for a read that times out and SOURCE_UNAVAILABLE for a source that is down, as every read does, and writes an audit event that names the action and no stable ID', async () => {
    const timeout = await started({ outcome: { status: 'timeout' } });
    const late = await get(timeout.app, urlOf(REF));
    expect(late.statusCode).toBe(504);
    expect(JSON.parse(late.body)).toMatchObject({ error: { code: 'QUERY_TIMEOUT', retryable: true } });
    const down = await started({ outcome: { status: 'unavailable', reason: 'unreachable' } });
    expect(JSON.parse((await get(down.app, urlOf(REF))).body)).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE' } });
    const event = timeout.events.find((each) => each.action === 'edge.derived_support');
    expect(event).toMatchObject({ result: 'failed' });
    expect(JSON.stringify(event)).not.toContain('A-1');
  });

  it('answers SOURCE_UNAVAILABLE for a source whose breaker is open and reads nothing for the refused request', async () => {
    const { app, executor } = await started({ outcome: { status: 'timeout' }, mapping: mappingOf({ budgets: { breaker_failures: 2, breaker_cooldown_ms: 30_000 } }) });
    expect((await get(app, urlOf(REF))).statusCode).toBe(504);
    expect((await get(app, urlOf(REF))).statusCode).toBe(504);
    const readsBefore = reads(executor).length;
    const refused = await get(app, urlOf(REF));
    expect(refused.statusCode).toBe(503);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE', details: { reason: 'repeated-timeouts' } } });
    expect(reads(executor)).toHaveLength(readsBefore);
  });
});
