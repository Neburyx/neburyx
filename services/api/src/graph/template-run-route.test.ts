import { rmSync } from 'node:fs';
import { HEAVY_CONTINUE_LIMIT, templateRunOkSchema, templateRunResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { redactItems } from '../gate/redact/index.js';
import { SHARED_ATTRIBUTE_ID } from '../gate/templates/shared-attribute.js';
import { SHARED_ATTRIBUTE_COUNT_ID } from '../gate/templates/shared-attribute-count.js';
import { createLogger } from '../logger.js';
import type { TemplateProbe } from './template-probes.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { hidingRedact } from '../testing/derived-fixtures.js';
import { SHARED_PRESET, noMatchRow, sharedMappingOf, sharedRow } from '../testing/shared-attribute-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

interface Options {
  readonly rows?: readonly Record<string, unknown>[];
  readonly outcome?: ExecuteOutcome;
  readonly deny?: boolean;
  readonly mapping?: ReturnType<typeof sharedMappingOf>;
  readonly policyVersion?: (sourceId: string) => string;
  readonly authorize?: () => boolean;
  readonly answer?: (call: ExecuteCall) => Promise<ExecuteOutcome>;
  readonly now?: () => Date;
  readonly hide?: string;
  /** The matches the estimate reads before the run (the probe's one row); no more than the threshold lets the run start. */
  readonly probeMatches?: number;
  readonly probeRow?: Record<string, unknown>;
  readonly probes?: ReadonlyMap<string, TemplateProbe>;
}

async function started(options: Options = {}) {
  const mapping = options.mapping ?? sharedMappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const probe: ExecuteOutcome = { status: 'rows', rows: [options.probeRow ?? { matches: options.probeMatches ?? 0, anchorBounded: false, skipped: false }] };
  const base = options.answer ?? ((_call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve(options.outcome ?? { status: 'rows', rows: options.rows ?? [] }));
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => (call.templateId === SHARED_ATTRIBUTE_COUNT_ID && options.answer === undefined && options.outcome === undefined ? Promise.resolve(probe) : base(call));
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : options.authorize === undefined ? defaults.policy : { authorizeSource: () => Promise.resolve(options.authorize?.() === true ? { allowed: true } : { allowed: false, reason: 'no' }) },
    coordinator: defaults.coordinator,
    audit: { record: (event) => (events.push(event), Promise.resolve()) },
  };
  const parts = testSourceGate(mapping, { executor, seams, ...(options.hide === undefined ? {} : { redact: hidingRedact(options.hide, redactItems) }) });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams, ...(options.policyVersion === undefined ? {} : { policyVersion: options.policyVersion }), ...(options.probes === undefined ? {} : { templateProbes: options.probes }), ...(options.now === undefined ? {} : { templateRunClock: options.now }) });
  return { app, executor, events };
}

type Started = Awaited<ReturnType<typeof started>>;
const KEY = 'a-key-of-sixteen-characters';
const post = (app: Started['app'], id: string, body: object, key: string | null = KEY) => app.inject({ method: 'POST', url: `/v1/templates/${id}/run`, payload: body, headers: key === null ? {} : { 'idempotency-key': key } });
const preset = (params: Record<string, unknown> = {}) => ({ sourceId: 'demo', params: { ref: { entityType: 'maker', stableId: 'A-1' }, ...params } });
const runs = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === SHARED_ATTRIBUTE_ID);

