import { savedPatternSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { makeToken } from '../reference/token.js';
import { codeOf, DEFINITION, jsonHeaders, OTHER_IDENTITY, patternApp, reasonOf, TEST_KEYS, type PatternApp } from '../testing/saved-pattern-rig.js';

const send = (context: PatternApp, method: 'POST' | 'PUT', url: string, body: unknown) => context.app.inject({ method, url, payload: JSON.stringify(body), headers: jsonHeaders });
let named = 0;
const saved = async (context: PatternApp, body: Record<string, unknown> = {}) => savedPatternSchema.parse((await send(context, 'POST', '/v1/patterns', { sourceId: 'demo', kind: 'definition', name: `Ring ${(named += 1)}`, definition: DEFINITION, ...body })).json());
const change = (context: PatternApp, id: string, body: unknown) => send(context, 'PUT', `/v1/patterns/${id}`, body);
const NEW_DEFINITION = { anchorType: 'maker', steps: [{ relationshipTypes: ['USES_TOOL'], direction: 'out', arrivesAt: 'tool' }] };

describe('PUT /v1/patterns/{id}', () => {
  it('renames the pattern: version 2, the new name, the ETag, and one changed event of version 2', async () => {
    const context = await patternApp();
    const pattern = await saved(context);
    const response = await change(context, pattern.id, { expectedVersion: 1, name: '  New name ' });
    expect(response.statusCode).toBe(200);
    expect(savedPatternSchema.parse(response.json())).toMatchObject({ id: pattern.id, name: 'New name', version: 2, kind: 'definition' });
    expect(response.headers['etag']).toBe('"2"');
    expect(context.store.patternEvents.map((event) => [event.action, event.version])).toEqual([['saved', 1], ['changed', 2]]);
    expect(context.audit.events.map((event) => event.action)).toEqual(['pattern.save', 'pattern.change']);
    expect(context.executor.calls).toEqual([]);
    await context.app.close();
  });

  it('changes the definition of a built pattern, the parameters of a built-in run, and the held entity, each as one version and one event', async () => {
    const context = await patternApp();
    const built = await saved(context);
    const changedDefinition = await change(context, built.id, { expectedVersion: 1, definition: NEW_DEFINITION });
    expect(savedPatternSchema.parse(changedDefinition.json())).toMatchObject({ version: 2, definition: NEW_DEFINITION });
    const preset = await saved(context, { kind: 'preset-run', presetId: 'linked-makers', params: { maxHops: 2 }, definition: undefined });
    const changedParams = await change(context, preset.id, { expectedVersion: 1, params: { maxHops: 3 } });
    expect(savedPatternSchema.parse(changedParams.json())).toMatchObject({ version: 2, params: { maxHops: 3 } });
    const held = await change(context, built.id, { expectedVersion: 2, anchor: { entityType: 'maker', stableId: 'm-1' } });
    expect(savedPatternSchema.parse(held.json())).toMatchObject({ version: 3, askForStartingEntity: false, anchor: { entityType: 'maker', stableId: 'm-1' } });
    expect(context.store.patternEvents.filter((event) => event.action === 'changed').map((event) => event.version)).toEqual([2, 2, 3]);
    await context.app.close();
  });

  it('clears the held entity with anchor null: it asks again, the columns are null, one version and one event', async () => {
    const context = await patternApp();
    const pattern = await saved(context, { anchor: { entityType: 'maker', stableId: 'm-1' } });
    const response = await change(context, pattern.id, { expectedVersion: 1, anchor: null });
    expect(response.statusCode).toBe(200);
    expect(savedPatternSchema.parse(response.json())).toMatchObject({ askForStartingEntity: true, anchor: null, version: 2 });
    expect(context.store.patternRows[0]).toMatchObject({ anchorEntityType: null, anchorStableId: null, askForStartingEntity: true });
    expect(context.store.patternEvents.at(-1)).toMatchObject({ action: 'changed', version: 2 });
    expect(codeOf(await change(context, pattern.id, { expectedVersion: 2, askForStartingEntity: true }))).toBe('INVALID_REQUEST');
    await context.app.close();
  });

  it('leaves the row and the events as they were when a new definition or parameters are refused', async () => {
    const context = await patternApp();
    const pattern = await saved(context);
    const refused = await change(context, pattern.id, { expectedVersion: 1, definition: { anchorType: 'maker', steps: [{ relationshipTypes: ['NOPE'], direction: 'out', arrivesAt: 'tool' }] } });
    expect(refused.statusCode).toBe(400);
    const personal = await change(context, pattern.id, { expectedVersion: 1, definition: { ...DEFINITION, steps: [{ ...DEFINITION.steps[0], conditions: [{ on: 'neighbor', property: 'phoneNum', op: 'eq', value: { kind: 'text', value: 'x' } }] }] } });
    expect(reasonOf(personal)).toBe('pattern-personal-condition');
    expect(context.store.patternRows[0]).toMatchObject({ version: 1, definition: DEFINITION });
    expect(context.store.patternEvents).toHaveLength(1);
    await context.app.close();
  });

  it('refuses a stale version as CONFLICT and changes nothing, and two changes with one version make one winner', async () => {
    const context = await patternApp();
    const pattern = await saved(context);
    expect((await change(context, pattern.id, { expectedVersion: 1, name: 'one' })).statusCode).toBe(200);
    const stale = await change(context, pattern.id, { expectedVersion: 1, name: 'two' });
    expect(stale.statusCode).toBe(409);
    expect(codeOf(stale)).toBe('CONFLICT');
    expect(context.store.patternRows[0]).toMatchObject({ name: 'one', version: 2 });
    const racing = await Promise.all([change(context, pattern.id, { expectedVersion: 2, name: 'a' }), change(context, pattern.id, { expectedVersion: 2, name: 'b' })]);
    expect(racing.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    await context.app.close();
  });

  it('treats a name equal to the stored one with the current version as a change, and with a stale one as CONFLICT', async () => {
    const context = await patternApp();
    const pattern = await saved(context);
    expect(savedPatternSchema.parse((await change(context, pattern.id, { expectedVersion: 1, name: 'Ring' })).json()).version).toBe(2);
    expect(codeOf(await change(context, pattern.id, { expectedVersion: 1, name: 'Ring' }))).toBe('CONFLICT');
    await context.app.close();
  });

  it.each([
    ['only the version', { expectedVersion: 1 }],
    ['a kind', { expectedVersion: 1, kind: 'preset-run' }],
    ['a source', { expectedVersion: 1, sourceId: 'demo' }],
    ['a preset', { expectedVersion: 1, presetId: 'x' }],
    ['a visibility with a name', { expectedVersion: 1, name: 'x', visibility: 'shared' }],
    ['a visibility that is not one', { expectedVersion: 1, visibility: 'public' }],
    ['parameters for a built pattern', { expectedVersion: 1, params: {} }],
    ['a held entity of a type the pattern does not start at', { expectedVersion: 1, anchor: { entityType: 'tool', stableId: 'x' } }],
    ['no version', { name: 'x' }],
  ])('refuses %s', async (_label, body) => {
    const context = await patternApp();
    const pattern = await saved(context);
    const response = await change(context, pattern.id, body);
    expect(response.statusCode).toBe(400);
    expect(codeOf(response)).toBe('INVALID_REQUEST');
    expect(context.store.patternRows[0]).toMatchObject({ version: 1 });
    await context.app.close();
  });

  it('refuses a definition for a built-in run, and a new definition that no longer starts at the held entity unless the request replaces or clears it', async () => {
    const context = await patternApp();
    const preset = await saved(context, { kind: 'preset-run', presetId: 'linked-makers', params: {}, definition: undefined });
    expect(codeOf(await change(context, preset.id, { expectedVersion: 1, definition: DEFINITION }))).toBe('INVALID_REQUEST');
    const keyed = { anchorType: 'handle', steps: [{ relationshipTypes: ['CALLS'], direction: 'out', arrivesAt: 'maker' }] };
    const token = makeToken(TEST_KEYS, { sourceId: 'demo', entityType: 'handle' }, '555-0100');
    const held = await saved(context, { definition: keyed, anchor: { entityType: 'handle', stableId: token } });
    expect(codeOf(await change(context, held.id, { expectedVersion: 1, definition: DEFINITION }))).toBe('INVALID_REQUEST');
    expect((await change(context, held.id, { expectedVersion: 1, definition: DEFINITION, anchor: null })).statusCode).toBe(200);
    expect((await change(context, held.id, { expectedVersion: 2, definition: keyed, anchor: { entityType: 'handle', stableId: token } })).statusCode).toBe(200);
    await context.app.close();
  });

  it('still renames a built-in run whose preset the mapping lost, and refuses new parameters for it', async () => {
    const context = await patternApp();
    const preset = await saved(context, { kind: 'preset-run', presetId: 'linked-makers', params: {}, definition: undefined });
    const lost = context.store.patternRows.findIndex((row) => row.id === preset.id);
    const held = context.store.patternRows[lost];
    if (held === undefined) throw new Error('the pattern is not held');
    context.store.patternRows[lost] = { ...held, presetId: 'gone' };
    const renamed = await change(context, preset.id, { expectedVersion: 1, name: 'Renamed' });
    expect(renamed.statusCode).toBe(200);
    expect(savedPatternSchema.parse(renamed.json())).toMatchObject({ name: 'Renamed', version: 2 });
    expect(context.store.patternEvents.at(-1)).toMatchObject({ action: 'changed', version: 2 });
    expect(codeOf(await change(context, preset.id, { expectedVersion: 2, params: { maxHops: 2 } }))).toBe('INVALID_REQUEST');
    await context.app.close();
  });

  it('answers NOT_FOUND for another person\'s pattern, a deleted one, an id that is not a uuid and a preset\'s id, and changes nothing', async () => {
    const first = await patternApp();
    const pattern = await saved(first);
    const second = await patternApp({ sharing: first.store, identity: OTHER_IDENTITY });
    for (const [context, id] of [[second, pattern.id], [first, 'linked-makers'], [first, 'not-a-uuid'], [first, '0192f000-0000-7000-8000-0000000000ff']] as const) {
      const response = await change(context, id, { expectedVersion: 1, name: 'x' });
      expect(response.statusCode).toBe(404);
      expect(codeOf(response)).toBe('NOT_FOUND');
    }
    await first.app.inject({ method: 'DELETE', url: `/v1/patterns/${pattern.id}`, headers: { 'if-match': '"1"' } });
    expect(codeOf(await change(first, pattern.id, { expectedVersion: 2, name: 'x' }))).toBe('NOT_FOUND');
    expect(first.store.patternRows[0]).toMatchObject({ name: expect.stringMatching(/^Ring \d+$/) });
    await first.app.close();
    await second.app.close();
  });

  it('answers AUDIT_UNAVAILABLE and leaves the row and its version as they were when the event cannot be written', async () => {
    const context = await patternApp();
    const pattern = await saved(context);
    const failing = await patternApp({ sharing: { ...context.store, ...(await failingStore(context)) } });
    const response = await change(failing, pattern.id, { expectedVersion: 1, name: 'x' });
    expect(response.statusCode).toBe(503);
    expect(codeOf(response)).toBe('AUDIT_UNAVAILABLE');
    expect(context.store.patternRows[0]).toMatchObject({ name: expect.stringMatching(/^Ring \d+$/), version: 1 });
    await context.app.close();
    await failing.app.close();
  });
});

/** The change and delete of the same rows through a store whose event writes fail. */
async function failingStore(context: PatternApp) {
  const { memoryPatterns } = await import('../testing/memory-patterns.js');
  const failing = memoryPatterns({ failPatternEvent: true });
  failing.patternRows.push(...context.store.patternRows);
  return { ...failing, patternRows: failing.patternRows, patternEvents: failing.patternEvents };
}

describe('DELETE /v1/patterns/{id}', () => {
  const remove = (context: PatternApp, id: string, headers: Record<string, string> = { 'if-match': '"1"' }, extra: { payload?: string; query?: string } = {}) =>
    context.app.inject({ method: 'DELETE', url: `/v1/patterns/${id}${extra.query ?? ''}`, headers, ...(extra.payload === undefined ? {} : { payload: extra.payload }) });

  it('soft-deletes the pattern with the purge date 30 days on, answers its version and the ETag, stops listing it and records one deleted event', async () => {
    const context = await patternApp();
    const pattern = await saved(context);
    const response = await remove(context, pattern.id);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string; version: number; deletedAt: string; purgeAfter: string };
    expect(body).toMatchObject({ id: pattern.id, version: 2 });
    expect(Date.parse(body.purgeAfter) - Date.parse(body.deletedAt)).toBe(30 * 86_400_000);
    expect(response.headers['etag']).toBe('"2"');
    expect(context.store.deletedPatterns.has(pattern.id)).toBe(true);
    expect((await context.app.inject({ method: 'GET', url: '/v1/patterns?sourceId=demo' })).json()).toMatchObject({ items: [] });
    expect(context.store.patternEvents.map((event) => [event.action, event.version])).toEqual([['saved', 1], ['deleted', 2]]);
    expect(context.audit.events.at(-1)?.action).toBe('pattern.delete');
    await context.app.close();
  });

  it('answers NOT_FOUND for a second delete, and for another person\'s pattern, an id that is not a uuid and a preset\'s id', async () => {
    const first = await patternApp();
    const pattern = await saved(first);
    const second = await patternApp({ sharing: first.store, identity: OTHER_IDENTITY });
    expect(codeOf(await remove(second, pattern.id))).toBe('NOT_FOUND');
    expect(first.store.deletedPatterns.size).toBe(0);
    for (const id of ['linked-makers', 'not-a-uuid']) expect(codeOf(await remove(first, id))).toBe('NOT_FOUND');
    expect((await remove(first, pattern.id)).statusCode).toBe(200);
    expect(codeOf(await remove(first, pattern.id, { 'if-match': '"2"' }))).toBe('NOT_FOUND');
    await first.app.close();
    await second.app.close();
  });

  it('refuses a stale version as CONFLICT, a missing or malformed If-Match, a body and a query string as INVALID_REQUEST', async () => {
    const context = await patternApp();
    const pattern = await saved(context);
    expect(codeOf(await remove(context, pattern.id, { 'if-match': '"7"' }))).toBe('CONFLICT');
    expect(codeOf(await remove(context, pattern.id, {}))).toBe('INVALID_REQUEST');
    expect(codeOf(await remove(context, pattern.id, { 'if-match': '1' }))).toBe('INVALID_REQUEST');
    expect(codeOf(await remove(context, pattern.id, { 'if-match': '"1"', 'content-type': 'application/json' }, { payload: '{}' }))).toBe('INVALID_REQUEST');
    expect(codeOf(await remove(context, pattern.id, { 'if-match': '"1"' }, { query: '?x=1' }))).toBe('INVALID_REQUEST');
    expect(context.store.deletedPatterns.size).toBe(0);
    await context.app.close();
  });

  it('answers AUDIT_UNAVAILABLE and does not delete the pattern when the event cannot be written', async () => {
    const context = await patternApp();
    const pattern = await saved(context);
    const failing = await patternApp({ sharing: { ...context.store, ...(await failingStore(context)) } });
    const response = await remove(failing, pattern.id);
    expect(response.statusCode).toBe(503);
    expect(codeOf(response)).toBe('AUDIT_UNAVAILABLE');
    expect(context.store.deletedPatterns.size).toBe(0);
    await context.app.close();
    await failing.app.close();
  });

  it('no longer counts a deleted pattern towards the 200 of the caller on a source', async () => {
    const context = await patternApp();
    const owner = (await context.store.current()).principal;
    const first = await saved(context);
    for (let index = 0; index < 199; index += 1) await context.store.savePattern({ sourceId: 'demo', name: `p${index}`, kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition: DEFINITION, anchor: null }, { principal: owner, traceId: 't', audit: context.audit.sink });
    expect(reasonOf(await send(context, 'POST', '/v1/patterns', { sourceId: 'demo', kind: 'definition', name: 'x', definition: DEFINITION }))).toBe('pattern-limit');
    expect((await remove(context, first.id)).statusCode).toBe(200);
    expect((await send(context, 'POST', '/v1/patterns', { sourceId: 'demo', kind: 'definition', name: 'x', definition: DEFINITION })).statusCode).toBe(201);
    await context.app.close();
  });
});
