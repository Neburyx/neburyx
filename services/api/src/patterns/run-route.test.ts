import { rmSync } from 'node:fs';
import { patternRunResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { DERIVED_RULE } from '../testing/derived-fixtures.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, noMatchRow, oneStepRow, patternMappingOf } from '../testing/pattern-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

interface Options {
  readonly mapping?: ReturnType<typeof patternMappingOf>;
  readonly rows?: readonly Record<string, unknown>[];
  readonly answer?: (call: ExecuteCall) => Promise<ExecuteOutcome>;
  readonly deny?: boolean;
  readonly authorize?: () => boolean;
  readonly policyVersion?: () => string;
}

async function started(options: Options = {}) {
  const mapping = options.mapping ?? patternMappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const base = options.answer ?? ((call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve({ status: 'rows', rows: call.templateId === 'pattern-count' ? [{ matches: 1, bounded: false, stopListed: false, supernodes: 0 }] : (options.rows ?? []) }));
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), base));
  const defaults = communitySeams();
  const policy: Seams['policy'] = options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : options.authorize === undefined ? defaults.policy : { authorizeSource: () => Promise.resolve(options.authorize?.() === true ? { allowed: true } : { allowed: false, reason: 'withdrawn' }) };
  const seams = { ...defaults, policy };
  const parts = testSourceGate(mapping, { executor, seams: { policy, coordinator: defaults.coordinator, audit: defaults.audit } });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams, ...(options.policyVersion === undefined ? {} : { policyVersion: options.policyVersion }), templateRunClock: () => new Date('2026-03-10T12:00:00.000Z') });
  return { app, executor };
}

/** An answer that serves the probe's count too, so the test only scripts the run. */
const withCount = (answer: (call: ExecuteCall) => Promise<ExecuteOutcome>) => (call: ExecuteCall): Promise<ExecuteOutcome> => (call.templateId === 'pattern-count' ? Promise.resolve({ status: 'rows', rows: [{ matches: 1, bounded: false, stopListed: false, supernodes: 0 }] }) : answer(call));

type Started = Awaited<ReturnType<typeof started>>;
const KEY = 'a-key-of-sixteen-characters';
const post = (app: Started['app'], body: unknown, key: string | null = KEY, url = '/v1/patterns/run') => app.inject({ method: 'POST', url, payload: body as object, headers: key === null ? {} : { 'idempotency-key': key } });
const step = (over: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...over });
const request = (over: Record<string, unknown> = {}) => ({ sourceId: 'demo', definition: { anchorType: 'maker', steps: [step()] }, anchor: { entityType: 'maker', stableId: 'W-1' }, ...over });
const reads = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === 'pattern');
const codeOf = (response: { json(): unknown }): unknown => (response.json() as { error?: { code?: unknown } }).error?.code;