describe('POST /v1/templates/:id/run for a preset of the shared-attribute template', () => {
  it('answers the other entities, the shared nodes, the evidence and an exact count when the read was not cut', async () => {
    const { app, executor } = await started({ rows: [sharedRow({ match: 'O-1', tools: ['D-1', 'D-2'] }), sharedRow({ match: 'O-2' })] });
    const response = await post(app, SHARED_PRESET.id, preset());
    expect(response.statusCode).toBe(200);
    const body = templateRunOkSchema.parse(response.json());
    expect(body).toMatchObject({ status: 'ok', templateId: 'shared-attribute', templateVersion: '1', presetId: 'shared-tools', count: { value: 2, quality: 'exact' } });
    expect(body.matchIds.map((ref) => ref.stableId)).toEqual(['O-1', 'O-2']);
    expect(body.matchIds.map((ref) => ref.stableId)).not.toContain('A-1');
    expect(body.nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'D-1', 'D-2', 'O-1', 'O-2']);
    expect(body.edges.filter((edge) => edge.semantics === 'stored')).toHaveLength(5);
    expect(runs(executor)).toHaveLength(1);
    expect(runs(executor)[0]?.parameters).toMatchObject({ stableId: 'A-1', limit: 25, minShared: 1 });
    await app.close();
  });

  it('answers a lower bound of the limit when the read found one match more, and never an exact count after a cut', async () => {
    const rows = Array.from({ length: 4 }, (_unused, index) => sharedRow({ match: `O-${index + 1}` }));
    const { app, executor } = await started({ rows });
    const body = templateRunOkSchema.parse((await post(app, SHARED_PRESET.id, preset({ limit: 3 }))).json());
    expect(body.count).toMatchObject({ value: 3, quality: 'lowerBound' });
    expect(body.matchIds).toHaveLength(3);
    expect(runs(executor)[0]?.parameters).toMatchObject({ limit: 3 });
    await app.close();
  });

  it('answers an exact zero for an anchor that exists and has no match, and NOT_FOUND for one that does not', async () => {
    const found = await started({ rows: [noMatchRow()] });
    expect(templateRunOkSchema.parse((await post(found.app, SHARED_PRESET.id, preset())).json())).toMatchObject({ matchIds: [], count: { value: 0, quality: 'exact' } });
    await found.app.close();
    const missing = await started({ rows: [] });
    const response = await post(missing.app, SHARED_PRESET.id, preset());
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await missing.app.close();
  });

  it('answers NOT_FOUND for an entity type the source does not map, before anything is read', async () => {
    const { app, executor } = await started();
    const response = await post(app, SHARED_PRESET.id, { sourceId: 'demo', params: { ref: { entityType: 'nothing', stableId: 'A-1' } } });
    expect(response.statusCode).toBe(404);
    expect(runs(executor)).toHaveLength(0);
    await app.close();
  });

  it('says that a stop-listed attribute was skipped, and that a mapping with no rule over the types has no stop list', async () => {
    const skipped = await started({ rows: [sharedRow({ match: 'O-1', skipped: true })] });
    expect(templateRunOkSchema.parse((await post(skipped.app, SHARED_PRESET.id, preset())).json()).notices).toEqual([{ code: 'stopListSkipped' }]);
    await skipped.app.close();
    const none = await started({ rows: [sharedRow({ match: 'O-1' })], mapping: sharedMappingOf({ derived: [] }) });
    expect(templateRunOkSchema.parse((await post(none.app, SHARED_PRESET.id, preset())).json()).notices).toEqual([{ code: 'noStopList' }]);
    await none.app.close();
  });

  it('answers a lower bound with the notice that the read was bounded when a bound of the read was hit', async () => {
    const { app } = await started({ rows: [sharedRow({ match: 'O-1', bounded: true, evidenceCut: true })] });
    const body = templateRunOkSchema.parse((await post(app, SHARED_PRESET.id, preset())).json());
    expect(body.count).toMatchObject({ value: 1, quality: 'lowerBound' });
    expect(body.notices).toEqual([{ code: 'readBounded' }, { code: 'evidenceCut' }]);
    await app.close();
  });
});

const full = (params: Record<string, unknown> = {}) => preset({ attributeType: 'tool', via: 'USES_TOOL', ...params });
const codeOf = (response: { json(): unknown }): unknown => (response.json() as { error?: { code?: unknown } }).error?.code;

