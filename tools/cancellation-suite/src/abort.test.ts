import { afterEach, describe, expect, it } from 'vitest';
import { HUB, HUB_THREE, HUB_TWO, NEIGHBOR_TYPES, PATTERN, personalise, RULE, startRig, until, type Rig } from './rig.js';
import { elementKey } from '../../../apps/web/src/state/keys.js';
import { cancelledHeadline } from '../../../apps/web/src/banner/copy.js';
import { EXPAND_NEIGHBORS_ID } from '../../../services/api/src/gate/templates/expand-neighbors.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
});

const expandReads = (): number => rig.executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID).length;

describe('cancelling a running expansion', () => {
  it('leaves the client as it was even when the source answers afterwards, and offers Run again', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const asked = rig.expand.expand(HUB, ['leaf']);
    const read = await rig.nextRead();
    await rig.pressCancel();
    expect(rig.showing()).toEqual({ id: 'cancelled', headline: cancelledHeadline(), actions: ['run-again'] });
    read.answerRows();
    await asked;
    expect(rig.snapshot()).toBe(before);
  });

  it('writes no answer, audits the request as failed with the reason cancelled, aborts the read and frees the slots', async () => {
    rig = await startRig();
    const asked = rig.expand.expand(HUB, ['leaf']);
    const read = await rig.nextRead();
    expect(read.call.signal?.aborted).toBe(false);
    await rig.pressCancel();
    await until(() => read.call.signal?.aborted === true, 'the read to be aborted');
    await until(() => rig.events.some((event) => event.action === 'graph.expand'), 'the audit event');
    const event = rig.events.find((each) => each.action === 'graph.expand');
    expect(event).toMatchObject({ result: 'failed', detail: { reason: 'cancelled' } });
    await until(() => rig.logged().some((entry) => entry['event'] === 'request.completed'), 'the completion log');
    expect(rig.logged().find((entry) => entry['event'] === 'request.completed')).toMatchObject({ aborted: true });
    expect(rig.logged().map((entry) => entry['event'])).not.toContain('request.failed');
    await asked;
    await until(() => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0, 'the read slots to be free');
    const next = rig.expand.expand(HUB, ['leaf']);
    (await rig.nextRead()).answerRows();
    expect(await next).toBe('sent');
  });

  it('reads no further type once the person cancels between the reads of an expansion of three types', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const asked = rig.expand.expand(HUB, [...NEIGHBOR_TYPES]);
    (await rig.nextRead()).answerRows();
    const second = await rig.nextRead();
    expect(expandReads()).toBe(2);
    await rig.pressCancel();
    await until(() => second.call.signal?.aborted === true, 'the second read to be aborted');
    await asked;
    expect(expandReads()).toBe(2);
    expect(rig.snapshot()).toBe(before);
  });

  it('keeps the cursor and the loaded count of a load more that was cancelled, and the next one continues from them', async () => {
    rig = await startRig();
    rig.expand.setPageSize(HUB, 1);
    const first = rig.expand.expand(HUB, ['leaf']);
    (await rig.nextRead()).answerRows(2);
    await first;
    const cursor = rig.expand.of(HUB).types.get('leaf')?.cursor;
    expect(cursor).toBeDefined();
    const before = rig.snapshot();
    const more = rig.expand.loadMore(HUB, 'leaf');
    const read = await rig.nextRead();
    await rig.pressCancel();
    read.answerRows(2);
    await more;
    expect(rig.snapshot()).toBe(before);
    expect(rig.expand.of(HUB).types.get('leaf')?.cursor).toBe(cursor);
    const again = rig.expand.loadMore(HUB, 'leaf');
    const resumed = await rig.nextRead();
    const asks = rig.bodies.filter((body) => body.includes('cursors'));
    expect(asks).toHaveLength(2);
    expect(asks[1]).toBe(asks[0]);
    resumed.answerRows(1);
    expect(await again).toBe('sent');
  });

  it('stores no degree preview of a cancelled preview, in the client or in the API\'s cache, while an answered one is served from the cache', async () => {
    rig = await startRig();
    const previewReads = (): number => rig.executor.calls.filter((call) => call.templateId.startsWith('degree-preview')).length;
    const answeredOne = rig.preview.forNode(HUB, false);
    (await rig.nextRead()).answerRows();
    await until(() => answeredOne.getState().phase === 'ready', 'the preview to be answered');
    const afterAnswer = previewReads();
    answeredOne.reload();
    await until(() => answeredOne.getState().phase === 'ready', 'the second ask to be answered');
    expect(previewReads()).toBe(afterAnswer);

    const request = rig.preview.forNode(HUB_TWO, false);
    const read = await rig.nextRead();
    await rig.pressCancel();
    await until(() => read.call.signal?.aborted === true, 'the preview read to be aborted');
    read.answerRows();
    await until(() => request.getState().phase !== 'loading', 'the preview request to end');
    expect(rig.preview.held(HUB_TWO, false)).toBeUndefined();
    const reads = previewReads();
    request.reload();
    const again = await rig.nextRead();
    expect(previewReads()).toBeGreaterThan(reads);
    again.answerRows();
  });

  it('writes nothing to the saved investigations', async () => {
    rig = await startRig();
    const savedBefore = rig.saved();
    const asked = rig.expand.expand(HUB, ['leaf']);
    await rig.nextRead();
    await rig.pressCancel();
    await asked;
    expect(rig.saved()).toBe(savedBefore);
    expect(rig.requests.filter((request) => request.includes('/v1/investigations'))).toEqual([]);
  });
});

