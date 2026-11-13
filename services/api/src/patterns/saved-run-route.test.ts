import { savedPatternRunResponseSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { linkedRow } from '../testing/linked-entities-fixtures.js';
import { oneStepRow } from '../testing/pattern-fixtures.js';
import { parseMapping } from '../mapping/load.js';
import { DERIVED_RULE } from '../testing/derived-fixtures.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { codeOf, DEFINITION, OTHER_IDENTITY, PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, patternApp, SHARED_PRESET, type PatternApp } from '../testing/saved-pattern-rig.js';

const KEY = 'a-key-of-sixteen-characters';
const ANCHOR = { entityType: 'maker', stableId: 'W-1' };

const answerRows = (call: ExecuteCall): Promise<ExecuteOutcome> =>
  Promise.resolve({
    status: 'rows',
    rows:
      call.templateId === 'pattern'
        ? [oneStepRow('W-1', 'W-2')]
        : call.templateId === 'linked-entities'
          ? [linkedRow({ anchor: 'W-1', match: 'W-2' })]
          : call.templateId === 'pattern-count'
            ? [{ matches: 1, bounded: false, stopListed: false, supernodes: 0 }]
            : call.templateId === 'linked-entities-count'
              ? [{ matches: 1, frontierBounded: false, supernodeSkipped: false }]
              : [],
  });

const started = (options: Parameters<typeof patternApp>[0] = {}) => patternApp({ answer: answerRows, ...options });
const post = (context: PatternApp, id: string, body: unknown, key: string | null = KEY, url?: string) =>
  context.app.inject({ method: 'POST', url: url ?? `/v1/patterns/${id}/run`, payload: body as object, headers: key === null ? {} : { 'idempotency-key': key } });
const reads = (context: PatternApp) => context.executor.calls.filter((call) => call.templateId === 'pattern' || call.templateId === 'linked-entities');

async function saved(context: PatternApp, body: Record<string, unknown> = { kind: 'definition', definition: DEFINITION }): Promise<string> {
  const response = await context.app.inject({ method: 'POST', url: '/v1/patterns', payload: { sourceId: 'demo', name: 'A pattern', ...body }, headers: { 'content-type': 'application/json' } });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}
const lastRun = async (context: PatternApp, id: string) => (await context.store.readPattern(id, (await context.store.current()).principal.id))?.lastRunAt;

describe('POST /v1/patterns/{id}/run', () => {
  it('runs a saved definition and answers what the run route answers, with the path of each match, and records the time of the run', async () => {
    const context = await started();
    const id = await saved(context);
    expect(await lastRun(context, id)).toBeNull();
    const response = await post(context, id, { anchor: ANCHOR });
    expect(response.statusCode).toBe(200);
    const body = savedPatternRunResponseSchema.parse(response.json());
    if (body.status !== 'ok' || !('matches' in body)) throw new Error('not a pattern answer');
    expect(body.matches.map((entry) => entry.match.stableId)).toEqual(['W-2']);
    expect(await lastRun(context, id)).not.toBeNull();
    const direct = await context.app.inject({ method: 'POST', url: '/v1/patterns/run', payload: { sourceId: 'demo', definition: DEFINITION, anchor: ANCHOR }, headers: { 'idempotency-key': 'a-direct-key-of-sixteen' } });
    expect(direct.json()).toEqual(response.json());
    await context.app.close();
  });

  it('runs a saved run of a preset and answers what the template route answers', async () => {
    const context = await started();
    const id = await saved(context, { kind: 'preset-run', presetId: 'linked-makers', params: { maxHops: 1 } });
    const response = await post(context, id, { anchor: ANCHOR });
    expect(response.statusCode).toBe(200);
    const direct = await context.app.inject({ method: 'POST', url: '/v1/templates/linked-makers/run', payload: { sourceId: 'demo', params: { ref: ANCHOR, maxHops: 1 } }, headers: { 'idempotency-key': 'a-template-key-of-sixteen' } });
    expect(response.json()).toEqual(direct.json());
    await context.app.close();
  });

  it('runs from the entity the pattern holds when the request gives none', async () => {
    const context = await started();
    const id = await saved(context, { kind: 'definition', definition: DEFINITION, anchor: { entityType: 'maker', stableId: 'H-5' } });
    expect((await post(context, id, {})).statusCode).toBe(200);
    expect(reads(context)[0]?.parameters['stableId']).toBe('H-5');
    await context.app.close();
  });

  it.each([
    ['an unknown key', { anchor: ANCHOR, extra: 1 }],
    ['a source', { sourceId: 'demo' }],
    ['a definition', { definition: DEFINITION }],
    ['a limit below one', { limit: 0 }],
    ['no entity at all for a pattern that holds none', {}],
    ['an entity of another type than the pattern starts at', { anchor: { entityType: 'tool', stableId: 'T-1' } }],
  ])('refuses %s with INVALID_REQUEST and reads nothing', async (_name, body) => {
    const context = await started();
    const id = await saved(context);
    const response = await post(context, id, body);
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    expect(reads(context)).toHaveLength(0);
    await context.app.close();
  });

  it.each([['no key', null], ['a key that is too short', 'short'], ['a key with a character that is not allowed', 'a key with spaces in it!']])('is refused with INVALID_REQUEST for %s', async (_name, key) => {
    const context = await started();
    const id = await saved(context);
    expect(codeOf(await post(context, id, { anchor: ANCHOR }, key))).toBe('INVALID_REQUEST');
    expect(codeOf(await post(context, id, { anchor: ANCHOR }, KEY, `/v1/patterns/${id}/run?x=1`))).toBe('INVALID_REQUEST');
    expect(reads(context)).toHaveLength(0);
    await context.app.close();
  });

  it('answers NOT_FOUND for an id that is not a uuid, an unknown or deleted pattern, a mapping preset’s id and another person’s private pattern', async () => {
    const context = await started();
    const id = await saved(context);
    const other = await started({ sharing: context.store, identity: OTHER_IDENTITY });
    for (const [where, target] of [[context, 'nothing'], [context, '0192f000-0000-7000-8000-0000000000ff'], [context, 'linked-makers'], [other, id]] as const) {
      const response = await post(where, target, { anchor: ANCHOR });
      expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 404, code: 'NOT_FOUND' });
    }
    const principal = (await context.store.current()).principal;
    await context.store.deletePattern({ id, ownerId: principal.id, expectedVersion: 1, retentionDays: 30 }, { principal, traceId: 't', audit: context.audit.sink });
    expect(codeOf(await post(context, id, { anchor: ANCHOR }, 'another-key-of-sixteen-chars'))).toBe('NOT_FOUND');
    expect(reads(context)).toHaveLength(0);
    await context.app.close();
    await other.app.close();
  });

  it('runs a shared pattern for another person and records no run for it', async () => {
    const context = await started();
    const id = await saved(context);
    const principal = (await context.store.current()).principal;
    const held = await context.store.readPattern(id, principal.id);
    if (held === undefined) throw new Error('no row');
    (context.store as unknown as { patternRows: unknown[] }).patternRows.splice(0, 1, { ...held, visibility: 'shared' });
    const other = await started({ sharing: context.store, identity: OTHER_IDENTITY });
    const response = await post(other, id, { anchor: ANCHOR });
    expect(response.statusCode).toBe(200);
    expect(await lastRun(context, id)).toBeNull();
    await context.app.close();
    await other.app.close();
  });
});