describe('the shared-attribute template by its own ID, and what the route refuses', () => {
  it('runs with the attribute type and the relationship type given, and answers no preset', async () => {
    const { app } = await started({ rows: [sharedRow({ match: 'O-1' })] });
    const body = templateRunOkSchema.parse((await post(app, 'shared-attribute', full())).json());
    expect(body.templateId).toBe('shared-attribute');
    expect(body).not.toHaveProperty('presetId');
    expect(body.matchIds.map((ref) => ref.stableId)).toEqual(['O-1']);
    await app.close();
  });

  it.each([
    ['a preset that also receives the attribute type', SHARED_PRESET.id, preset({ attributeType: 'tool' }), 400, 'INVALID_REQUEST'],
    ['a preset that also receives the relationship type', SHARED_PRESET.id, preset({ via: 'USES_TOOL' }), 400, 'INVALID_REQUEST'],
    ['a preset and an entity type other than its anchor', SHARED_PRESET.id, { sourceId: 'demo', params: { ref: { entityType: 'tool', stableId: 'D-1' } } }, 400, 'INVALID_REQUEST'],
    ['the template ID with no attribute type', 'shared-attribute', preset({ via: 'USES_TOOL' }), 400, 'INVALID_REQUEST'],
    ['an ID that is neither a preset of the source nor a built-in template', 'nothing', preset(), 404, 'NOT_FOUND'],
    ['an attribute type the mapping does not have', 'shared-attribute', full({ attributeType: 'nothing' }), 400, 'INVALID_REQUEST'],
    ['a relationship type that does not join the types in the mapped direction', 'shared-attribute', { sourceId: 'demo', params: { ref: { entityType: 'tool', stableId: 'D-1' }, attributeType: 'maker', via: 'USES_TOOL' } }, 400, 'INVALID_REQUEST'],
    ['a list of attribute types, which stays unsupported', 'shared-attribute', full({ attributeType: ['tool', 'maker'] }), 400, 'INVALID_REQUEST'],
    ['a parameter the template does not name', 'shared-attribute', full({ cypher: 'MATCH (n) RETURN n' }), 400, 'INVALID_REQUEST'],
    ['a limit below one', SHARED_PRESET.id, preset({ limit: 0 }), 400, 'INVALID_REQUEST'],
    ['a limit above the max_page of the source', SHARED_PRESET.id, preset({ limit: 51 }), 422, 'QUERY_BUDGET_EXCEEDED'],
  ])('answers %s with %s', async (_name, id, request, status, code) => {
    const { app, executor } = await started({ rows: [sharedRow({ match: 'O-1' })] });
    const response = await post(app, id, request);
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status, code });
    expect(runs(executor)).toHaveLength(0);
    await app.close();
  });

  it('uses the default page of the source when no limit is given', async () => {
    const { app, executor } = await started({ rows: [sharedRow({ match: 'O-1' })], mapping: sharedMappingOf({ budgets: { default_page: 12 } }) });
    expect((await post(app, SHARED_PRESET.id, preset())).statusCode).toBe(200);
    expect(runs(executor)[0]?.parameters).toMatchObject({ limit: 12 });
    await app.close();
  });

  it('masks the personal properties of the nodes when mask is asked, and refuses a masked run whose stop-list property is personal', async () => {
    const entities = [{ type: 'maker', label: 'Maker', stable_id: 'makerId', pii: [{ property: 'ownerName', class: 'name' }] }, { type: 'tool', label: 'Tool', stable_id: 'toolId' }];
    const row = sharedRow({ match: 'O-1' });
    const named = { ...row, b: { ...row.b, properties: { ...row.b.properties, ownerName: 'Secret Owner' } } };
    const { app } = await started({ rows: [named], mapping: sharedMappingOf({ entities }) });
    const open = JSON.stringify((await post(app, SHARED_PRESET.id, preset())).json());
    expect(open).toContain('Secret Owner');
    const masked = await post(app, SHARED_PRESET.id, { ...preset(), mask: true }, 'another-key-of-sixteen');
    expect(masked.statusCode).toBe(200);
    expect(JSON.stringify(masked.json())).not.toContain('Secret Owner');
    await app.close();
    const personal = [{ type: 'maker', label: 'Maker', stable_id: 'makerId' }, { type: 'tool', label: 'Tool', stable_id: 'toolId', pii: [{ property: 'isCommon', class: 'text' }] }];
    const refused = await started({ mapping: sharedMappingOf({ entities: personal }) });
    expect(await post(refused.app, SHARED_PRESET.id, { ...preset(), mask: true })).toMatchObject({ statusCode: 400 });
    expect(runs(refused.executor)).toHaveLength(0);
    await refused.app.close();
  });

  it('answers NOT_FOUND for a source the person may not read, audits the denial, and audits a run and a gate refusal', async () => {
    const denied = await started({ deny: true });
    const response = await post(denied.app, SHARED_PRESET.id, preset());
    expect(response.statusCode).toBe(404);
    expect(denied.events).toMatchObject([{ action: 'entity.shared_attribute_run', result: 'denied' }]);
    await denied.app.close();
    const ok = await started({ rows: [sharedRow({ match: 'O-1' })] });
    await post(ok.app, SHARED_PRESET.id, preset());
    await post(ok.app, SHARED_PRESET.id, preset({ limit: 51 }), 'a-second-key-of-sixteen');
    await post(ok.app, SHARED_PRESET.id, { sourceId: 'demo', params: { ref: { entityType: 'maker', stableId: 'A-1' }, via: 'x' } }, 'a-third-key-of-sixteen');
    expect(ok.events.filter((event) => event.action === 'entity.shared_attribute_run').map((event) => event.result)).toEqual(['success', 'refused']);
    await ok.app.close();
  });
});

