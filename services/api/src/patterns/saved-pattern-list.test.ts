import { randomBytes } from 'node:crypto';
import { patternListResponseSchema, type SavedPattern } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createCursorCodec } from '../gate/cursor/codec.js';
import type { Principal } from '../seams/seams.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { parseMapping } from '../mapping/load.js';
import { DERIVED_RULE } from '../testing/derived-fixtures.js';
import { codeOf, DEFINITION, OTHER_IDENTITY, PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, patternApp, SHARED_PRESET, type PatternApp } from '../testing/saved-pattern-rig.js';

const get = (context: PatternApp, query: string) => context.app.inject({ method: 'GET', url: `/v1/patterns${query}` });

async function fill(context: PatternApp, count: number, principal?: Principal): Promise<void> {
  const owner = principal ?? (await context.store.current()).principal;
  for (let index = 0; index < count; index += 1) {
    const kind = index % 2 === 0;
    await context.store.savePattern(
      kind
        ? { sourceId: 'demo', name: `p${index}`, kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition: DEFINITION, anchor: null }
        : { sourceId: 'demo', name: `p${index}`, kind: 'preset-run', presetId: 'linked-makers', templateId: 'linked-entities', templateVersion: 1, params: { maxHops: 2 }, definition: null, anchor: null },
      { principal: owner, traceId: 't', audit: context.audit.sink },
    );
  }
}