describe('a saved run after the mapping changed', () => {
  const lost = parseMapping(fileOf(baseSource({ id: 'demo', entities: PATTERN_ENTITIES, relationships: PATTERN_RELATIONSHIPS.filter((row) => row.type !== 'LINKS'), derived: [DERIVED_RULE], patterns: [SHARED_PRESET] })), 'neburyx.yaml');

  it('answers that the pattern is unavailable, with the reason, reads nothing from the source and records no run', async () => {
    const before = await started();
    const id = await saved(before);
    const after = await started({ sharing: before.store, mapping: lost });
    const response = await post(after, id, { anchor: ANCHOR });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'unavailable', reasons: [{ code: 'unknown-relationship-type', path: ['steps', 0, 'relationshipTypes', 0] }] });
    expect(after.executor.calls.filter((call) => call.templateId !== 'schema-indexes')).toEqual([]);
    expect(await lastRun(before, id)).toBeNull();
    await before.app.close();
    await after.app.close();
  });
});

describe('an idempotent saved run', () => {
  it('answers the first answer again for the same key and body, with the replay header, reads once and records one run', async () => {
    const context = await started();
    const id = await saved(context);
    const first = await post(context, id, { anchor: ANCHOR });
    const recorded = await lastRun(context, id);
    const second = await post(context, id, { anchor: ANCHOR });
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(reads(context)).toHaveLength(1);
    expect(await lastRun(context, id)).toBe(recorded);
    await context.app.close();
  });

  it('answers CONFLICT for the same key with another body', async () => {
    const context = await started();
    const id = await saved(context);
    await post(context, id, { anchor: ANCHOR });
    expect(codeOf(await post(context, id, { anchor: ANCHOR, limit: 5 }))).toBe('CONFLICT');
    await context.app.close();
  });

  it('stores a refusal and answers it again with the replay header', async () => {
    const context = await started();
    const id = await saved(context);
    const first = await post(context, id, {});
    const second = await post(context, id, {});
    expect(first.statusCode).toBe(400);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    await context.app.close();
  });

  it('does not keep a first call that ended in a server error, so a retry runs again', async () => {
    let calls = 0;
    const context = await started({ answer: (call) => (call.templateId === 'pattern-count' && ++calls === 1 ? Promise.resolve({ status: 'unavailable', reason: 'unreachable' }) : answerRows(call)) });
    const id = await saved(context);
    expect((await post(context, id, { anchor: ANCHOR })).statusCode).toBeGreaterThanOrEqual(500);
    expect((await post(context, id, { anchor: ANCHOR })).statusCode).toBe(200);
    await context.app.close();
  });

  it('answers NOT_FOUND for a replay after the pattern was made private again, ACCESS_DENIED after its source left the mapping, and CONFLICT after the policy changed', async () => {
    const context = await started();
    const id = await saved(context);
    const principal = (await context.store.current()).principal;
    const held = await context.store.readPattern(id, principal.id);
    if (held === undefined) throw new Error('no row');
    const rows = (context.store as unknown as { patternRows: unknown[] }).patternRows;
    rows.splice(0, 1, { ...held, visibility: 'shared' });
    const other = await started({ sharing: context.store, identity: OTHER_IDENTITY });
    expect((await post(other, id, { anchor: ANCHOR })).statusCode).toBe(200);
    rows.splice(0, 1, { ...held, visibility: 'private' });
    const replay = await post(other, id, { anchor: ANCHOR });
    expect({ status: replay.statusCode, code: codeOf(replay) }).toEqual({ status: 404, code: 'NOT_FOUND' });
    await context.app.close();
    await other.app.close();
    const gone = await started();
    const goneId = await saved(gone);
    expect((await post(gone, goneId, { anchor: ANCHOR })).statusCode).toBe(200);
    const elsewhere = parseMapping(fileOf(baseSource({ id: 'elsewhere', entities: PATTERN_ENTITIES, relationships: PATTERN_RELATIONSHIPS, derived: [DERIVED_RULE], patterns: [SHARED_PRESET] })), 'neburyx.yaml');
    const after = await started({ sharing: gone.store, mapping: elsewhere });
    const denied = await post(after, goneId, { anchor: ANCHOR });
    expect({ status: denied.statusCode, code: codeOf(denied) }).toEqual({ status: 403, code: 'ACCESS_DENIED' });
    await gone.app.close();
    await after.app.close();
    let version = 'one';
    const changed = await started({ policyVersion: () => version });
    const changedId = await saved(changed);
    expect((await post(changed, changedId, { anchor: ANCHOR })).statusCode).toBe(200);
    version = 'two';
    expect(codeOf(await post(changed, changedId, { anchor: ANCHOR }))).toBe('CONFLICT');
    await changed.app.close();
  });
});
