import { describe, expect, it } from 'vitest';
import { AssistantPendingStoreError, createMemoryAssistantPendingStore, newPendingId, type PendingBinding, type PendingEntry } from './pending-store.js';

const NOW = 1_000_000;
const LIFETIME = 15 * 60 * 1000;
const WHO: PendingBinding = { userId: 'u-1', investigationId: 'inv-1', sourceId: 'demo', mask: false };
const entry = (over: Partial<PendingEntry> = {}): PendingEntry => ({ id: newPendingId(), ...WHO, expiresAtMs: NOW + LIFETIME, ...over });

describe('the pending confirmations', () => {
  it('holds only who the confirmation is for, where, its status and its expiry: no value, no element, no plan', async () => {
    const store = createMemoryAssistantPendingStore();
    const held = entry();
    await store.add(held, NOW);
    expect(Object.keys(store.rows.get(held.id) ?? {}).sort()).toEqual(['expiresAtMs', 'id', 'investigationId', 'mask', 'sourceId', 'status', 'userId']);
  });

  it('lets exactly one of two claims of an id succeed, and tells the other it is used', async () => {
    const store = createMemoryAssistantPendingStore();
    const held = entry();
    await store.add(held, NOW);
    const results = await Promise.all([store.claim(held.id, WHO, NOW + 1), store.claim(held.id, WHO, NOW + 1)]);
    expect([...results].sort()).toEqual(['claimed', 'used']);
    expect(await store.claim(held.id, WHO, NOW + 2)).toBe('used');
  });

  it('keeps one waiting confirmation per person, across investigations, and reports the one it replaced', async () => {
    const store = createMemoryAssistantPendingStore();
    const first = entry();
    const second = entry({ investigationId: 'inv-2' });
    expect(await store.add(first, NOW)).toEqual({ replaced: undefined });
    expect(await store.add(second, NOW + 1)).toEqual({ replaced: { investigationId: 'inv-1', sourceId: 'demo' } });
    expect(await store.claim(first.id, WHO, NOW + 2)).toBe('dropped');
    expect(await store.claim(second.id, { ...WHO, investigationId: 'inv-2' }, NOW + 2)).toBe('claimed');
    const other = entry({ userId: 'u-2' });
    expect(await store.add(other, NOW)).toEqual({ replaced: undefined });
  });

  it.each([
    ['another person', { ...WHO, userId: 'u-2' }],
    ['another investigation', { ...WHO, investigationId: 'inv-2' }],
    ['another source', { ...WHO, sourceId: 'other' }],
    ['another masking', { ...WHO, mask: true }],
  ])('refuses a claim by %s and leaves the confirmation waiting', async (_name, binding) => {
    const store = createMemoryAssistantPendingStore();
    const held = entry();
    await store.add(held, NOW);
    expect(await store.claim(held.id, binding, NOW + 1)).toBe('other');
    expect(await store.claim(held.id, WHO, NOW + 1)).toBe('claimed');
  });

  it('knows no id it was not given, and refuses one after it is dropped by a new message or a cancel', async () => {
    const store = createMemoryAssistantPendingStore();
    expect(await store.claim(newPendingId(), WHO, NOW)).toBe('unknown');
    const held = entry();
    await store.add(held, NOW);
    expect(await store.drop('u-1', NOW + 1)).toEqual({ investigationId: 'inv-1', sourceId: 'demo' });
    expect(await store.drop('u-1', NOW + 2)).toBeUndefined();
    expect(await store.claim(held.id, WHO, NOW + 3)).toBe('dropped');
  });

  it('deletes the expired rows of a person when that person adds, claims or drops, and never by a timer', async () => {
    const store = createMemoryAssistantPendingStore();
    const old = entry();
    await store.add(old, NOW);
    expect(store.rows.has(old.id)).toBe(true);
    expect(await store.claim(old.id, WHO, NOW + LIFETIME + 1)).toBe('expired');
    expect(store.rows.has(old.id)).toBe(false);
    expect(await store.claim(old.id, WHO, NOW + LIFETIME + 2)).toBe('unknown');
    const older = entry();
    await store.add(older, NOW);
    await store.add(entry(), NOW + LIFETIME + 5);
    expect(store.rows.has(older.id)).toBe(false);
    const gone = entry();
    await store.add(gone, NOW + LIFETIME + 10);
    await store.drop('u-1', NOW + 2 * LIFETIME + 20);
    expect(store.rows.has(gone.id)).toBe(false);
  });

  it('fails closed when the store cannot be reached', async () => {
    const store = createMemoryAssistantPendingStore();
    store.failing = true;
    await expect(store.add(entry(), NOW)).rejects.toBeInstanceOf(AssistantPendingStoreError);
    await expect(store.claim(newPendingId(), WHO, NOW)).rejects.toBeInstanceOf(AssistantPendingStoreError);
    await expect(store.drop('u-1', NOW)).rejects.toBeInstanceOf(AssistantPendingStoreError);
  });
});
