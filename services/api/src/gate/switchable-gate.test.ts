import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BUDGETS } from './budgets.js';
import { gateRequest, harness, TestExecutor, testCatalog } from '../testing/gate.js';
import { createSwitchableGate, type GateParts as SourceGate } from './switchable-gate.js';
import type { GatePage, GateRequest } from './types.js';

function fakeGate(name: string, hold?: Promise<void>) {
  const closed = vi.fn(() => Promise.resolve());
  const page = (label: string): GatePage => ({ items: [{ label }] } as unknown as GatePage);
  const gate: SourceGate = {
    gate: {
      run: async () => {
        await hold;
        return page(`${name}:run`);
      },
      fileQuery: async () => page(`${name}:file`),
      runMany: async () => [page(`${name}:many`)],
    },
    system: { run: async () => page(`${name}:system`) },
    indexes: { read: async () => 'unverified' },
    catalog: { find: () => undefined, isEnabled: (_template, source) => source === name },
    close: closed,
  };
  return { gate, closed };
}

const REQUEST = {} as GateRequest;
const labelOf = (page: GatePage): unknown => (page.items[0] as { label: string }).label;

describe('the switchable gate', () => {
  it('serves every call, the system runner, the index reader and the catalog from the gate that is current', async () => {
    const first = fakeGate('first');
    const second = fakeGate('second');
    const held = createSwitchableGate(first.gate);
    expect(labelOf(await held.gate.run(REQUEST))).toBe('first:run');
    expect(held.catalog.isEnabled('t', 'first')).toBe(true);
    await held.swap(second.gate);
    expect(labelOf(await held.gate.run(REQUEST))).toBe('second:run');
    expect(labelOf(await held.system.run({ traceId: 't', sourceId: 's', templateId: 't', params: {}, limit: 1 }))).toBe('second:system');
    expect(labelOf((await held.gate.runMany([REQUEST]))[0] as GatePage)).toBe('second:many');
    expect(held.catalog.isEnabled('t', 'second')).toBe(true);
    expect(held.catalog.isEnabled('t', 'first')).toBe(false);
  });

  it('closes the gate it replaces at once when no call is in flight through it', async () => {
    const first = fakeGate('first');
    const held = createSwitchableGate(first.gate);
    await held.swap(fakeGate('second').gate);
    expect(first.closed).toHaveBeenCalledTimes(1);
  });

  it('lets a call that began before the swap end on the old gate, and closes that gate when that call has ended and not before', async () => {
    let release = (): void => undefined;
    const first = fakeGate('first', new Promise<void>((resolve) => (release = resolve)));
    const second = fakeGate('second');
    const held = createSwitchableGate(first.gate);
    const running = held.gate.run(REQUEST);
    const swapped = held.swap(second.gate);
    await Promise.resolve();
    expect(first.closed).not.toHaveBeenCalled();
    expect(labelOf(await held.gate.run(REQUEST))).toBe('second:run');
    release();
    expect(labelOf(await running)).toBe('first:run');
    await swapped;
    expect(first.closed).toHaveBeenCalledTimes(1);
    expect(second.closed).not.toHaveBeenCalled();
  });

  it('counts a call that fails as ended, so the old gate is still closed', async () => {
    let fail = (_error: Error): void => undefined;
    const first = fakeGate('first');
    const failing: SourceGate = { ...first.gate, gate: { ...first.gate.gate, run: () => new Promise<GatePage>((_resolve, reject) => (fail = reject)) } };
    const held = createSwitchableGate(failing);
    const running = held.gate.run(REQUEST);
    const swapped = held.swap(fakeGate('second').gate);
    fail(new Error('read failed'));
    await expect(running).rejects.toThrow('read failed');
    await swapped;
    expect(first.closed).toHaveBeenCalledTimes(1);
  });

  it('closes the current gate and every retired one that is still open when it is closed', async () => {
    let release = (): void => undefined;
    const first = fakeGate('first', new Promise<void>((resolve) => (release = resolve)));
    const second = fakeGate('second');
    const held = createSwitchableGate(first.gate);
    void held.gate.run(REQUEST).catch(() => undefined);
    void held.swap(second.gate);
    await held.close();
    expect(first.closed).toHaveBeenCalledTimes(1);
    expect(second.closed).toHaveBeenCalledTimes(1);
    release();
  });

  describe('over a real gate and a scripted executor', () => {
    const budgetsFor = () => ({ ...DEFAULT_BUDGETS, sourceConcurrency: 1, queueWaitMs: 150 });
    const parts = (executor: TestExecutor) => {
      const real = harness({ executor, budgetsFor });
      const closed = vi.fn(() => Promise.resolve());
      return { parts: { gate: real.gate, system: real.system, indexes: real.indexes, catalog: testCatalog(), close: closed }, closed };
    };
    const titleOf = (page: GatePage): unknown => (page.items[0] as { title: string }).title;

    it('ends a read that was running at the swap with the answer of the old gate, closes the old executor only after that, and ends a read that waited for a slot with SOURCE_BUSY, not a hang', async () => {
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const old = new TestExecutor(async () => {
        await held;
        return { status: 'rows', rows: [{ title: 'old' }] };
      });
      const next = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [{ title: 'new' }] }));
      const oldParts = parts(old);
      const nextParts = parts(next);
      const switchable = createSwitchableGate(oldParts.parts);

      const running = switchable.gate.run(gateRequest());
      await vi.waitFor(() => expect(old.calls).toHaveLength(1));
      const waiting = switchable.gate.run(gateRequest());
      const swapped = switchable.swap(nextParts.parts);

      await expect(waiting).rejects.toMatchObject({ code: 'SOURCE_BUSY' });
      expect(oldParts.closed, 'the old gate is not closed while a read is still running on it').not.toHaveBeenCalled();
      expect(titleOf(await switchable.gate.run(gateRequest()))).toBe('new');

      release();
      expect(titleOf(await running)).toBe('old');
      await swapped;
      expect(oldParts.closed).toHaveBeenCalledTimes(1);
      expect(nextParts.closed).not.toHaveBeenCalled();
    });
  });
});