describe('an idempotent run', () => {
  it.each([['no key', null], ['a key that is too short', 'short'], ['a key with a character that is not allowed', 'a key with spaces in it!']])('is refused with INVALID_REQUEST for %s', async (_name, key) => {
    const { app, executor } = await started({ rows: [sharedRow({ match: 'O-1' })] });
    const response = await post(app, SHARED_PRESET.id, preset(), key);
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    expect(runs(executor)).toHaveLength(0);
    await app.close();
  });

  it('answers the first answer again for the same key and the same request, with the replay header, and reads once', async () => {
    const { app, executor } = await started({ rows: [sharedRow({ match: 'O-1' })] });
    const first = await post(app, SHARED_PRESET.id, preset());
    const second = await post(app, SHARED_PRESET.id, preset());
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(runs(executor)).toHaveLength(1);
    await app.close();
  });

  it('answers CONFLICT for the same key with another request', async () => {
    const { app } = await started({ rows: [sharedRow({ match: 'O-1' })] });
    await post(app, SHARED_PRESET.id, preset());
    const other = await post(app, SHARED_PRESET.id, preset({ limit: 5 }));
    expect({ status: other.statusCode, code: codeOf(other) }).toEqual({ status: 409, code: 'CONFLICT' });
    await app.close();
  });

  it('answers CONFLICT for a repeat while the first call is still running', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { app } = await started({ answer: async (call) => (await held, call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? { status: 'rows' as const, rows: [{ matches: 0, anchorBounded: false, skipped: false }] } : { status: 'rows' as const, rows: [sharedRow({ match: 'O-1' })] }) });
    const first = post(app, SHARED_PRESET.id, preset());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const repeat = await post(app, SHARED_PRESET.id, preset());
    expect({ status: repeat.statusCode, code: codeOf(repeat) }).toEqual({ status: 409, code: 'CONFLICT' });
    release();
    expect((await first).statusCode).toBe(200);
    await app.close();
  });

  it('answers ACCESS_DENIED for a replay after the access to the source was withdrawn, and CONFLICT after the policy changed', async () => {
    let allowed = true;
    const withdrawn = await started({ rows: [sharedRow({ match: 'O-1' })], authorize: () => allowed });
    expect((await post(withdrawn.app, SHARED_PRESET.id, preset())).statusCode).toBe(200);
    allowed = false;
    const replay = await post(withdrawn.app, SHARED_PRESET.id, preset());
    expect({ status: replay.statusCode, code: codeOf(replay) }).toEqual({ status: 403, code: 'ACCESS_DENIED' });
    await withdrawn.app.close();
    let version = 'one';
    const changed = await started({ rows: [sharedRow({ match: 'O-1' })], policyVersion: () => version });
    expect((await post(changed.app, SHARED_PRESET.id, preset())).statusCode).toBe(200);
    version = 'two';
    const stale = await post(changed.app, SHARED_PRESET.id, preset());
    expect({ status: stale.statusCode, code: codeOf(stale) }).toEqual({ status: 409, code: 'CONFLICT' });
    expect(runs(changed.executor)).toHaveLength(1);
    await changed.app.close();
  });

  it('does not keep a first call that ended in a server error, so a retry runs again', async () => {
    let calls = 0;
    const { app, executor } = await started({ answer: (call) => Promise.resolve(call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? (++calls === 1 ? { status: 'unavailable' as const, reason: 'unreachable' as const } : { status: 'rows' as const, rows: [{ matches: 0, anchorBounded: false, skipped: false }] }) : { status: 'rows' as const, rows: [sharedRow({ match: 'O-1' })] }) });
    const first = await post(app, SHARED_PRESET.id, preset());
    expect(first.statusCode).toBeGreaterThanOrEqual(500);
    const retry = await post(app, SHARED_PRESET.id, preset());
    expect(retry.statusCode).toBe(200);
    expect(executor.calls.filter((call) => call.templateId === SHARED_ATTRIBUTE_COUNT_ID).length).toBeGreaterThanOrEqual(2);
    expect(runs(executor).length).toBe(1);
    await app.close();
  });
});

