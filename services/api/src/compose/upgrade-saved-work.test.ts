import { describe, expect, it } from 'vitest';
import { compareRestoredView, compareSavedWork, digestOf, keeps, splitReference, type SavedWork } from './upgrade-saved-work.js';

const work = (overrides: Partial<SavedWork> = {}): SavedWork => ({
  investigation: { ok: true, value: { id: 'i-1', title: 'T', caseRef: 'C', status: 'open', sourceId: 'banking-demo', createdAt: '2026-11-16T00:00:00.000Z', version: 3 } },
  draft: { ok: true, value: { version: 4, layout: { nodes: [{ id: 'a' }] }, queryContext: { steps: [] }, notes: 'a note', basedOnViewId: 'v-1' } },
  views: { ok: true, value: [{ id: 'v-1', name: 'first', notes: 'n', version: 1 }] },
  ...overrides,
});

describe('comparing saved work before and after an upgrade', () => {
  it('finds no difference in equal work', () => {
    expect(compareSavedWork(work(), work())).toEqual([]);
  });

  it('allows a field that only the newer build holds, in the record, the draft and a view', () => {
    const after = work({
      investigation: { ok: true, value: { id: 'i-1', title: 'T', caseRef: 'C', status: 'open', sourceId: 'banking-demo', createdAt: '2026-11-16T00:00:00.000Z', addedLater: true } },
      draft: { ok: true, value: { version: 4, layout: { nodes: [{ id: 'a', extra: 1 }] }, queryContext: { steps: [] }, notes: 'a note', basedOnViewId: 'v-1', more: 1 } },
      views: { ok: true, value: [{ id: 'v-1', name: 'first', notes: 'n', version: 1, other: 2 }] },
    });
    expect(compareSavedWork(work(), after)).toEqual([]);
  });

  it('names a rewritten draft document', () => {
    const after = work({ draft: { ok: true, value: { version: 4, layout: { nodes: [] }, queryContext: { steps: [] }, notes: 'changed', basedOnViewId: 'v-1' } } });
    expect(compareSavedWork(work(), after)).toEqual(['draft document layout: changed', 'draft document notes: changed']);
  });

  it('names a changed or missing named view', () => {
    expect(compareSavedWork(work(), work({ views: { ok: true, value: [{ id: 'v-1', name: 'renamed', notes: 'n', version: 1 }] } }))).toEqual(['named view: the saved views changed (1 before, 1 after)']);
    expect(compareSavedWork(work(), work({ views: { ok: true, value: [] } }))).toEqual(['named view: the saved views changed (1 before, 0 after)']);
  });

  it('names a changed investigation record', () => {
    const after = work({ investigation: { ok: true, value: { id: 'i-1', title: 'Other', caseRef: 'C', status: 'open', sourceId: 'banking-demo', createdAt: '2026-11-16T00:00:00.000Z' } } });
    expect(compareSavedWork(work(), after)).toEqual(['investigation: the record changed']);
  });

  it('counts a read that fails after the upgrade as a difference that names the draft and the named view', () => {
    const failed = { ok: false, error: 'HTTP 500' } as const;
    expect(compareSavedWork(work(), work({ investigation: failed, draft: failed, views: failed }))).toEqual([
      'investigation: read failed after the upgrade (HTTP 500)',
      'draft: read failed after the upgrade (HTTP 500)',
      'named view: read failed after the upgrade (HTTP 500)',
    ]);
  });

  it('refuses to compare when the work was not read before', () => {
    expect(compareSavedWork(work({ views: { ok: false, error: 'HTTP 404' } }), work())).toEqual(['the work to compare was not read before the upgrade']);
  });

  it('keeps arrays of different length apart and compares nested values', () => {
    expect(keeps([1, 2], [1])).toBe(false);
    expect(keeps({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(true);
    expect(keeps({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });
});

describe('the reference of the previous image', () => {
  it('splits a registry reference into the name and the tag', () => {
    expect(splitReference('ghcr.io/neburyx/neburyx:0.1.0')).toEqual({ image: 'ghcr.io/neburyx/neburyx', tag: '0.1.0' });
    expect(splitReference('localhost:5000/team/app:1.2')).toEqual({ image: 'localhost:5000/team/app', tag: '1.2' });
  });

  it.each(['ghcr.io/neburyx/neburyx', 'name:', ':tag', 'localhost:5000/name'])('refuses %s, which has no tag', (reference) => {
    expect(() => splitReference(reference)).toThrow('NEBURYX_UPGRADE_FROM');
  });

  it('reads the digest of the reference\'s own repository', () => {
    expect(digestOf(['other/name@sha256:aaa', 'ghcr.io/neburyx/neburyx@sha256:bbb'], 'ghcr.io/neburyx/neburyx:0.1.0')).toBe('sha256:bbb');
    expect(digestOf([], 'ghcr.io/neburyx/neburyx:0.1.0')).toBeUndefined();
  });
});

describe('comparing the layout a view restores', () => {
  const saved = { nodes: [{ id: 'a', x: 1, y: 2 }], edges: [{ id: 'e' }], viewport: { zoom: 1, x: 0, y: 0 } };

  it('finds no difference when the restored layout holds what was saved, even with a field added later', () => {
    expect(compareRestoredView(saved, { ok: true, value: { ...saved, canvas: { width: 1, height: 2 } } })).toEqual([]);
  });

  it('names a moved node, a lost edge and a failed restore', () => {
    expect(compareRestoredView(saved, { ok: true, value: { ...saved, nodes: [{ id: 'a', x: 9, y: 2 }] } })).toHaveLength(1);
    expect(compareRestoredView(saved, { ok: true, value: { ...saved, edges: [] } })).toHaveLength(1);
    expect(compareRestoredView(saved, { ok: false, error: 'HTTP 404' })).toEqual(['named view: restore failed after the upgrade (HTTP 404)']);
  });
});
