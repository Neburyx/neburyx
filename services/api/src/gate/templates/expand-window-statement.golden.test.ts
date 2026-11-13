import { readFileSync } from 'node:fs';
import type { ExpandRank } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { baseSource, firstSource, load } from '../../testing/mapping.js';
import { allowlistFromMapping } from '../allowlist.js';
import { expandBranchesOf, expandCountStatementOf, expandStatementOf } from './expand-statement.js';

/** The statements of an expansion with a window, kept in a file: a change to one is a change to a plan and a cost, and is made on purpose. */
export const golden: Record<string, string> = JSON.parse(readFileSync(new URL('./expand-window-statement.golden.json', import.meta.url), 'utf8')) as Record<string, string>;

const allowlist = allowlistFromMapping(
  firstSource(
    load(
      baseSource({
        entities: [
          { type: 'hub', label: 'Hub', stable_id: 'hubId' },
          { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
        ],
        relationships: [
          { type: 'A', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt', sortable: ['points'] },
          { type: 'B', from: 'hub', to: 'leaf', observed_at: 'seenAt' },
          { type: 'C', from: 'hub', to: 'leaf', stable_id: 'tieId' },
          { type: 'D', from: 'hub', to: 'leaf' },
        ],
      }),
    ),
  ),
);

interface Case {
  readonly relTypes: readonly string[];
  readonly rank?: ExpandRank;
  readonly count?: true;
}

export const CASES: Readonly<Record<string, Case>> = {
  'stored-dated': { relTypes: ['A'] },
  'aggregate-dated': { relTypes: ['B'] },
  'stored-and-aggregate-dated': { relTypes: ['A', 'B'] },
  'untimed-stored': { relTypes: ['C'] },
  'untimed-aggregate': { relTypes: ['D'] },
  'timed-and-untimed': { relTypes: ['A', 'C', 'D'] },
  'ranked': { relTypes: ['A'], rank: { on: 'relationship', property: 'points', order: 'asc' } },
  'count-timed-and-untimed': { relTypes: ['A', 'B', 'C'], count: true },
};

export const statementOf = (name: string): string => {
  const given = CASES[name];
  if (given === undefined) throw new Error('no such case');
  const branches = expandBranchesOf(allowlist, 'hub', 'leaf', given.relTypes, 'out');
  return given.count === true ? expandCountStatementOf(allowlist, 'hub', 'leaf', branches, [], true) : expandStatementOf(allowlist, 'hub', 'leaf', branches, [], given.rank, true);
};

describe('the statement of an expansion with a window', () => {
  it('has a golden text for each case, and no other', () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(CASES).sort());
  });

  it.each(Object.keys(CASES))('is the text in the file: %s', (name) => {
    expect(statementOf(name)).toBe(golden[name]);
  });

  it('keeps the window conditions to the branches whose relationship type has an observed time, and compares them as instants with the two instants as parameters', () => {
    const text = statementOf('timed-and-untimed');
    expect(text).toContain('>= datetime($windowFrom)');
    expect(text.match(/>= datetime\(\$windowFrom\)/g)?.length).toBeGreaterThan(0);
    const untimed = statementOf('untimed-stored');
    expect(untimed).not.toContain('windowFrom');
    expect(untimed).not.toContain('seenAt');
    for (const name of Object.keys(CASES)) expect(statementOf(name)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('is the unwindowed statement for a branch with no observed time', () => {
    const branches = expandBranchesOf(allowlist, 'hub', 'leaf', ['C', 'D'], 'out');
    expect(expandStatementOf(allowlist, 'hub', 'leaf', branches, [], undefined, true)).toBe(expandStatementOf(allowlist, 'hub', 'leaf', branches));
  });
});
