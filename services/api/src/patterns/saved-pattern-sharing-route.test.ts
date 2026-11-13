import { PATTERN_LIMITS, listedPatternSchema, patternListResponseSchema, savedPatternSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { memoryStoreWith } from '../testing/app-store.js';
import { codeOf, DEFINITION, jsonHeaders, OTHER_IDENTITY, patternApp, reasonOf, type PatternApp } from '../testing/saved-pattern-rig.js';

const FLAGGED = { anchorType: 'maker', steps: [{ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', conditions: [{ on: 'neighbor', property: 'phoneNum', op: 'eq', value: { kind: 'text', value: 'x' } }] }] };
const send = (context: PatternApp, method: 'POST' | 'PUT' | 'DELETE' | 'GET', url: string, body?: unknown, headers: Record<string, string> = jsonHeaders) =>
  context.app.inject({ method, url, headers: headers === jsonHeaders && body === undefined ? {} : headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
const save = async (context: PatternApp, over: Record<string, unknown> = {}) => savedPatternSchema.parse((await send(context, 'POST', '/v1/patterns', { sourceId: 'demo', kind: 'definition', name: 'Ring', definition: DEFINITION, ...over })).json());
const put = (context: PatternApp, id: string, body: unknown) => send(context, 'PUT', `/v1/patterns/${id}`, body);
const share = (context: PatternApp, id: string, version: number, visibility: 'shared' | 'private' = 'shared') => put(context, id, { expectedVersion: version, visibility });
const list = async (context: PatternApp, query = 'sourceId=demo') => patternListResponseSchema.parse((await send(context, 'GET', `/v1/patterns?${query}`)).json());

const firstRow = (context: PatternApp) => {
  const [row] = context.store.patternRows;
  if (row === undefined) throw new Error('no pattern');
  return row;
};

/** Two people on one store: A (the local user) and B (another person). */
async function two(optionsB: { readonly deny?: boolean } = {}) {
  const a = await patternApp();
  const b = await patternApp({ sharing: a.store, identity: OTHER_IDENTITY, ...optionsB });
  return { a, b };
}

describe('sharing a pattern', () => {
  it('shares and unshares it: version, ETag and one event of the requested action', async () => {
    const { a } = await two();
    const pattern = await save(a);
    const shared = await share(a, pattern.id, 1);
    expect(shared.statusCode).toBe(200);
    expect(savedPatternSchema.parse(shared.json())).toMatchObject({ visibility: 'shared', version: 2 });
    expect(shared.headers['etag']).toBe('"2"');
    const unshared = await share(a, pattern.id, 2, 'private');
    expect(savedPatternSchema.parse(unshared.json())).toMatchObject({ visibility: 'private', version: 3 });
    expect(a.store.patternEvents.map((event) => [event.action, event.version])).toEqual([['saved', 1], ['shared', 2], ['unshared', 3]]);
    expect(a.audit.events.map((event) => event.action)).toEqual(['pattern.save', 'pattern.share', 'pattern.unshare']);
    expect(a.executor.calls).toEqual([]);
  });

  it('is a request of its own, and refuses a value that is not one', async () => {
    const { a } = await two();
    const pattern = await save(a);
    for (const body of [{ expectedVersion: 1, name: 'x', visibility: 'shared' }, { expectedVersion: 1, definition: DEFINITION, visibility: 'shared' }, { expectedVersion: 1, anchor: null, visibility: 'shared' }, { expectedVersion: 1, visibility: 'public' }]) {
      expect(codeOf(await put(a, pattern.id, body)), JSON.stringify(body)).toBe('INVALID_REQUEST');
    }
    expect(a.store.patternRows[0]).toMatchObject({ visibility: 'private', version: 1 });
  });

  it('answers CONFLICT for a stale version, and records the requested action for a visibility equal to the stored one', async () => {
    const { a } = await two();
    const pattern = await save(a);
    expect(codeOf(await share(a, pattern.id, 5))).toBe('CONFLICT');
    expect(a.store.patternRows[0]).toMatchObject({ visibility: 'private', version: 1 });
    expect((await share(a, pattern.id, 1, 'private')).statusCode).toBe(200);
    expect(a.store.patternEvents.at(-1)).toMatchObject({ action: 'unshared', version: 2 });
    expect(a.store.patternRows[0]).toMatchObject({ visibility: 'private', version: 2 });
  });

  it('refuses to share a pattern that holds a condition on what the mapping marks personal, and still allows unsharing it', async () => {
    const { a } = await two();
    const pattern = await save(a);
    a.store.patternRows.splice(0, 1, { ...firstRow(a), definition: FLAGGED });
    const refused = await share(a, pattern.id, 1);
    expect(codeOf(refused)).toBe('INVALID_REQUEST');
    expect(reasonOf(refused)).toBe('pattern-personal-condition');
    expect(a.store.patternEvents.map((event) => event.action)).toEqual(['saved']);
    a.store.patternRows.splice(0, 1, { ...firstRow(a), visibility: 'shared' });
    expect((await share(a, pattern.id, 1, 'private')).statusCode).toBe(200);
  });
});

describe('the list with other people\'s shared patterns', () => {
  it('shows another person\'s shared pattern with its creator\'s name and no id, never a private one, and one own shared pattern once', async () => {
    const { a, b } = await two();
    const theirsShared = await save(a, { name: 'Shared ring' });
    await save(a, { name: 'Private ring' });
    await share(a, theirsShared.id, 1);
    const own = await save(b, { name: 'B own' });
    const seenByB = await list(b);
    expect(seenByB.items.map((item) => item.name).sort()).toEqual(['B own', 'Shared ring']);
    const shown = seenByB.items.find((item) => item.name === 'Shared ring');
    expect(shown).toMatchObject({ ownedByYou: false, visibility: 'shared', owner: { name: 'Local workspace' } });
    expect(JSON.stringify(seenByB)).not.toContain(a.store.patternRows[0]?.ownerId ?? 'x');
    expect(seenByB.items.find((item) => item.id === own.id)).toMatchObject({ ownedByYou: true });
    const seenByA = await list(a);
    expect(seenByA.items.filter((item) => item.name === 'Shared ring')).toHaveLength(1);
    expect(seenByA.items.find((item) => item.name === 'Shared ring')).toMatchObject({ ownedByYou: true });
    expect(seenByA.items.map((item) => item.name)).not.toContain('B own');
  });

  it('drops a pattern from the next list when it is unshared or deleted, and does not list it on another source', async () => {
    const { a, b } = await two();
    const one = await save(a, { name: 'One' });
    const two2 = await save(a, { name: 'Two' });
    await share(a, one.id, 1);
    await share(a, two2.id, 1);
    expect((await list(b)).items).toHaveLength(2);
    expect((await list(b, 'sourceId=second')).items).toHaveLength(0);
    await share(a, one.id, 2, 'private');
    expect((await list(b)).items.map((item) => item.name)).toEqual(['Two']);
    expect((await send(a, 'DELETE', `/v1/patterns/${two2.id}`, undefined, { 'if-match': '"2"' })).statusCode).toBe(200);
    expect((await list(b)).items).toEqual([]);
  });

  it('shows the held starting entity as stored', async () => {
    const { a, b } = await two();
    const pattern = await save(a, { anchor: { entityType: 'maker', stableId: 'm-1' } });
    await share(a, pattern.id, 1);
    expect((await list(b)).items[0]).toMatchObject({ askForStartingEntity: false, anchor: { entityType: 'maker', stableId: 'm-1' } });
  });

  it('leaves out, for another person only, a shared pattern that now holds a condition on personal data, and still continues from the right place', async () => {
    const { a, b } = await two();
    const flagged = await save(a, { name: 'Flagged' });
    await share(a, flagged.id, 1);
    a.store.patternRows.splice(0, 1, { ...firstRow(a), definition: FLAGGED });
    const fine = await save(a, { name: 'Fine' });
    await share(a, fine.id, 1);
    expect((await list(b)).items.map((item) => item.name)).toEqual(['Fine']);
    expect((await list(a)).items.map((item) => item.name).sort()).toEqual(['Fine', 'Flagged']);
    const first = patternListResponseSchema.parse((await send(b, 'GET', '/v1/patterns?sourceId=demo&limit=1')).json());
    expect(first.items.map((item) => item.name)).toEqual(['Fine']);
    const second = patternListResponseSchema.parse((await send(b, 'GET', `/v1/patterns?sourceId=demo&limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)).json());
    expect(second.items).toEqual([]);
    expect(second.nextCursor).toBeNull();
  });

  it('pages the patterns of both people in one order and answers the source\'s NOT_FOUND to a person who may not read it', async () => {
    const { a, b } = await two();
    for (let index = 0; index < 18; index += 1) await share(a, (await save(a, { name: `a${index}` })).id, 1);
    for (let index = 0; index < 12; index += 1) await save(b, { name: `b${index}` });
    const page = patternListResponseSchema.parse((await send(b, 'GET', '/v1/patterns?sourceId=demo&limit=25')).json());
    expect(page.items).toHaveLength(25);
    const rest = patternListResponseSchema.parse((await send(b, 'GET', `/v1/patterns?sourceId=demo&limit=25&cursor=${encodeURIComponent(page.nextCursor ?? '')}`)).json());
    expect(rest.items).toHaveLength(5);
    expect(rest.nextCursor).toBeNull();
    const updated = [...page.items, ...rest.items].map((item) => item.updatedAt);
    expect([...updated].sort().reverse()).toEqual(updated);
    const denied = await patternApp({ sharing: a.store, identity: OTHER_IDENTITY, deny: true });
    expect(codeOf(await send(denied, 'GET', '/v1/patterns?sourceId=demo'))).toBe('NOT_FOUND');
    expect(listedPatternSchema.safeParse(page.items[0]).success).toBe(true);
  });
});

describe('only the creator changes, unshares or deletes a shared pattern', () => {
  it('answers ACCESS_DENIED to another person for every change and a delete, in any order of checks, and changes nothing', async () => {
    const { a, b } = await two();
    const pattern = await save(a);
    await share(a, pattern.id, 1);
    const before = JSON.stringify(a.store.patternRows);
    const events = a.store.patternEvents.length;
    for (const body of [{ expectedVersion: 2, name: 'Mine now' }, { expectedVersion: 2, visibility: 'private' }, { expectedVersion: 2, definition: DEFINITION }, { expectedVersion: 2, anchor: null }, { expectedVersion: 9, name: 'x' }, { expectedVersion: 2, params: {} }]) {
      expect(codeOf(await put(b, pattern.id, body)), JSON.stringify(body)).toBe('ACCESS_DENIED');
    }
    for (const match of ['"2"', '"9"']) {
      const response = await send(b, 'DELETE', `/v1/patterns/${pattern.id}`, undefined, { 'if-match': match });
      expect(response.statusCode).toBe(403);
      expect(codeOf(response)).toBe('ACCESS_DENIED');
    }
    expect(JSON.stringify(a.store.patternRows)).toBe(before);
    expect(a.store.patternEvents).toHaveLength(events);
  });

  it('answers NOT_FOUND, as for an id that does not exist, for a private pattern of another person, a deleted one, an id that is not a uuid and a preset\'s id', async () => {
    const { a, b } = await two();
    const priv = await save(a);
    const deleted = await save(a, { name: 'Deleted' });
    await share(a, deleted.id, 1);
    await send(a, 'DELETE', `/v1/patterns/${deleted.id}`, undefined, { 'if-match': '"2"' });
    const unknown = codeOf(await put(b, '0192f000-0000-7000-8000-0000000000ff', { expectedVersion: 1, name: 'x' }));
    expect(unknown).toBe('NOT_FOUND');
    for (const id of [priv.id, deleted.id, 'not-a-uuid', 'linked-makers']) {
      expect(codeOf(await put(b, id, { expectedVersion: 1, name: 'x' })), id).toBe('NOT_FOUND');
      expect(codeOf(await send(b, 'DELETE', `/v1/patterns/${id}`, undefined, { 'if-match': '"1"' })), id).toBe('NOT_FOUND');
    }
  });

  it('answers the source\'s own NOT_FOUND, not ACCESS_DENIED, to a person who may not read the source', async () => {
    const { a } = await two();
    const pattern = await save(a);
    await share(a, pattern.id, 1);
    const denied = await patternApp({ sharing: a.store, identity: OTHER_IDENTITY, deny: true });
    expect(codeOf(await put(denied, pattern.id, { expectedVersion: 2, name: 'x' }))).toBe('NOT_FOUND');
    expect(codeOf(await send(denied, 'DELETE', `/v1/patterns/${pattern.id}`, undefined, { 'if-match': '"2"' }))).toBe('NOT_FOUND');
  });

  it('lets the creator change, unshare and delete it as before', async () => {
    const { a, b } = await two();
    const pattern = await save(a);
    await share(a, pattern.id, 1);
    expect((await put(a, pattern.id, { expectedVersion: 2, name: 'Renamed' })).statusCode).toBe(200);
    expect((await share(a, pattern.id, 3, 'private')).statusCode).toBe(200);
    expect((await list(b)).items).toEqual([]);
  });
});

describe('copying a pattern', () => {
  it('copies another person\'s shared pattern into a private pattern of the caller, with the suffix, the same structure and entity, at version 1, and writes both events', async () => {
    const { a, b } = await two();
    const original = await save(a, { name: 'Ring', anchor: { entityType: 'maker', stableId: 'm-1' } });
    await share(a, original.id, 1);
    const response = await send(b, 'POST', `/v1/patterns/${original.id}/copy`);
    expect(response.statusCode).toBe(201);
    expect(response.headers['etag']).toBe('"1"');
    const copy = savedPatternSchema.parse(response.json());
    expect(copy).toMatchObject({ name: 'Ring (copy)', visibility: 'private', version: 1, lastRunAt: null, kind: 'definition', definition: DEFINITION, askForStartingEntity: false, anchor: { entityType: 'maker', stableId: 'm-1' }, sourceId: 'demo' });
    expect(copy.id).not.toBe(original.id);
    expect(a.store.patternRows.find((row) => row.id === copy.id)).toMatchObject({ ownerId: OTHER_IDENTITY.principal.id });
    expect(a.store.patternEvents.filter((event) => event.action === 'copied').map((event) => [event.patternId === copy.id ? 'copy' : 'original', event.version, event.actorId])).toEqual([['copy', 1, OTHER_IDENTITY.principal.id], ['original', 2, OTHER_IDENTITY.principal.id]]);
    expect(b.audit.events.map((event) => event.action)).toEqual(['pattern.copy', 'pattern.copy']);
  });

  it('is independent of the original: a later change, unshare or deletion of it does not touch the copy', async () => {
    const { a, b } = await two();
    const original = await save(a, { name: 'Ring' });
    await share(a, original.id, 1);
    const copy = savedPatternSchema.parse((await send(b, 'POST', `/v1/patterns/${original.id}/copy`)).json());
    await put(a, original.id, { expectedVersion: 2, name: 'Changed' });
    await share(a, original.id, 3, 'private');
    await send(a, 'DELETE', `/v1/patterns/${original.id}`, undefined, { 'if-match': '"4"' });
    expect((await list(b)).items).toMatchObject([{ id: copy.id, name: 'Ring (copy)', version: 1 }]);
    expect((await put(b, copy.id, { expectedVersion: 1, name: 'Mine' })).statusCode).toBe(200);
  });

  it('lets the creator copy its own pattern, private or shared, into a private copy', async () => {
    const { a } = await two();
    const pattern = await save(a);
    const copy = savedPatternSchema.parse((await send(a, 'POST', `/v1/patterns/${pattern.id}/copy`)).json());
    expect(copy).toMatchObject({ name: 'Ring (copy)', visibility: 'private' });
    await share(a, pattern.id, 1);
    expect((await send(a, 'POST', `/v1/patterns/${pattern.id}/copy`)).statusCode).toBe(201);
  });

  it('keeps the whole name within the limit by cutting the original by code points, also for characters outside the basic plane', async () => {
    const { a } = await two();
    for (const name of ['a'.repeat(100), '𝒳'.repeat(100), 'b'.repeat(93), `${'c'.repeat(92)} `.repeat(1) + 'd']) {
      const pattern = await save(a, { name });
      const copy = savedPatternSchema.parse((await send(a, 'POST', `/v1/patterns/${pattern.id}/copy`)).json());
      expect([...copy.name].length).toBeLessThanOrEqual(PATTERN_LIMITS.nameLength);
      expect(copy.name.endsWith(' (copy)')).toBe(true);
    }
  });

  it('answers NOT_FOUND for another person\'s private pattern, a deleted one, an id that is not a uuid, a preset and a source that may not be read, and stores nothing', async () => {
    const { a, b } = await two();
    const priv = await save(a);
    const deleted = await save(a, { name: 'Gone' });
    await send(a, 'DELETE', `/v1/patterns/${deleted.id}`, undefined, { 'if-match': '"1"' });
    for (const id of [priv.id, deleted.id, 'not-a-uuid', 'linked-makers']) expect(codeOf(await send(b, 'POST', `/v1/patterns/${id}/copy`)), id).toBe('NOT_FOUND');
    await share(a, priv.id, 1);
    const denied = await patternApp({ sharing: a.store, identity: OTHER_IDENTITY, deny: true });
    expect(codeOf(await send(denied, 'POST', `/v1/patterns/${priv.id}/copy`))).toBe('NOT_FOUND');
    expect(a.store.patternRows.filter((row) => row.ownerId === OTHER_IDENTITY.principal.id)).toEqual([]);
  });

  it('refuses a body with a key and a query string, and a pattern that now holds a condition on personal data', async () => {
    const { a, b } = await two();
    const pattern = await save(a);
    await share(a, pattern.id, 1);
    expect(codeOf(await send(b, 'POST', `/v1/patterns/${pattern.id}/copy`, { name: 'x' }))).toBe('INVALID_REQUEST');
    expect(codeOf(await send(b, 'POST', `/v1/patterns/${pattern.id}/copy?x=1`))).toBe('INVALID_REQUEST');
    expect((await send(b, 'POST', `/v1/patterns/${pattern.id}/copy`, {})).statusCode).toBe(201);
    a.store.patternRows.splice(0, 1, { ...firstRow(a), definition: FLAGGED });
    const refused = await send(b, 'POST', `/v1/patterns/${pattern.id}/copy`);
    expect(codeOf(refused)).toBe('INVALID_REQUEST');
    expect(reasonOf(refused)).toBe('pattern-personal-condition');
  });

  it('refuses with pattern-limit when the caller already has the most patterns on the source', async () => {
    const { a, b } = await two();
    const pattern = await save(a);
    await share(a, pattern.id, 1);
    for (let index = 0; index < PATTERN_LIMITS.patternsPerSource; index += 1) await save(b, { name: `b${index}` });
    const refused = await send(b, 'POST', `/v1/patterns/${pattern.id}/copy`);
    expect(codeOf(refused)).toBe('INVALID_REQUEST');
    expect(reasonOf(refused)).toBe('pattern-limit');
    expect(a.store.patternRows.filter((row) => row.ownerId === OTHER_IDENTITY.principal.id)).toHaveLength(PATTERN_LIMITS.patternsPerSource);
  });

  it('refuses with AUDIT_UNAVAILABLE and keeps no copy when the event cannot be written', async () => {
    const store = memoryStoreWith({ failPatternEvent: true });
    const original = { id: '0192f000-0000-7000-8000-0000000000aa', ownerId: '0192f000-0000-7000-8000-0000000000bb', sourceId: 'demo', name: 'Ring', kind: 'definition' as const, presetId: null, templateId: null, templateVersion: null, params: null, definition: DEFINITION, askForStartingEntity: true, anchorEntityType: null, anchorStableId: null, visibility: 'shared' as const, lastRunAt: null, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z', version: 2 };
    store.patternRows.push(original);
    const b = await patternApp({ sharing: store, identity: OTHER_IDENTITY });
    expect(codeOf(await send(b, 'POST', `/v1/patterns/${original.id}/copy`))).toBe('AUDIT_UNAVAILABLE');
    expect(store.patternRows).toEqual([original]);
    expect(store.patternEvents).toEqual([]);
    expect(b.audit.events).toEqual([]);
  });
});

describe('the names of a person’s patterns on a source', () => {
  const postBody = (name: string) => ({ sourceId: 'demo', kind: 'definition', name, definition: DEFINITION });
  const post = (context: PatternApp, name: string) => send(context, 'POST', '/v1/patterns', postBody(name));

  it('refuses a name another of the person’s patterns holds, ignoring case, spaces at its ends and Unicode form, with CONFLICT and its own reason, and writes nothing', async () => {
    const { a } = await two();
    await save(a, { name: 'Ring' });
    const events = a.store.patternEvents.length;
    for (const name of ['Ring', 'ring', '  RING  ', 'rINg']) {
      const response = await post(a, name);
      expect(response.statusCode, name).toBe(409);
      expect(codeOf(response)).toBe('CONFLICT');
      expect(reasonOf(response)).toBe('pattern-name-taken');
    }
    const composed = await save(a, { name: 'Caf\u00e9' });
    expect(composed.name).toBe('Caf\u00e9');
    expect(reasonOf(await post(a, 'Cafe\u0301'))).toBe('pattern-name-taken');
    expect(a.store.patternRows).toHaveLength(2);
    expect(a.store.patternEvents.length).toBe(events + 1);
  });

  it('takes the same name for two people and for two sources, and again once the pattern that held it is deleted', async () => {
    const { a, b } = await two();
    const first = await save(a, { name: 'Ring' });
    await save(b, { name: 'Ring' });
    expect((await send(a, 'DELETE', `/v1/patterns/${first.id}`, undefined, { 'if-match': '"1"' })).statusCode).toBe(200);
    expect((await post(a, 'Ring')).statusCode).toBe(201);
  });

  it('refuses a rename to a name another pattern holds, and allows a rename to the pattern’s own name in another case', async () => {
    const { a } = await two();
    const ring = await save(a, { name: 'Ring' });
    const other = await save(a, { name: 'Other' });
    const taken = await put(a, other.id, { expectedVersion: 1, name: ' ring ' });
    expect(taken.statusCode).toBe(409);
    expect(reasonOf(taken)).toBe('pattern-name-taken');
    expect(a.store.patternRows.find((row) => row.id === other.id)).toMatchObject({ name: 'Other', version: 1 });
    expect((await put(a, ring.id, { expectedVersion: 1, name: 'RING' })).statusCode).toBe(200);
    const stale = await put(a, ring.id, { expectedVersion: 1, name: 'Ring' });
    expect(stale.statusCode).toBe(409);
    expect(reasonOf(stale)).toBeUndefined();
  });

  it('names each copy of a pattern the next free number, and cuts a long name so that every copy fits the limit', async () => {
    const { a, b } = await two();
    const original = await save(a, { name: 'Ring' });
    await share(a, original.id, 1);
    const names: string[] = [];
    for (let round = 0; round < 3; round += 1) names.push(savedPatternSchema.parse((await send(b, 'POST', `/v1/patterns/${original.id}/copy`)).json()).name);
    expect(names).toEqual(['Ring (copy)', 'Ring (copy 2)', 'Ring (copy 3)']);
    const long = await save(a, { name: 'x'.repeat(PATTERN_LIMITS.nameLength) });
    await share(a, long.id, 1);
    const copies = [];
    for (let round = 0; round < 3; round += 1) copies.push(savedPatternSchema.parse((await send(b, 'POST', `/v1/patterns/${long.id}/copy`)).json()).name);
    expect(new Set(copies).size).toBe(3);
    expect(copies.every((name) => [...name].length <= PATTERN_LIMITS.nameLength)).toBe(true);
  });
});

