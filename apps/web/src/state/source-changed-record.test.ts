import { describe, expect, it } from 'vitest';
import { exportBlockedOf, isSourceChanged, readOnlyOf } from './investigation-state.js';
import { lifecycleActionsOf } from '../lifecycle/menu-items.js';

describe('what a changed source does to the client record', () => {
  it.each([
    ['open', 'available', false],
    ['open', undefined, false],
    ['open', 'repointed', true],
    ['open', 'removed', true],
    ['closed', 'available', true],
    ['archived', 'repointed', true],
  ] as const)('reads a %s investigation with source state %s as read-only: %s', (status, sourceState, expected) => {
    expect(readOnlyOf(status, sourceState)).toBe(expected);
  });

  it('dims Export from the source state and not from the status: a closed or archived investigation still exports, a changed source does not', () => {
    const record = (sourceState?: 'available' | 'repointed' | 'removed') => ({ sourceState });
    expect(exportBlockedOf(record('repointed'))).toBe(true);
    expect(exportBlockedOf(record('removed'))).toBe(true);
    expect(exportBlockedOf(record('available'))).toBe(false);
    expect(exportBlockedOf(record(undefined))).toBe(false);
    expect(exportBlockedOf(null)).toBe(false);
    expect(isSourceChanged('available')).toBe(false);
  });

  it('keeps Close, Archive and Delete in the menu of an open investigation whose source changed, and dims Rename with its own reason', () => {
    const items = lifecycleActionsOf('open', false, true);
    expect(items.map((item) => [item.id, item.disabled])).toEqual([['rename', true], ['close', false], ['archive', false], ['delete', false]]);
    expect(items[0]?.description).toBe('Not available while the source has changed.');
    expect(lifecycleActionsOf('closed', false, true)[0]?.description).toBe('Reopen to rename.');
    expect(lifecycleActionsOf('open', false, false)[0]).toMatchObject({ disabled: false });
  });
});
