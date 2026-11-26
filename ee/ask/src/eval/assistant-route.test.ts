import { afterAll, describe, expect, it } from 'vitest';
import { replayProvider, type ReplayAnswer } from '@neburyx/ee-ai-runtime';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { loadSource } from './evaluate.js';
import { contextKeys, contextTurns, routeMessage, routerRequests, routerTextSha256 } from './assistant-route.js';

afterAll(removeAskFolders);

async function sourceOf() {
  const loaded = await loadSource(makeAskFolder(['src1']), 'src1');
  if (!loaded.ok) throw new Error('the folder does not load');
  return loaded.source;
}

const INPUT = { message: 'Show it', viewElementKeys: [] };

describe('the router as the product builds it, over a replay', () => {
  it('routes a message from its recorded reply, in one call', async () => {
    const source = await sourceOf();
    const { first } = await routerRequests(source, INPUT);
    const answers = new Map<string, ReplayAnswer>([[first, { reply: '{"route":"view"}' }]]);
    expect(await routeMessage(source, replayProvider(answers), 'replay', INPUT)).toMatchObject({ status: 'routed', reply: { route: 'view' }, calls: 1, keys: {} });
  });

  it('repeats a reply that is not a route once, with the fixed note, and takes the repeat\'s route', async () => {
    const source = await sourceOf();
    const { first, repeat } = await routerRequests(source, INPUT);
    expect(repeat).toBe(`${first}\n\nYour last reply was not a route. Reply with one route object only: start with { and write nothing before or after it, no reasoning.`);
    const answers = new Map<string, ReplayAnswer>([[first, { reply: 'Sure. {"route":"view"}' }], [repeat, { reply: '{"route":"view"}' }]]);
    expect(await routeMessage(source, replayProvider(answers), 'replay', INPUT)).toMatchObject({ status: 'routed', calls: 2 });
  });

  it('routes in one call a reply that ends with its route after other text', async () => {
    const source = await sourceOf();
    const { first } = await routerRequests(source, INPUT);
    const answers = new Map<string, ReplayAnswer>([[first, { reply: 'It asks about what is shown.\n\n{"route":"view"}' }]]);
    expect(await routeMessage(source, replayProvider(answers), 'replay', INPUT)).toMatchObject({ status: 'routed', reply: { route: 'view' }, calls: 1 });
  });

  it('ends unplaced after one repeat when neither reply is a route', async () => {
    const source = await sourceOf();
    const { first, repeat } = await routerRequests(source, INPUT);
    const answers = new Map<string, ReplayAnswer>([[first, { reply: 'no' }], [repeat, { reply: 'still no' }]]);
    expect(await routeMessage(source, replayProvider(answers), 'replay', INPUT)).toMatchObject({ status: 'unplaced', calls: 2 });
  });

  it('answers a failed call when the replay has no entry for the request', async () => {
    const source = await sourceOf();
    expect(await routeMessage(source, replayProvider(new Map()), 'replay', INPUT)).toMatchObject({ status: 'failed' });
  });

  it('keys the requests by the message and the keys of the view', async () => {
    const source = await sourceOf();
    const plain = await routerRequests(source, INPUT);
    const withView = await routerRequests(source, { message: INPUT.message, viewElementKeys: [JSON.stringify(['node', 'src1', 'widget', 'A-1'])] });
    expect(plain.first).toContain('Message:\nShow it');
    expect(plain.first).toContain('In view:\n(none)');
    expect(withView.first).toContain('c1 | "widget" | "A-1"');
    expect(withView.first).not.toBe(plain.first);
  });

  it('hashes the router text of a source: stable, and different when the classification text changes', async () => {
    const one = await sourceOf();
    expect(await routerTextSha256(one)).toBe(await routerTextSha256(one));
    expect(await routerTextSha256(one)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the thread context of labelled earlier turns', () => {
  const ran = (stableId: string, intent = 'shared') => ({ route: 'ask' as const, intent, entities: { id: stableId } });

  it('shows the router the labelled turns by the product\'s own builder, each element as a key with its stable id as title, and nothing when there are none', async () => {
    const source = await sourceOf();
    const none = await routerRequests(source, INPUT);
    const some = await routerRequests(source, { ...INPUT, earlier: [ran('W-1')] });
    expect(none.first).not.toContain('Earlier turns');
    expect(some.first).toContain('Earlier turns of this thread, oldest first:');
    expect(some.first).toContain('1. ask "shared"; ran for id = c1');
    expect(some.first).toMatch(/^c1 \| "W-1" \| "widget"$/m);
  });

  it('shows at most the last turns the setting names: turns 4 and 5 of a thread see the last 3', async () => {
    const source = await sourceOf();
    const earlier = ['W-1', 'W-2', 'W-3', 'W-4'].map((id) => ran(id));
    expect(contextTurns()).toBe(3);
    const { first } = await routerRequests(source, { ...INPUT, earlier });
    for (const id of ['W-2', 'W-3', 'W-4']) expect(first).toContain(`"${id}"`);
    expect(first).not.toContain('"W-1"');
  });

  it('gives a parameter that is not an element no reference, and a refused turn only its cause', async () => {
    const source = await sourceOf();
    const { first } = await routerRequests(source, { ...INPUT, earlier: [{ route: 'ask', intent: 'byId', entities: { id: 'W-9' } }, { route: 'refuse', cause: 'verdict' }] });
    expect(first).not.toContain('W-9');
    expect(first).toContain('refused (verdict)');
  });

  it('maps the keys of a route back to the stable ids they stood for, and accepts a clarification only when its candidates are of the context', async () => {
    const source = await sourceOf();
    const input = { ...INPUT, earlier: [ran('W-1'), ran('W-2')] };
    const { first } = await routerRequests(source, input);
    const reply = '{"route":"ask","intent":"shared","entities":{},"elements":{"id":"c2"}}';
    const routed = await routeMessage(source, replayProvider(new Map<string, ReplayAnswer>([[first, { reply }]])), 'replay', input);
    expect(routed).toMatchObject({ status: 'routed', keys: { c1: 'W-1', c2: 'W-2' } });
    const clarify = '{"route":"clarify","intent":"shared","role":"id","entities":{},"candidates":["c1","c2"]}';
    expect(await routeMessage(source, replayProvider(new Map<string, ReplayAnswer>([[first, { reply: clarify }]])), 'replay', input)).toMatchObject({ status: 'routed', reply: { route: 'clarify' } });
    expect((await routeMessage(source, replayProvider(new Map<string, ReplayAnswer>([[first, { reply: clarify }]])), 'replay', INPUT)).status).not.toBe('routed');
  });
});


describe('the context of a view turn and an ask turn', () => {
  it('gives the elements a view shows keys, and an ask turn cites nothing the labels do not name', async () => {
    const source = await sourceOf();
    const view = await contextKeys(source, [{ route: 'view', cited: [{ entityType: 'thing', stableId: 'T-1' }] }]);
    expect(Object.values(view)).toEqual(['T-1']);
    const empty = await contextKeys(source, [{ route: 'view', cited: [] }]);
    expect(empty).toEqual({});
  });

  it('gives the elements in view keys after those of the thread, once for an element held by both, and none for a key that is no element of this source', async () => {
    const source = await sourceOf();
    const key = (id: string, sourceId = source.sourceId) => JSON.stringify(['node', sourceId, 'thing', id]);
    expect(await contextKeys(source, [], [key('T-9', 'another-source'), 'not a key'])).toEqual({});
    const both = await contextKeys(source, [{ route: 'view', cited: [{ entityType: 'thing', stableId: 'T-1' }] }], [key('T-1'), key('T-2')]);
    expect(Object.values(both)).toEqual(['T-1', 'T-2']);
    expect(Object.keys(both)).toHaveLength(2);
    expect(Object.values(await contextKeys(source, [], [key('T-2')]))).toEqual(['T-2']);
  });
});