describe('POST /v1/patterns/run', () => {
  it('answers the matches with the path of each, the count with its scope, the nodes and the notices, parsed by the contract', async () => {
    const { app, executor } = await started({ rows: [oneStepRow('W-1', 'W-2'), oneStepRow('W-1', 'W-3')] });
    const response = await post(app, request());
    expect(response.statusCode).toBe(200);
    const body = patternRunResponseSchema.parse(response.json());
    if (body.status !== 'ok') throw new Error('not ok');
    expect(body.count).toEqual({ value: 2, quality: 'exact', scope: 'template:pattern' });
    expect(body.matches.map((entry) => entry.match.stableId)).toEqual(['W-2', 'W-3']);
    expect(body.matches[0]?.relationships[0]).toMatchObject({ relationshipType: 'LINKS', stableId: 'W-1>W-2' });
    expect(reads(executor)).toHaveLength(1);
    await app.close();
  });

  it('reads the run through the gate in a read call with the values as parameters and no value in the statement', async () => {
    const { app, executor } = await started({ rows: [noMatchRow('W-1')] });
    await post(app, request({ definition: { anchorType: 'maker', steps: [step({ conditions: [{ on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'north-zz' } }], window: { days: 3 } })] } }));
    const [call] = reads(executor);
    expect(call).toMatchObject({ accessMode: 'READ' });
    expect(call?.cypher).not.toContain('north-zz');
    expect(call?.cypher).not.toContain('W-1');
    expect(JSON.stringify(call?.parameters)).toContain('north-zz');
    await app.close();
  });

  it.each([
    ['a body that is not the envelope', { sourceId: 'demo' }],
    ['an extra key', { ...request(), params: {} }],
    ['an anchor of another type than the definition starts from', request({ anchor: { entityType: 'tool', stableId: 'T-1' } })],
    ['a definition with a problem', request({ definition: { anchorType: 'maker', steps: [step({ arrivesAt: 'nothing' })] } })],
    ['five steps', request({ definition: { anchorType: 'maker', steps: Array.from({ length: 5 }, () => step()) } })],
  ])('refuses %s with INVALID_REQUEST and reads nothing', async (_name, body) => {
    const { app, executor } = await started();
    const response = await post(app, body);
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    expect(reads(executor)).toHaveLength(0);
    await app.close();
  });

  it('refuses a query string, and refuses more steps than the source allows with the cap', async () => {
    const { app, executor } = await started({ mapping: patternMappingOf({ max_hops: 2 }) });
    expect((await post(app, request(), KEY, '/v1/patterns/run?x=1')).statusCode).toBe(400);
    const three = await post(app, request({ definition: { anchorType: 'maker', steps: [step(), step(), step()] } }));
    expect({ status: three.statusCode, code: codeOf(three) }).toEqual({ status: 422, code: 'QUERY_BUDGET_EXCEEDED' });
    expect((three.json() as { error: { details?: unknown } }).error.details).toEqual({ maxHops: 2 });
    expect(reads(executor)).toHaveLength(0);
    await app.close();
  });

  it('answers a page above max_page with the maximum, and reads nothing', async () => {
    const { app, executor } = await started({ mapping: patternMappingOf({ max_page: 10 }) });
    const response = await post(app, request({ limit: 11 }));
    expect(codeOf(response)).toBe('QUERY_BUDGET_EXCEEDED');
    expect((response.json() as { error: { details?: unknown } }).error.details).toEqual({ maxPage: 10 });
    expect(reads(executor)).toHaveLength(0);
    await app.close();
  });

  it('answers NOT_FOUND for an unknown source and for one the person may not read, the same way, with no name in the body', async () => {
    const missing = await started();
    const none = await post(missing.app, request({ sourceId: 'nowhere-zz' }));
    const denied = await started({ deny: true });
    const refused = await post(denied.app, request());
    expect({ a: none.statusCode, b: codeOf(none), c: refused.statusCode, d: codeOf(refused) }).toEqual({ a: 404, b: 'NOT_FOUND', c: 404, d: 'NOT_FOUND' });
    expect(none.body).not.toContain('nowhere-zz');
    expect(reads(denied.executor)).toHaveLength(0);
    await missing.app.close();
    await denied.app.close();
  });

  it('answers NOT_FOUND for an anchor that is not found', async () => {
    const { app } = await started({ rows: [] });
    expect(codeOf(await post(app, request()))).toBe('NOT_FOUND');
    await app.close();
  });

  it('refuses a condition on a personal-data property while masking is asked, and serves it otherwise', async () => {
    const entities = PATTERN_ENTITIES.map((entity) => (entity.type === 'maker' ? { ...entity, pii: [{ property: 'region', class: 'text' }] } : entity));
    const mapping = linkedMappingOf({ entities, relationships: PATTERN_RELATIONSHIPS, derived: [DERIVED_RULE], patterns: [] });
    const definition = { anchorType: 'maker', steps: [step({ conditions: [{ on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'x' } }] })] };
    const { app, executor } = await started({ mapping, rows: [noMatchRow('W-1')] });
    expect(codeOf(await post(app, request({ definition, mask: true }), 'masked-key-of-sixteen-1'))).toBe('INVALID_REQUEST');
    expect(reads(executor)).toHaveLength(0);
    expect((await post(app, request({ definition, mask: false }), 'masked-key-of-sixteen-2')).statusCode).toBe(200);
    await app.close();
  });

  it('masks the personal properties of the nodes when mask is asked, and shows them when it is not', async () => {
    const entities = PATTERN_ENTITIES.map((entity) => (entity.type === 'maker' ? { ...entity, pii: [{ property: 'ownerName', class: 'name' }] } : entity));
    const mapping = linkedMappingOf({ entities, relationships: PATTERN_RELATIONSHIPS, derived: [DERIVED_RULE], patterns: [] });
    const row = oneStepRow('W-1', 'W-2');
    const named = { ...row, x: { ...row.x, properties: { ...row.x.properties, ownerName: 'Secret Owner' } } };
    const { app } = await started({ mapping, rows: [named] });
    expect(JSON.stringify((await post(app, request(), 'mask-key-of-sixteen-open')).json())).toContain('Secret Owner');
    const masked = await post(app, request({ mask: true }), 'mask-key-of-sixteen-mask');
    expect(masked.statusCode).toBe(200);
    expect(JSON.stringify(masked.json())).not.toContain('Secret Owner');
    await app.close();
  });

  it('reads a first page of 25 for a continue', async () => {
    const { app, executor } = await started({ rows: [oneStepRow('W-1', 'W-2')] });
    expect((await post(app, request({ continue: true, limit: 40 }))).statusCode).toBe(200);
    expect(reads(executor)[0]?.parameters['limit']).toBe(25);
    await app.close();
  });
});

