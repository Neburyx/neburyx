import { rmSync } from 'node:fs';
import { aggregateEdgeDetailSchema, edgeRefSegmentOf, type AggregateEdgeRef } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { redactItems } from '../gate/redact/index.js';
import { AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID } from '../gate/templates/aggregate-evidence.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { AppError } from '../errors.js';
import { account, DERIVED_ENTITIES, device, hidingRedact } from '../testing/derived-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { COUNT_BUSY_WARNING, COUNT_CHANGED_WARNING, COUNT_TIMED_OUT_WARNING } from './edge-reader.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const AGGREGATE_ROW = { type: 'USES_TOOL', from: 'maker', to: 'tool', observed_at: 'seenAt', filterable: ['remark'], evidence: ['recordId'] };
const piiEntities = [{ ...DERIVED_ENTITIES[0], title: '{displayName}', pii: [{ property: 'displayName', class: 'name' }] }, DERIVED_ENTITIES[1]];
const mappingOf = (overrides: Record<string, unknown> = {}, row: Record<string, unknown> = AGGREGATE_ROW) =>
  parseMapping(fileOf(baseSource({ id: 'demo', entities: DERIVED_ENTITIES, relationships: [row], ...overrides })), 'neburyx.yaml');

const time = (day: number) => ({ $type: 'dateTime', value: `2026-01-${String(day).padStart(2, '0')}T10:00:00Z` });
const member = (day: number) => ({ t: time(day), p0: 'web' });
const sampleRow = (count: number, extra: Record<string, unknown> = {}) => ({ a: account('A-1', extra), b: device('D-1'), sample: Array.from({ length: count }, (_unused, index) => member(index + 1)) });
const summaryRow = (members: number) => ({ members, first: time(1), last: time(28) });

interface Options {
  readonly sample?: ExecuteOutcome;
  readonly summary?: ExecuteOutcome;
  readonly mapping?: ReturnType<typeof mappingOf>;
  readonly deny?: boolean;
  readonly hideStableId?: string;
  readonly summaryError?: AppError;
}

async function started(options: Options = {}) {
  const mapping = options.mapping ?? mappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> =>
    call.templateId === AGGREGATE_SUMMARY_ID && options.summaryError !== undefined ? Promise.reject(options.summaryError) : Promise.resolve(call.templateId === AGGREGATE_SAMPLE_ID ? (options.sample ?? { status: 'rows', rows: [sampleRow(3)] }) : (options.summary ?? { status: 'rows', rows: [summaryRow(42)] }));
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy,
    coordinator: defaults.coordinator,
    audit: { record: (event) => (events.push(event), Promise.resolve()) },
  };
  const parts = testSourceGate(mapping, { executor, seams, ...(options.hideStableId !== undefined ? { redact: hidingRedact(options.hideStableId, redactItems) } : {}) });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
  return { app, executor, events };
}

type Started = Awaited<ReturnType<typeof started>>;
const end = (stableId: string, entityType: string) => ({ sourceId: 'demo', entityType, stableId });
const REF: AggregateEdgeRef = { sourceId: 'demo', aggregate: { type: 'USES_TOOL', from: end('A-1', 'maker'), to: end('D-1', 'tool') } };
const urlOf = (ref: unknown, query = '') => `/v1/edges/${encodeURIComponent(edgeRefSegmentOf(ref as AggregateEdgeRef))}${query}`;
const get = (app: Started['app'], url: string) => app.inject({ method: 'GET', url });
const withoutTrace = (body: string): string => body.replace(/"traceId":"[^"]*"/, '');
const readsOf = (executor: TestExecutor, templateId: string) => executor.calls.filter((call) => call.templateId === templateId);
const answered = async (options: Options = {}, query = '') => {
  const run = await started(options);
  const response = await get(run.app, urlOf(REF, query));
  return { ...run, response };
};

