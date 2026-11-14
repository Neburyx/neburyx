import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseSource, firstSource, load } from '../../testing/mapping.js';
import { allowlistFromMapping } from '../allowlist.js';
import { linkedEntitiesCountStatementOf, linkedEntitiesRequestOf, linkedEntitiesStatementOf } from './linked-entities-statement.js';

/** The statements of the linked-entities template, kept in a file: a change to one is a change to a plan, a cost and a bound, and is made on purpose. */
export const golden: Record<string, string> = JSON.parse(readFileSync(new URL('./linked-entities-statement.golden.json', import.meta.url), 'utf8')) as Record<string, string>;

/** The statements of the count (the probe) of each case; the texts of the cases that ended at the target before the far-target cases were added are the texts they had then. */
const countGolden: Record<string, string> = JSON.parse(readFileSync(new URL('./linked-entities-count-statement.golden.json', import.meta.url), 'utf8')) as Record<string, string>;

const allowlist = allowlistFromMapping(
  firstSource(
    load(
      baseSource({
        entities: [
          { type: 'hub', label: 'Hub', stable_id: 'hubId' },
          { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
        ],
        relationships: [
          { type: 'A', from: 'hub', to: 'hub', stable_id: 'relId', observed_at: 'seenAt' },
          { type: 'B', from: 'hub', to: 'hub' },
          { type: 'C', from: 'hub', to: 'leaf', stable_id: 'tieId' },
          { type: 'D', from: 'leaf', to: 'hub', stable_id: 'backId' },
        ],
        derived: [{ id: 'shared-leaf', from: 'hub', to: 'hub', via: ['C', 'leaf', 'C'], rule_version: 1, stop_list_property: 'isHot' }],
      }),
    ),
  ),
);

const WINDOW = { windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' };
const base = { entityType: 'hub', stableId: 'H-1', targetType: 'hub' };

export const CASES: Readonly<Record<string, Record<string, unknown>>> = {
  'one-out-single': { ...base, via: ['A'], direction: 'out', maxHops: 1 },
  'one-in-single': { ...base, via: ['A'], direction: 'in', maxHops: 1 },
  'one-both-single': { ...base, via: ['A'], direction: 'both', maxHops: 1 },
  'one-out-two-types': { ...base, via: ['A', 'B'], direction: 'out', maxHops: 1 },
  'one-in-two-types': { ...base, via: ['A', 'B'], direction: 'in', maxHops: 1 },
  'one-both-two-types': { ...base, via: ['A', 'B'], direction: 'both', maxHops: 1 },
  'one-out-aggregate': { ...base, via: ['B'], direction: 'out', maxHops: 1 },
  'two-out': { ...base, via: ['A'], direction: 'out', maxHops: 2 },
  'two-in': { ...base, via: ['A'], direction: 'in', maxHops: 2 },
  'two-both': { ...base, via: ['A'], direction: 'both', maxHops: 2 },
  'two-window': { ...base, via: ['A'], direction: 'out', maxHops: 2, ...WINDOW },
  'two-stop-list-and-aggregate': { ...base, via: ['C', 'D', 'B'], direction: 'out', maxHops: 2 },
  // the target is two steps from the anchor: no first step ends at it
  'two-far-target': { entityType: 'leaf', stableId: 'L-1', targetType: 'leaf', via: ['D', 'C'], direction: 'out', maxHops: 2 },
  'two-far-target-both': { entityType: 'leaf', stableId: 'L-1', targetType: 'leaf', via: ['D', 'C'], direction: 'both', maxHops: 2 },
};

describe('the statement of a linked-entities run', () => {
  it('has a golden text for each case, and no other', () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(CASES).sort());
  });

  it.each(Object.entries(CASES))('is the text in the file: %s', (name, params) => {
    expect(linkedEntitiesStatementOf(allowlist, linkedEntitiesRequestOf(allowlist, params))).toBe(golden[name]);
  });

  it('has a golden count text for each case, and no other', () => {
    expect(Object.keys(countGolden).sort()).toEqual(Object.keys(CASES).sort());
  });

  it.each(Object.entries(CASES))('has the count text in the file: %s', (name, params) => {
    expect(linkedEntitiesCountStatementOf(allowlist, linkedEntitiesRequestOf(allowlist, params))).toBe(countGolden[name]);
  });

  it.each(Object.entries(CASES))('holds no empty block and no union with nothing on one side, in the run and in its count: %s', (_name, params) => {
    const request = linkedEntitiesRequestOf(allowlist, params);
    for (const text of [linkedEntitiesStatementOf(allowlist, request), linkedEntitiesCountStatementOf(allowlist, request)]) {
      expect(text).not.toMatch(/\{\s*\}/);
      expect(text).not.toMatch(/UNION ALL\s*(?:\}|$)/);
      expect(text).not.toMatch(/\{\s*UNION ALL/);
    }
  });
});