describe('GET /v1/patterns', () => {
  it('lists 30 patterns of both kinds newest changed first, 25 and then 5, each shaped as a save answer', async () => {
    const context = await patternApp();
    await fill(context, 30);
    const first = await get(context, '?sourceId=demo&limit=25');
    expect(first.statusCode).toBe(200);
    const page = patternListResponseSchema.parse(first.json());
    expect(page.items).toHaveLength(25);
    expect(page.items.map((item) => item.name).slice(0, 3)).toEqual(['p29', 'p28', 'p27']);
    expect(new Set(page.items.map((item) => item.kind))).toEqual(new Set(['definition', 'preset-run']));
    expect(page.nextCursor).not.toBeNull();
    const second = patternListResponseSchema.parse((await get(context, `?sourceId=demo&limit=25&cursor=${encodeURIComponent(page.nextCursor ?? '')}`)).json());
    expect(second.items.map((item: SavedPattern) => item.name)).toEqual(['p4', 'p3', 'p2', 'p1', 'p0']);
    expect(second.nextCursor).toBeNull();
    expect(context.executor.calls).toEqual([]);
    await context.app.close();
  });

  it('uses the default page of 25 when no limit is sent', async () => {
    const context = await patternApp();
    await fill(context, 26);
    expect(patternListResponseSchema.parse((await get(context, '?sourceId=demo')).json()).items).toHaveLength(25);
    await context.app.close();
  });

  it('lists none of another person\'s patterns, and none of its own for another person', async () => {
    const first = await patternApp();
    await fill(first, 2);
    const second = await patternApp({ sharing: first.store, identity: OTHER_IDENTITY });
    await fill(second, 3, OTHER_IDENTITY.principal);
    expect(patternListResponseSchema.parse((await get(first, '?sourceId=demo')).json()).items).toHaveLength(2);
    expect(patternListResponseSchema.parse((await get(second, '?sourceId=demo')).json()).items).toHaveLength(3);
    await first.app.close();
    await second.app.close();
  });

  it.each([
    ['a limit of 101', '?sourceId=demo&limit=101', 422, 'QUERY_BUDGET_EXCEEDED'],
    ['a limit of 0', '?sourceId=demo&limit=0', 400, 'INVALID_REQUEST'],
    ['a limit that is not a number', '?sourceId=demo&limit=x', 400, 'INVALID_REQUEST'],
    ['no source', '', 400, 'INVALID_REQUEST'],
    ['an unknown query key', '?sourceId=demo&x=1', 400, 'INVALID_REQUEST'],
    ['an unknown source', '?sourceId=nowhere', 404, 'NOT_FOUND'],
    ['a cursor that is not one', '?sourceId=demo&cursor=abc', 409, 'CURSOR_INVALIDATED'],
  ])('refuses %s', async (_label, query, status, code) => {
    const context = await patternApp();
    const response = await get(context, query);
    expect(response.statusCode).toBe(status);
    expect(codeOf(response)).toBe(code);
    if (code === 'QUERY_BUDGET_EXCEEDED') expect((response.json() as { error: { details: unknown } }).error.details).toEqual({ maxPage: 100 });
    await context.app.close();
  });

  it('answers NOT_FOUND for a source the caller may not read', async () => {
    const context = await patternApp({ deny: true });
    const response = await get(context, '?sourceId=demo');
    expect(response.statusCode).toBe(404);
    expect(codeOf(response)).toBe('NOT_FOUND');
    await context.app.close();
  });

  it('refuses the cursor of one source on another source as CURSOR_INVALIDATED', async () => {
    const context = await patternApp();
    await fill(context, 30);
    const cursor = patternListResponseSchema.parse((await get(context, '?sourceId=demo&limit=25')).json()).nextCursor ?? '';
    expect(codeOf(await get(context, `?sourceId=second&cursor=${encodeURIComponent(cursor)}`))).toBe('CURSOR_INVALIDATED');
    expect((await get(context, `?sourceId=demo&cursor=${encodeURIComponent(cursor)}`)).statusCode).toBe(200);
    await context.app.close();
  });

  it('refuses an altered cursor, one of another person and an expired one, each as CURSOR_INVALIDATED', async () => {
    let now = Date.UTC(2026, 10, 12, 10, 0, 0);
    const cursors = createCursorCodec({ key: randomBytes(32), clock: () => now });
    const first = await patternApp({ cursors });
    await fill(first, 30);
    const cursor = (patternListResponseSchema.parse((await get(first, '?sourceId=demo&limit=25')).json()).nextCursor ?? '').toString();
    const altered = `${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(codeOf(await get(first, `?sourceId=demo&cursor=${encodeURIComponent(altered)}`))).toBe('CURSOR_INVALIDATED');
    const second = await patternApp({ sharing: first.store, identity: OTHER_IDENTITY, cursors });
    expect(codeOf(await get(second, `?sourceId=demo&cursor=${encodeURIComponent(cursor)}`))).toBe('CURSOR_INVALIDATED');
    now += 31 * 60_000;
    expect(codeOf(await get(first, `?sourceId=demo&cursor=${encodeURIComponent(cursor)}`))).toBe('CURSOR_INVALIDATED');
    await first.app.close();
    await second.app.close();
  });
});

describe('GET /v1/patterns and the availability of each pattern', () => {
  const lost = parseMapping(fileOf(baseSource({ id: 'demo', entities: PATTERN_ENTITIES, relationships: PATTERN_RELATIONSHIPS.filter((row) => row.type !== 'LINKS'), derived: [DERIVED_RULE], patterns: [SHARED_PRESET] })), 'neburyx.yaml');

  it('shows each pattern as available while the mapping supports it', async () => {
    const context = await patternApp();
    await fill(context, 2);
    const page = patternListResponseSchema.parse((await get(context, '?sourceId=demo')).json());
    expect(page.items.map((item) => item.availability)).toEqual([{ status: 'available' }, { status: 'available' }]);
    await context.app.close();
  });

  it('still lists a pattern after a mapping change that removed what it uses, as unavailable with the reason, and reads nothing from the source', async () => {
    const before = await patternApp();
    await fill(before, 2);
    const after = await patternApp({ sharing: before.store, mapping: lost, answer: () => Promise.reject(new Error('the list read the source')) });
    const page = patternListResponseSchema.parse((await get(after, '?sourceId=demo')).json());
    const byName = Object.fromEntries(page.items.map((item) => [item.name, item.availability]));
    expect(byName['p0']).toEqual({ status: 'unavailable', reasons: [{ code: 'unknown-relationship-type', path: ['steps', 0, 'relationshipTypes', 0] }] });
    expect(byName['p1']).toEqual({ status: 'unavailable', reasons: [{ code: 'preset-removed' }] });
    expect(after.executor.calls).toEqual([]);
    await after.app.close();
    await before.app.close();
  });

  it('lists no other person\'s pattern, and the save answer has no availability', async () => {
    const context = await patternApp();
    await fill(context, 1, OTHER_IDENTITY.principal);
    expect(patternListResponseSchema.parse((await get(context, '?sourceId=demo')).json()).items).toEqual([]);
    const saved = await context.app.inject({ method: 'POST', url: '/v1/patterns', payload: { sourceId: 'demo', kind: 'definition', name: 'x', definition: DEFINITION }, headers: { 'content-type': 'application/json' } });
    expect(saved.json()).not.toHaveProperty('availability');
    await context.app.close();
  });
});