describe('GET /v1/edges/{ref} for an aggregate', () => {
  it('answers 200 with the exact count, the observed range and the sample, as a sample read and then a summary read with one audit event each', async () => {
    const { response, executor, events } = await answered();
    expect(response.statusCode).toBe(200);
    const body = aggregateEdgeDetailSchema.parse(response.json());
    expect(body).toMatchObject({ semantics: 'aggregate', type: 'USES_TOOL', from: { ref: end('A-1', 'maker') }, to: { ref: end('D-1', 'tool') }, members: { value: 42, quality: 'exact', scope: 'aggregate:members' }, observedFirst: '2026-01-01T10:00:00Z', observedLast: '2026-01-28T10:00:00Z' });
    expect(body.sample.rows).toHaveLength(3);
    expect(body.sample).toMatchObject({ order: 'observed-newest', more: 39 });
    expect(body.sample.rows[0]).toEqual({ observedAt: '2026-01-01T10:00:00Z', properties: [{ key: 'remark', value: 'web', dataClass: 'text', masked: false }] });
    expect(executor.calls.map((call) => call.templateId).filter((id) => id === AGGREGATE_SAMPLE_ID || id === AGGREGATE_SUMMARY_ID)).toEqual([AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID]);
    expect(events.filter((event) => event.action === 'edge.aggregate_sample')).toHaveLength(1);
    expect(events.filter((event) => event.action === 'edge.aggregate_summary')).toHaveLength(1);
  });

  it('holds no element ID, record ID, member reference or URL anywhere in the whole body', async () => {
    const a = account('A-1');
    const b = device('D-1');
    const members = [{ t: time(1), p0: 'web', elementId: '4:leak:1', recordId: 'SECRET-REC', url: 'https://example.test/x', ref: { stableId: 'M-1' } }];
    const { response } = await answered({ sample: { status: 'rows', rows: [{ a, b, sample: members }] } });
    expect(response.statusCode).toBe(200);
    const text = response.body;
    for (const leak of ['4:leak:1', 'SECRET-REC', 'example.test', a.elementId, b.elementId, 'M-1']) expect(text).not.toContain(leak);
    const body = aggregateEdgeDetailSchema.parse(response.json());
    expect(Object.keys(body).sort()).toEqual(['from', 'members', 'observedFirst', 'observedLast', 'qualityFlags', 'ref', 'sample', 'semantics', 'to', 'type', 'warnings']);
    expect(Object.keys(body.sample).sort()).toEqual(['more', 'order', 'rows']);
    for (const row of body.sample.rows) expect(Object.keys(row).sort()).toEqual(['observedAt', 'properties']);
  });

  it('samples at most min(25, max_page): 10 when the source lowered max_page, 25 at the highest it may be set', async () => {
    const low = await answered({ mapping: mappingOf({ budgets: { max_page: 10 } }) });
    expect(readsOf(low.executor, AGGREGATE_SAMPLE_ID)[0]?.parameters).toMatchObject({ limit: 10 });
    const high = await answered({ mapping: mappingOf({ budgets: { max_page: 50 } }), sample: { status: 'rows', rows: [sampleRow(25)] } });
    expect(readsOf(high.executor, AGGREGATE_SAMPLE_ID)[0]?.parameters).toMatchObject({ limit: 25 });
    expect(aggregateEdgeDetailSchema.parse(high.response.json()).sample).toMatchObject({ rows: expect.any(Array), more: 17 });
  });

  it.each([['cursor', '?cursor=abc'], ['limit', '?limit=5'], ['offset', '?offset=1'], ['page', '?page=2']])('refuses the query parameter %s: there is no paging', async (_name, query) => {
    const { response, executor } = await answered({}, query);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(readsOf(executor, AGGREGATE_SAMPLE_ID)).toHaveLength(0);
  });

  it('refuses a segment that does not parse, a type the mapping does not join, and ends of another source, as INVALID_REQUEST with no read', async () => {
    const run = await started();
    const other: AggregateEdgeRef = { sourceId: 'demo', aggregate: { type: 'USES_TOOL', from: { ...end('A-1', 'maker'), sourceId: 'other' }, to: end('D-1', 'tool') } };
    for (const url of ['/v1/edges/not*base64', urlOf({ ...REF, aggregate: { ...REF.aggregate, type: 'UNMAPPED' } }), urlOf({ ...REF, aggregate: { ...REF.aggregate, to: end('A-2', 'maker') } }), urlOf(other)]) {
      const response = await get(run.app, url);
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    }
    expect(readsOf(run.executor, AGGREGATE_SAMPLE_ID)).toHaveLength(0);
  });

  it('answers NOT_FOUND, with the same body, for an unreadable source, a missing end, no member and an end the policy hides', async () => {
    const denied = await answered({ deny: true });
    const missing = await answered({ sample: { status: 'rows', rows: [] } });
    const empty = await answered({ sample: { status: 'rows', rows: [{ a: account('A-1'), b: device('D-1'), sample: [] }] } });
    const hidden = await answered({ hideStableId: 'D-1' });
    for (const result of [denied, missing, empty, hidden]) {
      expect(result.response.statusCode).toBe(404);
      expect(withoutTrace(result.response.body)).toBe(withoutTrace(denied.response.body));
    }
    expect(readsOf(missing.executor, AGGREGATE_SUMMARY_ID)).toHaveLength(0);
  });

  it('masks the titles of the ends and leaves the sampled values as they are, since no relationship property is personal data', async () => {
    const mapping = mappingOf({ entities: piiEntities });
    const run = await started({ mapping, sample: { status: 'rows', rows: [sampleRow(2, { displayName: 'Ana Silva' })] } });
    const masked = aggregateEdgeDetailSchema.parse((await get(run.app, urlOf(REF, '?mask=true'))).json());
    const plain = aggregateEdgeDetailSchema.parse((await get(run.app, urlOf(REF))).json());
    expect(masked.from.title).not.toContain('Ana');
    expect(plain.from.title).toContain('Ana');
    expect(masked.sample.rows).toEqual(plain.sample.rows);
  });

  it('shows no observed range and the source order for a row that maps no observed time', async () => {
    const mapping = mappingOf({}, { type: 'USES_TOOL', from: 'maker', to: 'tool', filterable: ['remark'] });
    const { response } = await answered({ mapping, sample: { status: 'rows', rows: [{ a: account('A-1'), b: device('D-1'), sample: [{ p0: 'web' }] }] }, summary: { status: 'rows', rows: [{ members: 1, first: null, last: null }] } });
    const body = aggregateEdgeDetailSchema.parse(response.json());
    expect(body.sample.order).toBe('source-order');
    expect(body.observedFirst).toBeUndefined();
    expect(body.sample.rows[0]).toEqual({ properties: [{ key: 'remark', value: 'web', dataClass: 'text', masked: false }] });
  });

  it('reads a type that has a stable_id only for the relationships with no usable ID and flags the answer', async () => {
    const mapping = mappingOf({}, { ...AGGREGATE_ROW, stable_id: 'useId' });
    const run = await answered({ mapping });
    expect(readsOf(run.executor, AGGREGATE_SAMPLE_ID)[0]?.cypher).toContain('WHERE NOT ((r.`useId` IS :: STRING NOT NULL');
    expect(readsOf(run.executor, AGGREGATE_SUMMARY_ID)[0]?.cypher).toContain('WHERE NOT ((r.`useId` IS :: STRING NOT NULL');
    expect(aggregateEdgeDetailSchema.parse(run.response.json()).qualityFlags).toContain('no-stable-id');
    const plain = await answered();
    expect(aggregateEdgeDetailSchema.parse(plain.response.json()).qualityFlags).not.toContain('no-stable-id');
  });

  it('notes mixed kinds of observed time when the summary read found them', async () => {
    const { response } = await answered({ summary: { status: 'rows', rows: [{ members: 3, first: { $type: 'localDateTime', value: '2026-01-01T10:00:00' }, last: time(28) }] } });
    expect(aggregateEdgeDetailSchema.parse(response.json()).qualityFlags).toContain('mixed-time-kinds');
  });
});