describe('cancelling the read of the rule-derived neighbors', () => {
  it('aborts the read, audits it failed with the reason cancelled, holds no answer, adds nothing to the view and leaves the client as it was', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const request = rig.derived.forNode(HUB, false);
    const read = await rig.nextRead();
    expect(read.call.templateId).toBe('derived-rule-run');
    request.cancel();
    await until(() => read.call.signal?.aborted === true, 'the read to be aborted');
    read.answerRows();
    await until(() => rig.events.some((event) => event.action === 'entity.derived_rule_run'), 'the audit event');
    expect(rig.events.find((each) => each.action === 'entity.derived_rule_run')).toMatchObject({ result: 'failed', detail: { reason: 'cancelled' } });
    await until(() => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0, 'the read slots to be free');
    expect(request.getState().phase).toBe('idle');
    expect(rig.derived.held(HUB, RULE)).toBeUndefined();
    expect(rig.derived.show(HUB, RULE)).toBeUndefined();
    expect(rig.snapshot()).toBe(before);
  });
});

describe('a request that waits for a slot', () => {
  it('leaves the queue when the person cancels, reads nothing for it, and the request behind it is the next read', async () => {
    rig = await startRig({ delayMs: 300, budgets: { source_concurrency: 1, user_concurrency: 4, queue_wait_ms: 5000 } });
    const queue = (): { readonly atSource: number; readonly behindThem: number } => {
      const slots = rig.slots.inspect();
      return { atSource: slots.sources.get('demo')?.waiting ?? 0, behindThem: [...slots.users.values()].reduce((sum, each) => sum + each.waiting, 0) };
    };
    const holder = rig.expand.expand(HUB, ['leaf']);
    const held = await rig.nextRead();
    const cancelled = rig.expand.expand(HUB_TWO, ['part']);
    await until(() => rig.showing()?.headline.includes('H-2') === true, 'the second request to show as Running');
    const behind = rig.expand.expand(HUB_THREE, ['item']);
    await until(() => queue().atSource === 1 && queue().behindThem === 1, 'one request to wait for the source and one behind it');
    expect(rig.cancelNow()).toBe(true);
    await cancelled;
    await until(() => queue().behindThem === 0 && queue().atSource === 1, 'the request behind to take the place of the cancelled one');
    expect(rig.executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID)).toHaveLength(1);
    held.answerRows();
    await holder;
    const next = await rig.nextRead();
    expect(next.neighborType).toBe('item');
    next.answerRows();
    expect(await behind).toBe('sent');
    expect(rig.executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID).map((call) => call.parameters['neighborType'])).toEqual(['leaf', 'item']);
  });
});

describe('the snapshot', () => {
  it('differs when one node is added, one item is hidden or one cursor moves, and not otherwise', async () => {
    rig = await startRig();
    const before = rig.snapshot();
    expect(rig.snapshot()).toBe(before);
    rig.state.hide([elementKey(HUB)]);
    expect(rig.snapshot()).not.toBe(before);
    rig.state.presentation.showAllHidden();
    expect(rig.snapshot()).toBe(before);
    rig.expand.setPageSize(HUB, 7);
    expect(rig.snapshot()).not.toBe(before);
    const other = await startRig();
    try {
      const asked = other.expand.expand(HUB, ['leaf']);
      (await other.nextRead()).answerRows();
      await asked;
      expect(other.snapshot()).not.toBe(before);
    } finally {
      await other.close();
    }
  });
});

describe('cancelling a running template run', () => {
  it('aborts the estimate read, shows no result and leaves the client as it was, also when the source answers afterwards', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    rig.patterns.run({ id: PATTERN, params: { ref: { entityType: 'hub', stableId: 'H-1' } } });
    const read = await rig.nextRead();
    expect(read.call.templateId).toBe('shared-attribute-count');
    rig.patterns.cancel();
    await until(() => read.call.signal?.aborted === true, 'the read to be aborted');
    expect(rig.patterns.getState()).toMatchObject({ running: false, cancelled: true, result: undefined, failure: undefined });
    read.answerRows();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rig.patterns.getState().result).toBeUndefined();
    expect(rig.snapshot()).toBe(before);
    await until(() => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0, 'the read slots to be free');
  });
});
