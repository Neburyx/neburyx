import { afterEach, describe, expect, it } from 'vitest';
import { unavailableHeadline } from '../../../apps/web/src/banner/copy.js';
import { HUB, NEIGHBOR_TYPES, personalise, startRig, until, type Rig } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
});

const unreachable = { status: 'unavailable', reason: 'unreachable' } as const;
const merged = (r: Rig): boolean => r.state.loadedGraph().nodes.length > r.loaded.nodes.length;
const last = (r: Rig) => r.responses[r.responses.length - 1];

describe('an expansion of three types whose source stops answering after the first read', () => {
  it('merges none of the pages, shows the Unavailable banner with Retry, and holds no slot', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const asked = rig.expand.expand(HUB, [...NEIGHBOR_TYPES]);
    (await rig.nextRead()).answerRows();
    const second = await rig.nextRead();
    rig.drain();
    second.fail(unreachable);
    expect(await asked).toBe('failed');
    expect(merged(rig)).toBe(false);
    expect(rig.snapshot()).toBe(before);
    expect(last(rig)).toMatchObject({ body: { error: { code: 'SOURCE_UNAVAILABLE', retryable: true } } });
    expect(rig.showing()).toEqual({ id: 'source-unavailable', headline: unavailableHeadline('Demo source'), actions: ['retry'] });
    await until(() => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0, 'the read slots to be free');
    expect(await rig.expand.expand(HUB, ['leaf'])).toBe('sent');
  });

  it('keeps the cursor and the loaded count of a load more whose source stops answering', async () => {
    rig = await startRig();
    rig.expand.setPageSize(HUB, 1);
    const first = rig.expand.expand(HUB, ['leaf']);
    (await rig.nextRead()).answerRows(2);
    await first;
    const before = rig.snapshot();
    const more = rig.expand.loadMore(HUB, 'leaf');
    (await rig.nextRead()).fail(unreachable);
    expect(await more).toBe('failed');
    expect(rig.snapshot()).toBe(before);
  });

  it('merges the expansion once when the source answers again and the person retries', async () => {
    rig = await startRig();
    const asked = rig.expand.expand(HUB, ['leaf']);
    (await rig.nextRead()).fail(unreachable);
    await asked;
    rig.banner.view.getState().banner?.actions.find((each) => each.id === 'retry')?.run();
    (await rig.nextRead()).answerRows();
    await until(() => rig.state.loadedGraph().nodes.length > rig.loaded.nodes.length, 'the retried page to be merged');
    const titles = rig.state.loadedGraph().nodes.map((each) => each.display.title);
    expect(titles.filter((title) => title === 'leaf-1')).toHaveLength(1);
    expect(rig.expand.of(HUB)).toMatchObject({ status: 'idle', failure: undefined });
    expect(rig.showing()).toBeUndefined();
  });

  it('answers with no query text, address or login', async () => {
    rig = await startRig();
    const asked = rig.expand.expand(HUB, ['leaf']);
    (await rig.nextRead()).fail(unreachable);
    await asked;
    const body = JSON.stringify(last(rig)?.body);
    for (const leak of [/MATCH|RETURN|cypher/i, /bolt|neo4j|127\.0\.0\.1|graph\.example/i, /DEMO_USER|DEMO_PASSWORD|password/i]) expect(body).not.toMatch(leak);
  });
});
