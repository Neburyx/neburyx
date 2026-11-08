import { describe, expect, it } from 'vitest';
import { expectedOrder } from './order.js';

describe('the order the fixture must come in', () => {
  it('lists every row of each read set once', () => {
    expect(expectedOrder('dated', 20)).toHaveLength(20);
    expect(expectedOrder('undated', 20)).toHaveLength(20);
    expect(expectedOrder('aggregate', 20)).toHaveLength(2);
    expect(expectedOrder('plain', 20)).toHaveLength(20);
    expect(expectedOrder('all', 20)).toHaveLength(20 + 2 + 20 + 20);
    expect(new Set(expectedOrder('all', 20)).size).toBe(62);
  });

  it('puts the latest dated row first, undated rows by ID text and the phases in order', () => {
    expect(expectedOrder('dated', 20).slice(0, 2)).toEqual(['LINKED:l-hub-20-20', 'LINKED:l-hub-20-19']);
    expect(expectedOrder('undated', 20).slice(0, 3)).toEqual(['TIED:t-hub-20-9', 'TIED:t-hub-20-8', 'TIED:t-hub-20-7']);
    expect(expectedOrder('aggregate', 20)).toEqual(['NOTED:hub-20-1', 'NOTED:hub-20-2']);
    const all = expectedOrder('all', 20);
    expect(all.findIndex((label) => label.startsWith('NOTED'))).toBe(20);
    expect(all.findIndex((label) => label.startsWith('TIED'))).toBe(22);
    expect(all.findIndex((label) => label.startsWith('PAID'))).toBe(42);
  });
});