describe('an idempotent pattern run', () => {
  it.each([['no key', null], ['a key that is too short', 'short'], ['a key with a character that is not allowed', 'a key with spaces in it!']])('is refused with INVALID_REQUEST for %s', async (_name, key) => {
    const { app, executor } = await started({ rows: [oneStepRow('W-1', 'W-2')] });
    const response = await post(app, request(), key);
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    expect(reads(executor)).toHaveLength(0);
    await app.close();
  });

  it('answers the first answer again for the same key and the same request, with the replay header, and reads once', async () => {
    const { app, executor } = await started({ rows: [oneStepRow('W-1', 'W-2')] });
    const first = await post(app, request());
    const second = await post(app, request());
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(reads(executor)).toHaveLength(1);
    await app.close();
  });

  it('answers CONFLICT for the same key with another request, and for a repeat while the first call is still running', async () => {
    const { app } = await started({ rows: [oneStepRow('W-1', 'W-2')] });
    await post(app, request());
    const other = await post(app, request({ limit: 5 }));
    expect({ status: other.statusCode, code: codeOf(other) }).toEqual({ status: 409, code: 'CONFLICT' });
    await app.close();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = await started({ answer: withCount(async () => (await held, { status: 'rows' as const, rows: [oneStepRow('W-1', 'W-2')] })) });
    const first = post(slow.app, request(), 'slow-key-of-sixteen-chars');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const repeat = await post(slow.app, request(), 'slow-key-of-sixteen-chars');
    expect({ status: repeat.statusCode, code: codeOf(repeat) }).toEqual({ status: 409, code: 'CONFLICT' });
    release();
    expect((await first).statusCode).toBe(200);
    await slow.app.close();
  });

  it('stores a refusal and answers it again with the replay header, without a second read', async () => {
    const { app, executor } = await started({ mapping: patternMappingOf({ max_hops: 1 }) });
    const body = request({ definition: { anchorType: 'maker', steps: [step(), step()] } });
    const first = await post(app, body);
    const second = await post(app, body);
    expect({ status: first.statusCode, code: codeOf(first) }).toEqual({ status: 422, code: 'QUERY_BUDGET_EXCEEDED' });
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(reads(executor)).toHaveLength(0);
    await app.close();
  });

  it('does not keep a first call that ended in a server error, so a retry runs again', async () => {
    let calls = 0;
    const { app, executor } = await started({ answer: withCount(() => Promise.resolve(++calls === 1 ? { status: 'unavailable' as const, reason: 'unreachable' as const } : { status: 'rows' as const, rows: [oneStepRow('W-1', 'W-2')] })) });
    expect((await post(app, request())).statusCode).toBeGreaterThanOrEqual(500);
    expect((await post(app, request())).statusCode).toBe(200);
    expect(reads(executor).length).toBe(2);
    await app.close();
  });

  it('answers ACCESS_DENIED for a replay after the access to the source was withdrawn, and CONFLICT after the policy changed', async () => {
    let allowed = true;
    const withdrawn = await started({ rows: [oneStepRow('W-1', 'W-2')], authorize: () => allowed });
    expect((await post(withdrawn.app, request())).statusCode).toBe(200);
    allowed = false;
    const replay = await post(withdrawn.app, request());
    expect({ status: replay.statusCode, code: codeOf(replay) }).toEqual({ status: 403, code: 'ACCESS_DENIED' });
    await withdrawn.app.close();
    let version = 'one';
    const changed = await started({ rows: [oneStepRow('W-1', 'W-2')], policyVersion: () => version });
    expect((await post(changed.app, request())).statusCode).toBe(200);
    version = 'two';
    const stale = await post(changed.app, request());
    expect({ status: stale.statusCode, code: codeOf(stale) }).toEqual({ status: 409, code: 'CONFLICT' });
    expect(reads(changed.executor)).toHaveLength(1);
    await changed.app.close();
  });
});

describe('a pattern run whose estimate cannot be read', () => {
  it.each([
    ['times out', { status: 'timeout' as const }, 504],
    ['finds the source unavailable', { status: 'unavailable' as const, reason: 'unreachable' as const }, 503],
  ])('answers the error of the failure when the estimate %s, and sends no run', async (_name, outcome, status) => {
    const { app, executor } = await started({ answer: (call) => Promise.resolve(call.templateId === 'pattern-count' ? outcome : { status: 'rows' as const, rows: [oneStepRow('W-1', 'W-2')] }) });
    expect((await post(app, request())).statusCode).toBe(status);
    expect(reads(executor)).toHaveLength(0);
    await app.close();
  });
});
