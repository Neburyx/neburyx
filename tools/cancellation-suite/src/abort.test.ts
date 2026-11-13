import { afterEach, describe, expect, it } from 'vitest';
import { HUB, HUB_THREE, HUB_TWO, NEIGHBOR_TYPES, PATTERN, personalise, RULE, runAndAdd, startRig, until, type Rig } from './rig.js';
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

  it('keeps what an earlier result added to the graph when a later run is cancelled', async () => {
    rig = await startRig();
    personalise(rig);
    await runAndAdd(rig);
    const added = rig.snapshot();
    rig.patterns.run({ id: PATTERN, params: { ref: { entityType: 'hub', stableId: 'H-1' } } });
    const read = await rig.nextRead();
    rig.patterns.cancel();
    await until(() => read.call.signal?.aborted === true, 'the read to be aborted');
    read.answerRows();
    await until(() => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0, 'the read slots to be free');
    expect(rig.snapshot()).toBe(added);
  });

  it('changes only what a person adds: the loaded items, their result key and the selection, and nothing saved', async () => {
    rig = await startRig();
    personalise(rig);
    const before = JSON.parse(rig.snapshot());
    const savedBefore = rig.saved();
    await runAndAdd(rig);
    const after = JSON.parse(rig.snapshot());
    const differing = Object.keys(after).filter((part) => JSON.stringify(after[part]) !== JSON.stringify(before[part])).sort();
    expect(differing).toEqual(['graph', 'investigation', 'presentation', 'progress'].filter((part) => differing.includes(part)));
    expect(differing).not.toContain('saved');
    expect(rig.saved()).toBe(savedBefore);
    const changed = (part: string, keys: readonly string[]): string[] => Object.keys(after[part]).filter((key) => !keys.includes(key) && JSON.stringify(after[part][key]) !== JSON.stringify(before[part][key]));
    expect(changed('investigation', ['resultKeys', 'nodeRefs', 'edgeRefs'])).toEqual([]);
    expect(changed('presentation', ['selection'])).toEqual([]);
  });
});

describe('cancelling a running pattern run', () => {
  const body = JSON.stringify({ sourceId: 'demo', definition: { anchorType: 'hub', steps: [{ relationshipTypes: ['LINKED'], direction: 'out', arrivesAt: 'leaf' }] }, anchor: { entityType: 'hub', stableId: 'H-1' } });

  it.each([
    ['its estimate', 'pattern-count', 'pattern.count'],
    ['its run', 'pattern', 'pattern.run'],
  ])('aborts the read of %s when the request is aborted, audits the call as failed with the reason cancelled, sends no run after an aborted estimate, stores no answer and frees the slots', async (_name, templateId, action) => {
    rig = await startRig();
    const before = rig.snapshot();
    const controller = new AbortController();
    const sent = fetch(`${rig.base}/v1/patterns/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'cancel-pattern-run-key-1' }, body, signal: controller.signal }).catch(() => undefined);
    let read = await rig.nextRead();
    expect(read.call.templateId).toBe('pattern-count');
    if (templateId === 'pattern') {
      read.fail({ status: 'rows', rows: [{ matches: 1, bounded: false, stopListed: false, supernodes: 0 }] });
      read = await rig.nextRead();
    }
    expect(read.call.templateId).toBe(templateId);
    expect(read.call.signal?.aborted).toBe(false);
    controller.abort();
    await until(() => read.call.signal?.aborted === true, 'the read to be aborted');
    await until(() => rig.events.some((event) => event.action === action && event.detail?.reason === 'cancelled'), 'the audit event');
    expect(rig.events.find((each) => each.action === action)).toMatchObject({ result: 'failed', detail: { reason: 'cancelled' } });
    read.answerRows();
    await sent;
    rig.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (templateId === 'pattern-count') expect(rig.executor.calls.some((call) => call.templateId === 'pattern')).toBe(false);
    const replay = await fetch(`${rig.base}/v1/patterns/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'cancel-pattern-run-key-1' }, body });
    expect(replay.headers.get('idempotent-replay')).toBeNull();
    expect(rig.snapshot()).toBe(before);
    await until(() => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0, 'the read slots to be free');
  });
});

