import { afterEach, describe, expect, it } from 'vitest';
import { HUB, PATTERN, personalise, runAndAdd, startRig, until, type Rig } from './rig.js';

let open: Rig | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const begin = async (): Promise<Rig> => (open = await startRig());

const merged = (r: Rig): boolean => r.state.loadedGraph().nodes.length > r.loaded.nodes.length;

describe('an answer that reaches the client after the person cancelled', () => {
  it('is not merged when the cancel lands after the whole body was read and before the store handled the answer', async () => {
    const rig = await begin();
    personalise(rig);
    const before = rig.snapshot();
    rig.at.afterBody = () => void rig.cancelNow();
    const asked = rig.expand.expand(HUB, ['leaf']);
    (await rig.nextRead()).answerRows();
    await asked;
    expect(rig.order).toEqual(['cancel', 'finish']);
    expect(rig.snapshot()).toBe(before);
    expect(rig.showing()).toMatchObject({ id: 'cancelled' });
  });
});

describe('a cancel that comes after the answer', () => {
  it('leaves the answer merged, shows no Cancelled state, and changes nothing when pressed again', async () => {
    const rig = await begin();
    const asked = rig.expand.expand(HUB, ['leaf']);
    const read = await rig.nextRead();
    await until(() => rig.showing()?.actions.includes('cancel') === true, 'the Running banner');
    const captured = rig.banner.view.getState().banner?.actions.find((each) => each.id === 'cancel');
    if (captured === undefined) throw new Error('no Cancel captured');
    read.answerRows();
    await asked;
    expect(merged(rig)).toBe(true);
    const settled = rig.snapshot();
    captured.run();
    expect(rig.snapshot()).toBe(settled);
    expect(rig.showing()?.id).not.toBe('cancelled');
    captured.run();
    expect(rig.snapshot()).toBe(settled);
    expect(rig.order).toEqual(['finish']);
  });
});

describe('a cancel and a newer ask for the same node', () => {
  it('merge only the newer answer when the older one arrives last', async () => {
    const rig = await begin();
    const older = rig.expand.expand(HUB, ['leaf']);
    const olderRead = await rig.nextRead();
    const newer = rig.expand.expand(HUB, ['leaf']);
    const newerRead = await rig.nextRead();
    newerRead.answerRows(1);
    expect(await newer).toBe('sent');
    olderRead.answerRows(2);
    await older;
    const titles = rig.state.loadedGraph().nodes.map((each) => each.display.title);
    expect(titles).toContain('leaf-1');
    expect(titles).not.toContain('leaf-2');
  });
});

type Point = 'source-turn' | 'route-wrote' | 'headers' | 'body' | 'finished';
const POINTS: readonly Point[] = ['source-turn', 'route-wrote', 'headers', 'body', 'finished'];

describe('the cancel placed at each point of the path of one answer', () => {
  for (const point of POINTS) {
    it(`${point}: merged only when the store's request ended before the cancel, 10 runs`, async () => {
      for (let run = 0; run < 10; run += 1) {
        const rig = await begin();
        const before = rig.snapshot();
        if (point === 'headers') rig.at.afterHeaders = () => void rig.cancelNow();
        if (point === 'body') rig.at.afterBody = () => void rig.cancelNow();
        const asked = rig.expand.expand(HUB, ['leaf']);
        const read = await rig.nextRead();
        await until(() => rig.showing()?.actions.includes('cancel') === true, 'the Running banner');
        read.answerRows();
        if (point === 'source-turn') rig.cancelNow();
        if (point === 'route-wrote') {
          await until(() => rig.logged().some((entry) => entry['event'] === 'request.completed'), 'the server to finish the response');
          rig.cancelNow();
        }
        await asked;
        if (point === 'finished') rig.cancelNow();
        const mergedNow = merged(rig);
        const cancelledFirst = rig.order[0] === 'cancel';
        expect(mergedNow).toBe(!cancelledFirst);
        expect(rig.showing()?.id === 'cancelled').toBe(cancelledFirst);
        if (!mergedNow) expect(rig.snapshot()).toBe(before);
        await until(() => rig.logged().some((entry) => entry['event'] === 'request.completed'), 'the completion log');
        const audited = rig.events.find((event) => event.action === 'graph.expand');
        const aborted = rig.logged().find((entry) => entry['event'] === 'request.completed')?.['aborted'] === true;
        expect(audited?.result).toBe(aborted ? 'failed' : 'success');
        if (aborted) expect(audited?.detail).toEqual({ reason: 'cancelled' });
        if (point === 'source-turn') expect(mergedNow).toBe(false);
        if (point === 'finished') expect(mergedNow).toBe(true);
        await rig.close();
        open = undefined;
      }
    });
  }
});

describe('a template run whose answer reaches the client after the person cancelled', () => {
  it('shows no result when the cancel lands after the whole body was read, and none is merged', async () => {
    const rig = await begin();
    personalise(rig);
    const before = rig.snapshot();
    rig.at.afterBody = () => rig.patterns.cancel();
    rig.patterns.run({ id: PATTERN, params: { ref: { entityType: 'hub', stableId: 'H-1' } } });
    (await rig.nextRead()).answerRows();
    (await rig.nextRead()).answerRows();
    await until(() => rig.patterns.getState().cancelled, 'the cancel');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const view = rig.patterns.getState();
    expect(view.result).toBeUndefined();
    expect(view.failure).toBeUndefined();
    expect(rig.snapshot()).toBe(before);
  });

  it('keeps the answer and ignores a cancel that comes after it', async () => {
    const rig = await begin();
    rig.patterns.run({ id: PATTERN, params: { ref: { entityType: 'hub', stableId: 'H-1' } } });
    const count = await rig.nextRead();
    count.answerRows();
    (await rig.nextRead()).answerRows();
    await until(() => rig.patterns.getState().result !== undefined, 'the result');
    const settled = rig.snapshot();
    rig.patterns.cancel();
    expect(rig.patterns.getState()).toMatchObject({ cancelled: false });
    expect(rig.patterns.getState().result).toBeDefined();
    expect(rig.snapshot()).toBe(settled);
  });

  it('leaves what an earlier add put on the canvas as it was when a cancel lands after the whole body was read', async () => {
    const rig = await begin();
    personalise(rig);
    await runAndAdd(rig);
    const added = rig.snapshot();
    rig.at.afterBody = () => rig.patterns.cancel();
    rig.patterns.run({ id: PATTERN, params: { ref: { entityType: 'hub', stableId: 'H-1' } } });
    (await rig.nextRead()).answerRows();
    (await rig.nextRead()).answerRows();
    await until(() => rig.patterns.getState().cancelled, 'the cancel');
    await until(() => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0, 'the read slots to be free');
    expect(rig.snapshot()).toBe(added);
  });
});