describe('the count of an aggregate that cannot be read in time', () => {
  it('answers 200 with an unknown count and the sample, no range and no more, when the summary read times out', async () => {
    const { response } = await answered({ summary: { status: 'timeout' } });
    expect(response.statusCode).toBe(200);
    const body = aggregateEdgeDetailSchema.parse(response.json());
    expect(body.members).toEqual({ quality: 'unknown', scope: 'aggregate:members' });
    expect(body.sample.rows).toHaveLength(3);
    expect(body.sample.more).toBeUndefined();
    expect(body.observedFirst).toBeUndefined();
    expect(body.warnings).toContain(COUNT_TIMED_OUT_WARNING);
  });

  it('answers 200 with an unknown count and its own warning when the summary read is refused as busy', async () => {
    const { response } = await answered({ summaryError: new AppError('SOURCE_BUSY') });
    expect(response.statusCode).toBe(200);
    const body = aggregateEdgeDetailSchema.parse(response.json());
    expect(body.members.quality).toBe('unknown');
    expect(body.warnings).toContain(COUNT_BUSY_WARNING);
  });

  it('answers an unknown count, never a 500, when the summary count is lower than the rows the sample showed', async () => {
    const { response } = await answered({ sample: { status: 'rows', rows: [sampleRow(5)] }, summary: { status: 'rows', rows: [summaryRow(3)] } });
    expect(response.statusCode).toBe(200);
    const body = aggregateEdgeDetailSchema.parse(response.json());
    expect(body.members.quality).toBe('unknown');
    expect(body.warnings).toContain(COUNT_CHANGED_WARNING);
  });

  it('fails the whole answer when the sample read times out, and when the summary read fails for another reason', async () => {
    const sample = await answered({ sample: { status: 'timeout' } });
    expect(sample.response.statusCode).toBe(504);
    expect(sample.response.json()).toMatchObject({ error: { code: 'QUERY_TIMEOUT' } });
    const summary = await answered({ summary: { status: 'unavailable', reason: 'database' } });
    expect(summary.response.statusCode).toBe(503);
    expect(summary.response.json()).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE' } });
  });
});