describe('a window and a minimum of shared attribute nodes', () => {
  const NOW = new Date('2026-03-15T12:00:00.000Z');

  it('gives the gate the instants of a window of days counted back from the clock, and of a range of dates through the day of its end', async () => {
    const days = await started({ rows: [sharedRow({ match: 'O-1' })], now: () => NOW });
    expect((await post(days.app, SHARED_PRESET.id, preset({ window: { days: 14 } }))).statusCode).toBe(200);
    expect(runs(days.executor)[0]?.parameters).toMatchObject({ windowFrom: '2026-03-01T12:00:00.000Z', windowTo: '2026-03-15T12:00:00.000Z' });
    await days.app.close();
    const range = await started({ rows: [sharedRow({ match: 'O-1' })], now: () => NOW });
    await post(range.app, SHARED_PRESET.id, preset({ window: { from: '2026-01-01', to: '2026-01-31' } }));
    expect(runs(range.executor)[0]?.parameters).toMatchObject({ windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' });
    await range.app.close();
  });

  it('says relationships with no usable date are outside a window, only when a window is given', async () => {
    const { app } = await started({ rows: [sharedRow({ match: 'O-1' })], mapping: sharedMappingOf({ derived: [] }) });
    expect(templateRunOkSchema.parse((await post(app, SHARED_PRESET.id, preset({ window: { days: 7 } }), 'window-key-of-sixteen')).json()).notices).toEqual([{ code: 'noStopList' }, { code: 'undatedExcluded' }]);
    expect(templateRunOkSchema.parse((await post(app, SHARED_PRESET.id, preset(), 'no-window-key-of-sixteen')).json()).notices).toEqual([{ code: 'noStopList' }]);
    await app.close();
  });

  it('refuses a window on a relationship type with no mapped time property, and reads nothing', async () => {
    const { app, executor } = await started({ mapping: sharedMappingOf({ relationships: [{ type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' }] }) });
    const response = await post(app, SHARED_PRESET.id, preset({ window: { days: 7 } }));
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    expect(runs(executor)).toHaveLength(0);
    await app.close();
  });

  it.each([[{ days: 0 }], [{ days: 3651 }], [{ from: '2026-01-31', to: '2026-01-01' }], [{ from: '2026-02-30', to: '2026-03-01' }], [{ days: 1, from: '2026-01-01', to: '2026-01-02' }], [{}]])('refuses the window %j', async (window) => {
    const { app, executor } = await started();
    expect((await post(app, SHARED_PRESET.id, preset({ window }))).statusCode).toBe(400);
    expect(runs(executor)).toHaveLength(0);
    await app.close();
  });

  it('gives the gate the minimum of shared nodes, and refuses one below one or above fifty', async () => {
    const { app, executor } = await started({ rows: [sharedRow({ match: 'O-1' })] });
    await post(app, SHARED_PRESET.id, preset({ minShared: 3 }));
    expect(runs(executor)[0]?.parameters).toMatchObject({ minShared: 3 });
    for (const [index, minShared] of [0, 51, 1.5].entries()) expect((await post(app, SHARED_PRESET.id, preset({ minShared }), `refused-key-of-sixteen-${index}`)).statusCode).toBe(400);
    await app.close();
  });
});

describe('the count of a run after the gate has hidden what the person may not see', () => {
  it('leaves a hidden match out of the matches and out of the count', async () => {
    const { app } = await started({ rows: [sharedRow({ match: 'O-1' }), sharedRow({ match: 'O-2' })], hide: 'O-1' });
    const body = templateRunOkSchema.parse((await post(app, SHARED_PRESET.id, preset())).json());
    expect(body.matchIds.map((ref) => ref.stableId)).toEqual(['O-2']);
    expect(body.count).toMatchObject({ value: 1, quality: 'exact' });
    await app.close();
  });
});

const small = (budgets: Record<string, number> = {}) => sharedMappingOf({ budgets: { heavy_op_threshold: 3, ...budgets } });
const probes = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === SHARED_ATTRIBUTE_COUNT_ID);
const runLimit = (executor: TestExecutor) => runs(executor)[0]?.parameters['limit'];

describe('a run that would match more than the threshold', () => {
  it('stops with the estimate labelled a lower bound at the threshold, the threshold and the continue size, no rows, and does not run the template', async () => {
    const { app, executor, events } = await started({ mapping: small(), probeMatches: 4, rows: [sharedRow({ match: 'O-1' })] });
    const response = await post(app, SHARED_PRESET.id, preset());
    expect(response.statusCode).toBe(200);
    const body = templateRunResponseSchema.parse(response.json());
    expect(body).toEqual({ status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', presetId: 'shared-tools', estimate: { value: 3, quality: 'lowerBound', scope: 'template:shared-attribute:estimate' }, threshold: 3, continueLimit: HEAVY_CONTINUE_LIMIT, notices: [], warnings: [] });
    expect(response.json()).not.toHaveProperty('matchIds');
    expect(response.json()).not.toHaveProperty('nodes');
    expect(probes(executor)).toHaveLength(1);
    expect(runs(executor)).toHaveLength(0);
    expect(events.filter((event) => event.action === 'entity.shared_attribute_count').map((event) => event.result)).toEqual(['success']);
    expect(events.some((event) => event.action === 'entity.shared_attribute_run')).toBe(false);
    await app.close();
  });

  it('runs as before when the matches are at most the threshold, with the estimate read once first, and when exactly the threshold', async () => {
    for (const probeMatches of [0, 2, 3]) {
      const { app, executor } = await started({ mapping: small(), probeMatches, rows: [sharedRow({ match: 'O-1' })] });
      const response = await post(app, SHARED_PRESET.id, preset());
      expect(templateRunResponseSchema.parse(response.json())).toMatchObject({ status: 'ok', count: { value: 1, quality: 'exact' } });
      expect(probes(executor)).toHaveLength(1);
      expect(runs(executor)).toHaveLength(1);
      await app.close();
    }
  });

  it('does not warn when the anchor held more attribute nodes than the cap but fewer matches than the threshold were counted, and the run carries its own notice', async () => {
    const { app } = await started({ mapping: small(), probeRow: { matches: 2, anchorBounded: true, skipped: false }, rows: [sharedRow({ match: 'O-1', bounded: true })] });
    const body = templateRunResponseSchema.parse((await post(app, SHARED_PRESET.id, preset())).json());
    expect(body).toMatchObject({ status: 'ok', count: { quality: 'lowerBound' }, notices: expect.arrayContaining([{ code: 'readBounded' }]) });
    await app.close();
  });

  it('carries only the notices of the codes it names: a skipped stop-listed node and a bounded anchor read, and a window', async () => {
    const { app } = await started({ mapping: small(), probeRow: { matches: 4, anchorBounded: true, skipped: true } });
    const body = templateRunResponseSchema.parse((await post(app, SHARED_PRESET.id, preset({ window: { days: 30 } }))).json());
    expect(body).toMatchObject({ status: 'heavy', notices: [{ code: 'stopListSkipped' }, { code: 'undatedExcluded' }, { code: 'readBounded' }] });
    await app.close();
  });

  it('is the same stop for the template by its own ID, with no preset ID in the answer', async () => {
    const { app } = await started({ mapping: small(), probeMatches: 4 });
    const body = templateRunResponseSchema.parse((await post(app, 'shared-attribute', { sourceId: 'demo', params: { ref: { entityType: 'maker', stableId: 'A-1' }, attributeType: 'tool', via: 'USES_TOOL' } })).json());
    expect(body.status).toBe('heavy');
    expect(body).not.toHaveProperty('presetId');
    await app.close();
  });

  it('cannot be asked for by the ID of the count: NOT_FOUND, and nothing is read', async () => {
    const { app, executor } = await started({ probeMatches: 4 });
    const response = await post(app, SHARED_ATTRIBUTE_COUNT_ID, { sourceId: 'demo', params: { ref: { entityType: 'maker', stableId: 'A-1' }, attributeType: 'tool', via: 'USES_TOOL' } });
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(probes(executor)).toHaveLength(0);
    await app.close();
  });
});

describe('the audit of the estimate', () => {
  it('records the count under its own action with no value of the request in the record, and the run under its own', async () => {
    const { app, events } = await started({ mapping: small(), probeMatches: 0, rows: [sharedRow({ match: 'O-1' })] });
    await post(app, SHARED_PRESET.id, preset({ window: { days: 30 }, minShared: 2 }));
    const counted = events.filter((event) => event.action === 'entity.shared_attribute_count');
    expect(counted.map((event) => event.result)).toEqual(['success']);
    expect(events.filter((event) => event.action === 'entity.shared_attribute_run').map((event) => event.result)).toEqual(['success']);
    for (const event of counted) {
      const text = JSON.stringify(event);
      for (const value of ['A-1', 'USES_TOOL', 'tool', 'maker']) expect(text).not.toContain(value);
    }
    await app.close();
  });

  it('reads the estimate before the run, in that order', async () => {
    const { app, executor } = await started({ mapping: small(), probeMatches: 0, rows: [sharedRow({ match: 'O-1' })] });
    await post(app, SHARED_PRESET.id, preset());
    const order = executor.calls.map((call) => call.templateId).filter((id) => id === SHARED_ATTRIBUTE_ID || id === SHARED_ATTRIBUTE_COUNT_ID);
    expect(order).toEqual([SHARED_ATTRIBUTE_COUNT_ID, SHARED_ATTRIBUTE_ID]);
    await app.close();
  });
});

describe('continue with the first page', () => {
  it('skips the estimate and returns a first page of 25 with the cut labelled a lower bound', async () => {
    const { app, executor } = await started({ mapping: small({ max_page: 50 }), probeMatches: 4, rows: Array.from({ length: 26 }, (_, index) => sharedRow({ match: `O-${index}` })) });
    const body = templateRunOkSchema.parse((await post(app, SHARED_PRESET.id, { ...preset(), continue: true })).json());
    expect(body.count).toMatchObject({ value: 25, quality: 'lowerBound' });
    expect(probes(executor)).toHaveLength(0);
    expect(runLimit(executor)).toBe(25);
    await app.close();
  });

  it.each([
    ['a page of 40', { limit: 40 }, {}, 25],
    ['a page of 10', { limit: 10 }, {}, 10],
    ['a source whose max_page is 10', {}, { max_page: 10 }, 10],
  ])('uses min(25, the page asked for, max_page) for %s', async (_name, params, budgets, expected) => {
    const { app, executor } = await started({ mapping: small(budgets), probeMatches: 4, rows: [sharedRow({ match: 'O-1' })] });
    expect((await post(app, SHARED_PRESET.id, { ...preset(params), continue: true })).statusCode).toBe(200);
    expect(runLimit(executor)).toBe(expected);
    await app.close();
  });

  it('answers the same size in the heavy stop, so the answer says what a continue will return', async () => {
    const { app } = await started({ mapping: small({ max_page: 10 }), probeMatches: 4 });
    expect(templateRunResponseSchema.parse((await post(app, SHARED_PRESET.id, preset({ limit: 7 }))).json())).toMatchObject({ status: 'heavy', continueLimit: 7 });
    expect(templateRunResponseSchema.parse((await post(app, SHARED_PRESET.id, preset(), 'a-second-key-of-sixteen')).json())).toMatchObject({ status: 'heavy', continueLimit: 10 });
    await app.close();
  });

  it('refuses a page above max_page with or without the flag before anything is read', async () => {
    for (const flag of [{}, { continue: true }]) {
      const { app, executor } = await started({ mapping: small({ max_page: 10 }), probeMatches: 4 });
      const response = await post(app, SHARED_PRESET.id, { ...preset({ limit: 11 }), ...flag });
      expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 422, code: 'QUERY_BUDGET_EXCEEDED' });
      expect(executor.calls.filter((call) => call.templateId === SHARED_ATTRIBUTE_ID || call.templateId === SHARED_ATTRIBUTE_COUNT_ID)).toHaveLength(0);
      await app.close();
    }
  });

  it('runs a run that is not heavy the same way with the flag', async () => {
    const { app, executor } = await started({ mapping: small(), probeMatches: 0, rows: [sharedRow({ match: 'O-1' })] });
    expect(templateRunOkSchema.parse((await post(app, SHARED_PRESET.id, { ...preset(), continue: true })).json())).toMatchObject({ status: 'ok', count: { value: 1, quality: 'exact' } });
    expect(runLimit(executor)).toBe(25);
    await app.close();
  });

  it.each([
    ['a flag that is not a boolean', { continue: 'yes' }],
    ['an extra top-level key', { continue: true, again: true }],
    ['the flag inside the parameters', { params: { ref: { entityType: 'maker', stableId: 'A-1' }, continue: true } }],
  ])('refuses %s with INVALID_REQUEST and reads nothing', async (_name, extra) => {
    const { app, executor } = await started({ probeMatches: 4 });
    const response = await post(app, SHARED_PRESET.id, { ...preset(), ...extra });
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    expect(executor.calls.filter((call) => call.templateId === SHARED_ATTRIBUTE_ID || call.templateId === SHARED_ATTRIBUTE_COUNT_ID)).toHaveLength(0);
    await app.close();
  });

  it('is a different request under the same idempotency key: CONFLICT; the same body replays the stop without reading again; a new key continues', async () => {
    const { app, executor } = await started({ mapping: small(), probeMatches: 4, rows: [sharedRow({ match: 'O-1' })] });
    const first = await post(app, SHARED_PRESET.id, preset());
    const replay = await post(app, SHARED_PRESET.id, preset());
    expect(replay.json()).toEqual(first.json());
    expect(probes(executor)).toHaveLength(1);
    const clash = await post(app, SHARED_PRESET.id, { ...preset(), continue: true });
    expect({ status: clash.statusCode, code: codeOf(clash) }).toEqual({ status: 409, code: 'CONFLICT' });
    const next = await post(app, SHARED_PRESET.id, { ...preset(), continue: true }, 'a-second-key-of-sixteen');
    expect(templateRunResponseSchema.parse(next.json()).status).toBe('ok');
    await app.close();
  });
});

describe('an estimate that is unknown or cannot be read', () => {
  it('runs a template with no probe with no warning under the page caps, not the continue size', async () => {
    const { app, executor } = await started({ mapping: small(), probes: new Map(), rows: [sharedRow({ match: 'O-1' })] });
    const body = templateRunOkSchema.parse((await post(app, SHARED_PRESET.id, preset({ limit: 40 }))).json());
    expect(body.status).toBe('ok');
    expect(probes(executor)).toHaveLength(0);
    expect(runLimit(executor)).toBe(40);
    await app.close();
  });

  it('answers SOURCE_BUSY for an estimate that cannot get a read slot, and starts no run for it', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let probesSeen = 0;
    const { app, executor } = await started({
      mapping: small({ user_concurrency: 1, queue_wait_ms: 100 }),
      answer: async (call) => (call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? (++probesSeen === 1 && (await held), { status: 'rows' as const, rows: [{ matches: 0, anchorBounded: false, skipped: false }] }) : { status: 'rows' as const, rows: [sharedRow({ match: 'O-1' })] }),
    });
    const first = post(app, SHARED_PRESET.id, preset());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await post(app, SHARED_PRESET.id, preset(), 'a-second-key-of-sixteen');
    expect({ status: second.statusCode, code: codeOf(second) }).toEqual({ status: 503, code: 'SOURCE_BUSY' });
    expect(runs(executor)).toHaveLength(0);
    release();
    expect((await first).statusCode).toBe(200);
    await app.close();
  });

  it.each([
    ['a count row with no usable number', { probeRow: { anchorBounded: false, skipped: false } }, 500, 'INTERNAL_ERROR'],
    ['an anchor that is not found', { answer: (call: ExecuteCall) => Promise.resolve(call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? { status: 'rows' as const, rows: [] } : { status: 'rows' as const, rows: [] }) }, 404, 'NOT_FOUND'],
    ['a source that is unavailable for the count', { answer: (call: ExecuteCall) => Promise.resolve(call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? { status: 'unavailable' as const, reason: 'unreachable' as const } : { status: 'rows' as const, rows: [sharedRow({ match: 'O-1' })] }) }, 503, 'SOURCE_UNAVAILABLE'],
    ['a count that runs out of time', { answer: (call: ExecuteCall) => Promise.resolve(call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? { status: 'timeout' as const } : { status: 'rows' as const, rows: [sharedRow({ match: 'O-1' })] }) }, 504, 'QUERY_TIMEOUT'],
  ])('ends the request for %s and does not start the run', async (_name, options, status, code) => {
    const { app, executor } = await started(options);
    const response = await post(app, SHARED_PRESET.id, preset());
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status, code });
    expect(runs(executor)).toHaveLength(0);
    await app.close();
  });
});