describe('cancelling a running saved pattern run', () => {
  const body = JSON.stringify({ anchor: { entityType: 'hub', stableId: 'H-1' } });
  const saving = JSON.stringify({ sourceId: 'demo', name: 'A saved pattern', kind: 'definition', definition: { anchorType: 'hub', steps: [{ relationshipTypes: ['LINKED'], direction: 'out', arrivesAt: 'leaf' }] } });

  it.each([
    ['its estimate', 'pattern-count', 'pattern.count'],
    ['its run', 'pattern', 'pattern.run'],
  ])('aborts the read of %s when the request is aborted, audits the call as failed with the reason cancelled, records no run, stores no answer and frees the slots', async (_name, templateId, action) => {
    rig = await startRig();
    const made = await fetch(`${rig.base}/v1/patterns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: saving });
    const { id } = (await made.json()) as { id: string };
    const before = rig.snapshot();
    const controller = new AbortController();
    const url = `${rig.base}/v1/patterns/${id}/run`;
    const sent = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'cancel-saved-run-key-1' }, body, signal: controller.signal }).catch(() => undefined);
    let read = await rig.nextRead();
    expect(read.call.templateId).toBe('pattern-count');
    if (templateId === 'pattern') {
      read.fail({ status: 'rows', rows: [{ matches: 1, bounded: false, stopListed: false, supernodes: 0 }] });
      read = await rig.nextRead();
    }
    expect(read.call.templateId).toBe(templateId);
    expect(read.call.signal?.aborted).toBe(false);
    controller.abort();
    await until(() => read.call.signal?.aborted === true, 'the read to be aborted');
    await until(() => rig.events.some((event) => event.action === action && event.detail?.reason === 'cancelled'), 'the audit event');
    expect(rig.events.find((each) => each.action === action)).toMatchObject({ result: 'failed', detail: { reason: 'cancelled' } });
    read.answerRows();
    await sent;
    rig.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const listed = (await (await fetch(`${rig.base}/v1/patterns?sourceId=demo`)).json()) as { items: { lastRunAt: string | null }[] };
    expect(listed.items.map((item) => item.lastRunAt)).toEqual([null]);
    const replay = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'cancel-saved-run-key-1' }, body });
    expect(replay.headers.get('idempotent-replay')).toBeNull();
    expect(rig.snapshot()).toBe(before);
    await until(() => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0, 'the read slots to be free');
  });
});

describe('cancelling a pattern built in the panel', () => {
  const ask = { definition: { anchorType: 'hub', steps: [{ relationshipTypes: ['LINKED'], direction: 'out' as const, arrivesAt: 'leaf' }] }, anchor: { entityType: 'hub', stableId: 'H-1' } };

  it('aborts the estimate read on Cancel, shows no result, ignores an answer that comes after, and leaves the client as it was', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    rig.definitionRuns.run(ask);
    const read = await rig.nextRead();
    expect(read.call.templateId).toBe('pattern-count');
    rig.definitionRuns.cancel();
    await until(() => read.call.signal?.aborted === true, 'the read to be aborted');
    expect(rig.definitionRuns.getState()).toMatchObject({ running: false, cancelled: true, result: undefined, failure: undefined });
    read.answerRows();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rig.definitionRuns.getState().result).toBeUndefined();
    expect(rig.snapshot()).toBe(before);
    await until(() => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0, 'the read slots to be free');
  });

  it('shows QUERY_TIMEOUT when the source times out, with no result, and leaves the client as it was', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    rig.definitionRuns.run(ask);
    (await rig.nextRead()).fail({ status: 'timeout' });
    await until(() => !rig.definitionRuns.getState().running, 'the run to end');
    expect(rig.definitionRuns.getState()).toMatchObject({ failure: { code: 'QUERY_TIMEOUT' }, result: undefined });
    expect(rig.snapshot()).toBe(before);
  });

  it('is aborted by a newer run, and the older answer is never shown', async () => {
    rig = await startRig();
    rig.definitionRuns.run(ask);
    const older = await rig.nextRead();
    rig.definitionRuns.run({ ...ask, anchor: { entityType: 'hub', stableId: 'H-2' } });
    await until(() => older.call.signal?.aborted === true, 'the older read to be aborted');
    const newer = await rig.nextRead();
    older.answerRows();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rig.definitionRuns.getState()).toMatchObject({ running: true, result: undefined, failure: undefined, ask: { anchor: { stableId: 'H-2' } } });
    expect(newer.call.signal?.aborted).toBe(false);
    rig.definitionRuns.cancel();
    await until(() => newer.call.signal?.aborted === true, 'the newer read to be aborted');
  });

  it('is stopped by a change of the builder: the read is aborted and nothing is left on screen', async () => {
    rig = await startRig();
    rig.definitionRuns.run(ask);
    const read = await rig.nextRead();
    rig.definitionRuns.stop();
    await until(() => read.call.signal?.aborted === true, 'the read to be aborted');
    read.answerRows();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rig.definitionRuns.getState()).toMatchObject({ running: false, result: undefined, cancelled: false });
  });
});
