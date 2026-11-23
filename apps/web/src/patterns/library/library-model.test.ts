import { describe, expect, it } from 'vitest';
import type { ListedPattern } from '@neburyx/contracts';
import { savedRowOf } from './library-model.js';

const nameOf = (type: string): string => type;
// the assertion fills only the fields savedRowOf reads; a full ListedPattern adds nothing to these cases
const saved = (over: Record<string, unknown>) =>
  ({ id: 'i', name: 'n', kind: 'definition', definition: { anchorType: 'kind-a', steps: [] }, visibility: 'private', ownedByYou: true, owner: { name: 'Pat' }, lastRunAt: null, availability: { status: 'available' }, ...over }) as unknown as ListedPattern;

describe('whether the library marks a saved pattern as shared', () => {
  it('is not for your own private pattern, and is for your pattern you shared and for a pattern someone shared with you', () => {
    expect(savedRowOf(saved({}), undefined, nameOf, 0).shared).toBe(false);
    expect(savedRowOf(saved({ visibility: 'shared' }), undefined, nameOf, 0).shared).toBe(true);
    expect(savedRowOf(saved({ ownedByYou: false, visibility: 'shared' }), undefined, nameOf, 0).shared).toBe(true);
  });
});
