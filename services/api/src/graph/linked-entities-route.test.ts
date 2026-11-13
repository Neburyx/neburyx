import { rmSync } from 'node:fs';
import { templateRunResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { LINKED_ENTITIES_ID } from '../gate/templates/linked-entities.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { LINKED_ENTITIES, LINKED_PRESET, linkedMappingOf, linkedRow, noLinkedRow, shop, tool } from '../testing/linked-entities-fixtures.js';
import { plainRelationship } from '../testing/normalize-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

interface Options {
  readonly rows?: readonly Record<string, unknown>[];
  readonly deny?: boolean;
  readonly mapping?: ReturnType<typeof linkedMappingOf>;
  readonly now?: () => Date;
}

async function started(options: Options = {}) {
  const mapping = options.mapping ?? linkedMappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const answer = (_call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve({ status: 'rows', rows: options.rows ?? [] });
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy,
    coordinator: defaults.coordinator,
    audit: { record: (event) => (events.push(event), Promise.resolve()) },
  };
  const parts = testSourceGate(mapping, { executor, seams });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams, ...(options.now === undefined ? {} : { templateRunClock: options.now }) });
  return { app, executor, events };
}

type Started = Awaited<ReturnType<typeof started>>;
let keys = 0;
const post = (app: Started['app'], id: string, body: object) => app.inject({ method: 'POST', url: `/v1/templates/${id}/run`, payload: body, headers: { 'idempotency-key': `a-key-of-sixteen-chars-${(keys += 1)}` } });
const anchor = { entityType: 'maker', stableId: 'A-1' };
const preset = (params: Record<string, unknown> = {}) => ({ sourceId: 'demo', params: { ref: anchor, ...params } });
const full = (params: Record<string, unknown> = {}) => preset({ targetType: 'maker', via: ['LINKS'], ...params });
const runs = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === LINKED_ENTITIES_ID);
const codeOf = (response: { json(): unknown }): unknown => (response.json() as { error?: { code?: unknown } }).error?.code;

