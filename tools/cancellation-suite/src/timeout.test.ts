import { afterEach, describe, expect, it } from 'vitest';
import { HUB, NEIGHBOR_TYPES, personalise, startRig, until, type Rig } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
});

const timeout = { status: 'timeout' } as const;
const merged = (r: Rig): boolean => r.state.loadedGraph().nodes.length > r.loaded.nodes.length;
const last = (r: Rig) => r.responses[r.responses.length - 1];

describe('an expansion whose read times out', () => {
  it('answers QUERY_TIMEOUT with the limit, leaves the client as it was, and shows Timed out with Retry', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const asked = rig.expand.expand(HUB, ['leaf']);
    (await rig.nextRead()).fail(timeout);
    expect(await asked).toBe('failed');
    expect(last(rig)).toMatchObject({ status: 504, body: { error: { code: 'QUERY_TIMEOUT', retryable: true, details: { timeoutMs: 5000 } } } });
    expect(rig.snapshot()).toBe(before);
    expect(rig.showing()?.headline).toContain('5 s');
    expect(rig.showing()?.actions).toContain('retry');
    expect(JSON.stringify(last(rig))).not.toMatch(/MATCH|cypher/i);
  });

  it('merges none of three pages when the second read times out', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const asked = rig.expand.expand(HUB, [...NEIGHBOR_TYPES]);
    (await rig.nextRead()).answerRows();
    const second = await rig.nextRead();
    rig.drain();
    second.fail(timeout);
    expect(await asked).toBe('failed');
    expect(merged(rig)).toBe(false);
    expect(rig.snapshot()).toBe(before);
  });

  it('keeps the cursor and the loaded count of a load more that times out', async () => {
    rig = await startRig();
    rig.expand.setPageSize(HUB, 1);
    const first = rig.expand.expand(HUB, ['leaf']);
    (await rig.nextRead()).answerRows(2);
    await first;
    const before = rig.snapshot();
    const more = rig.expand.loadMore(HUB, 'leaf');
    (await rig.nextRead()).fail(timeout);
    expect(await more).toBe('failed');
    expect(rig.snapshot()).toBe(before);
    expect(rig.expand.of(HUB).types.get('leaf')?.cursor).toBeDefined();
  });

  it('keeps the banner on Cancelled and the client as it was when the person cancelled while the timeout was on the way', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const asked = rig.expand.expand(HUB, ['leaf']);
    const read = await rig.nextRead();
    await rig.pressCancel();
    read.fail(timeout);
    await asked;
    expect(rig.showing()).toMatchObject({ id: 'cancelled' });
    expect(rig.snapshot()).toBe(before);
  });

  it('merges the page once when Retry finds the source answering', async () => {
    rig = await startRig();
    const asked = rig.expand.expand(HUB, ['leaf']);
    (await rig.nextRead()).fail(timeout);
    await asked;
    const retry = rig.banner.view.getState().banner?.actions.find((each) => each.id === 'retry');
    if (retry === undefined) throw new Error('no Retry offered');
    retry.run();
    (await rig.nextRead()).answerRows();
    await until(() => merged(rig), 'the page to be merged');
    const titles = rig.state.loadedGraph().nodes.map((each) => each.display.title);
    expect(titles.filter((title) => title === 'leaf-1')).toHaveLength(1);
  });

  it('names the shared deadline of 10 s when it stops a read that started with less than the source timeout', async () => {
    rig = await startRig();
    const before = rig.snapshot();
    const asked = rig.expand.expand(HUB, [...NEIGHBOR_TYPES]);
    (await rig.nextRead()).answerRows();
    rig.advance(6000);
    const second = await rig.nextRead();
    rig.drain();
    second.fail(timeout);
    expect(await asked).toBe('failed');
    expect(last(rig)).toMatchObject({ status: 504, body: { error: { code: 'QUERY_TIMEOUT', details: { timeoutMs: 10_000 } } } });
    expect(rig.showing()?.headline).toContain('10 s');
    expect(rig.snapshot()).toBe(before);
  });
});
