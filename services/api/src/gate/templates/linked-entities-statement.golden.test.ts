import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseSource, firstSource, load } from '../../testing/mapping.js';
import { allowlistFromMapping } from '../allowlist.js';
import { linkedEntitiesRequestOf, linkedEntitiesStatementOf } from './linked-entities-statement.js';

/** The statements of the linked-entities template, kept in a file: a change to one is a change to a plan, a cost and a bound, and is made on purpose. */
export const golden: Record<string, string> = JSON.parse(readFileSync(new URL('./linked-entities-statement.golden.json', import.meta.url), 'utf8')) as Record<string, string>;

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
};

describe('the statement of a linked-entities run', () => {
  it('has a golden text for each case, and no other', () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(CASES).sort());
  });

  it.each(Object.entries(CASES))('is the text in the file: %s', (name, params) => {
    expect(linkedEntitiesStatementOf(allowlist, linkedEntitiesRequestOf(allowlist, params))).toBe(golden[name]);
  });
});