describe('POST /v1/templates/:id/run for a preset of the linked-entities template', () => {
  it('answers the entities one hop away with the edge of each, how each was reached and an exact count when the read was not cut', async () => {
    const { app, executor } = await started({ rows: [linkedRow({ match: 'O-1' }), linkedRow({ match: 'O-2' })] });
    const response = await post(app, LINKED_PRESET.id, preset());
    expect(response.statusCode).toBe(200);
    const body = templateRunResponseSchema.parse(response.json());
    expect(body).toMatchObject({ status: 'ok', templateId: 'linked-entities', templateVersion: '1', presetId: 'linked-makers', count: { value: 2, quality: 'exact' }, notices: [] });
    expect(body.matchIds.map((ref) => ref.stableId)).toEqual(['O-1', 'O-2']);
    expect(body.matchIds.map((ref) => ref.stableId)).not.toContain('A-1');
    expect(body.links).toEqual(body.matchIds.map((match) => ({ match, hops: 1 })));
    expect(body.nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'O-1', 'O-2']);
    expect(body.edges.filter((edge) => edge.semantics === 'stored')).toHaveLength(2);
    expect(runs(executor)).toHaveLength(1);
    expect(runs(executor)[0]?.parameters).toMatchObject({ stableId: 'A-1', limit: 25 });
    await app.close();
  });

  it('answers the entity in between for a match at two hops, once for a match reached at both', async () => {
    const { app, executor } = await started({ rows: [linkedRow({ match: 'O-1' }), linkedRow({ match: 'O-2', through: 'O-1' })] });
    const body = templateRunResponseSchema.parse((await post(app, LINKED_PRESET.id, preset({ maxHops: 2 }))).json());
    expect(body.links).toEqual([
      { match: { sourceId: 'demo', entityType: 'maker', stableId: 'O-1' }, hops: 1 },
      { match: { sourceId: 'demo', entityType: 'maker', stableId: 'O-2' }, hops: 2, through: { sourceId: 'demo', entityType: 'maker', stableId: 'O-1' } },
    ]);
    expect(body.count).toMatchObject({ value: 2, quality: 'exact' });
    expect(body.notices).toEqual([{ code: 'noStopList' }]);
    expect(runs(executor)).toHaveLength(1);
    await app.close();
  });

  it('answers a lower bound after a cut, and an exact zero for an anchor that exists and has no match, and NOT_FOUND for one that does not', async () => {
    const rows = Array.from({ length: 4 }, (_unused, index) => linkedRow({ match: `O-${index + 1}` }));
    const cut = await started({ rows });
    const body = templateRunResponseSchema.parse((await post(cut.app, LINKED_PRESET.id, preset({ limit: 3 }))).json());
    expect(body.count).toMatchObject({ value: 3, quality: 'lowerBound' });
    await cut.app.close();
    const none = await started({ rows: [noLinkedRow()] });
    expect(templateRunResponseSchema.parse((await post(none.app, LINKED_PRESET.id, preset())).json())).toMatchObject({ matchIds: [], count: { value: 0, quality: 'exact' } });
    await none.app.close();
    const missing = await started({ rows: [] });
    const response = await post(missing.app, LINKED_PRESET.id, preset());
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 404, code: 'NOT_FOUND' });
    await missing.app.close();
  });

  it('names the supernodes that were not traversed and answers a lower bound, and names the bound that was hit', async () => {
    const { app } = await started({ rows: [linkedRow({ match: 'O-1', heavy: ['H-1', 'H-2'], bounded: true })] });
    const body = templateRunResponseSchema.parse((await post(app, LINKED_PRESET.id, preset({ maxHops: 2 }))).json());
    expect(body.count.quality).toBe('lowerBound');
    expect(body.notices).toEqual([{ code: 'noStopList' }, { code: 'supernodesSkipped', entities: [{ sourceId: 'demo', entityType: 'maker', stableId: 'H-1' }, { sourceId: 'demo', entityType: 'maker', stableId: 'H-2' }] }, { code: 'readBounded' }]);
    await app.close();
  });

  it('says that a stop-listed entity was not traversed, and answers a lower bound', async () => {
    const mapping = linkedMappingOf();
    const { app } = await started({ rows: [linkedRow({ match: 'O-1', stopListed: true })], mapping });
    const request = { sourceId: 'demo', params: { ref: anchor, targetType: 'shop', via: ['USES_TOOL', 'STOCKED_AT'], maxHops: 2 } };
    const body = templateRunResponseSchema.parse((await post(app, 'linked-entities', request)).json());
    expect(body.notices).toEqual([{ code: 'stopListSkipped' }]);
    expect(body.count.quality).toBe('lowerBound');
    await app.close();
  });

  it('applies a window on the clock of the service to the types that have a time, and names the relationship types it could not apply to', async () => {
    const { app, executor } = await started({ rows: [linkedRow({ match: 'O-1' })], now: () => new Date('2026-06-30T12:00:00.000Z') });
    const request = full({ via: ['LINKS', 'USES_TOOL'], maxHops: 2, window: { days: 30 } });
    const body = templateRunResponseSchema.parse((await post(app, 'linked-entities', request)).json());
    expect(runs(executor)[0]?.parameters).toMatchObject({ windowFrom: '2026-05-31T12:00:00.000Z', windowTo: '2026-06-30T12:00:00.000Z' });
    expect(body.notices).toEqual([{ code: 'undatedExcluded' }, { code: 'windowNotApplied', relationshipTypes: ['USES_TOOL'] }]);
    await app.close();
  });

  it('masks the personal properties of the nodes when mask is asked, and does not mask them otherwise', async () => {
    const entities = [{ type: 'maker', label: 'Maker', stable_id: 'makerId', pii: [{ property: 'ownerName', class: 'name' }] }, ...LINKED_ENTITIES.slice(1)];
    const row = linkedRow({ match: 'O-1' });
    const named = { ...row, x: { ...row.x, properties: { ...row.x.properties, ownerName: 'Secret Owner' } } };
    const { app } = await started({ rows: [named], mapping: linkedMappingOf({ entities }) });
    expect(JSON.stringify((await post(app, LINKED_PRESET.id, preset())).json())).toContain('Secret Owner');
    const masked = await post(app, LINKED_PRESET.id, { ...preset(), mask: true });
    expect(masked.statusCode).toBe(200);
    expect(JSON.stringify(masked.json())).not.toContain('Secret Owner');
    await app.close();
  });

  it('answers an aggregate edge for a relationship type with no stable ID, its members counted: exact under the cap, a lower bound when the members were cut', async () => {
    const t = tool('T-1');
    const s = shop('S-1');
    const member = (id: string) => ({ ...plainRelationship('STOCKED_AT', t, s, {}), elementId: id });
    const row = (members: readonly string[], cut: boolean) => ({ a: t, bounded: false, heavy: [], stopListed: false, x: s, mid: null, r1: member(members[0] ?? 'r0'), r2: null, hops: 1, members1: members.map(member), membersCut: cut });
    const request = { sourceId: 'demo', params: { ref: { entityType: 'tool', stableId: 'T-1' }, targetType: 'shop', via: ['STOCKED_AT'] } };
    const counted = await started({ rows: [row(['r0', 'r1', 'r2'], false)] });
    const body = templateRunResponseSchema.parse((await post(counted.app, 'linked-entities', request)).json());
    expect(body.matchIds.map((ref) => ref.stableId)).toEqual(['S-1']);
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0]).toMatchObject({ type: 'STOCKED_AT', memberCount: { value: 3, quality: 'exact' } });
    await counted.app.close();
    const cut = await started({ rows: [row(['r0', 'r1', 'r2'], true)] });
    expect(templateRunResponseSchema.parse((await post(cut.app, 'linked-entities', request)).json()).edges[0]).toMatchObject({ memberCount: { value: 3, quality: 'lowerBound' } });
    await cut.app.close();
  });
});

describe('the linked-entities template by its own ID, and what the route refuses', () => {
  it('runs with the target type and the relationship types given, and answers no preset', async () => {
    const { app } = await started({ rows: [linkedRow({ match: 'O-1' })] });
    const body = templateRunResponseSchema.parse((await post(app, 'linked-entities', full())).json());
    expect(body.templateId).toBe('linked-entities');
    expect(body).not.toHaveProperty('presetId');
    await app.close();
  });

  it.each([
    ['a preset that also receives the target type', LINKED_PRESET.id, preset({ targetType: 'maker' }), 400, 'INVALID_REQUEST'],
    ['a preset that also receives the relationship types', LINKED_PRESET.id, preset({ via: ['LINKS'] }), 400, 'INVALID_REQUEST'],
    ['a preset and an entity type other than its anchor', LINKED_PRESET.id, { sourceId: 'demo', params: { ref: { entityType: 'tool', stableId: 'T-1' } } }, 400, 'INVALID_REQUEST'],
    ['the template ID with no target type', 'linked-entities', preset({ via: ['LINKS'] }), 400, 'INVALID_REQUEST'],
    ['the template ID with no relationship types', 'linked-entities', preset({ targetType: 'maker' }), 400, 'INVALID_REQUEST'],
    ['a target type the mapping does not have', 'linked-entities', full({ targetType: 'nothing' }), 400, 'INVALID_REQUEST'],
    ['a relationship type given twice', 'linked-entities', full({ via: ['LINKS', 'LINKS'] }), 400, 'INVALID_REQUEST'],
    ['a name in place of the list of relationship types', 'linked-entities', full({ via: 'LINKS' }), 400, 'INVALID_REQUEST'],
    ['listed relationship types whose stored directions disagree', 'linked-entities', full({ targetType: 'shop', via: ['USES_TOOL', 'ENDORSES'] }), 400, 'INVALID_REQUEST'],
    ['a parameter the template does not name', 'linked-entities', full({ cypher: 'MATCH (n) RETURN n' }), 400, 'INVALID_REQUEST'],
    ['a hop count of zero', LINKED_PRESET.id, preset({ maxHops: 0 }), 400, 'INVALID_REQUEST'],
    ['a hop count above what any source allows', LINKED_PRESET.id, preset({ maxHops: 5 }), 400, 'INVALID_REQUEST'],
    ['three hops', LINKED_PRESET.id, preset({ maxHops: 3 }), 422, 'QUERY_BUDGET_EXCEEDED'],
    ['a limit above the max_page of the source', LINKED_PRESET.id, preset({ limit: 51 }), 422, 'QUERY_BUDGET_EXCEEDED'],
    ['an entity type the source does not map', LINKED_PRESET.id, { sourceId: 'demo', params: { ref: { entityType: 'nothing', stableId: 'A-1' } } }, 404, 'NOT_FOUND'],
    ['an ID that is neither a preset of the source nor a built-in template', 'nothing', preset(), 404, 'NOT_FOUND'],
  ])('answers %s with %s', async (_name, id, request, status, code) => {
    const { app, executor } = await started({ rows: [linkedRow({ match: 'O-1' })] });
    const response = await post(app, id, request);
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status, code });
    expect(runs(executor)).toHaveLength(0);
    await app.close();
  });

  it('carries the cap in the details of the refusal of three hops, and a source whose max_hops is 1 lowers it', async () => {
    const three = await started();
    expect((await post(three.app, LINKED_PRESET.id, preset({ maxHops: 3 }))).json()).toMatchObject({ error: { code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 2 } } });
    await three.app.close();
    const one = await started({ mapping: linkedMappingOf({ budgets: { max_hops: 1 } }) });
    expect((await post(one.app, LINKED_PRESET.id, preset({ maxHops: 2 }))).json()).toMatchObject({ error: { code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 1 } } });
    expect(runs(one.executor)).toHaveLength(0);
    await one.app.close();
  });

  it('answers NOT_FOUND for a source the person may not read, audits the denial, and audits a run and a gate refusal', async () => {
    const denied = await started({ deny: true });
    expect((await post(denied.app, LINKED_PRESET.id, preset())).statusCode).toBe(404);
    expect(denied.events).toMatchObject([{ action: 'entity.linked_entities_run', result: 'denied' }]);
    await denied.app.close();
    const ok = await started({ rows: [linkedRow({ match: 'O-1' })] });
    await post(ok.app, LINKED_PRESET.id, preset());
    await post(ok.app, LINKED_PRESET.id, preset({ maxHops: 3 }));
    expect(ok.events.filter((event) => event.action === 'entity.linked_entities_run').map((event) => event.result)).toEqual(['success', 'refused']);
    await ok.app.close();
  });
});
