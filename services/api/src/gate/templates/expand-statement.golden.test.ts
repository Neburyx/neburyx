import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseSource, firstSource, load } from '../../testing/mapping.js';
import { allowlistFromMapping } from '../allowlist.js';
import { expandNeighborsTemplate } from './expand-neighbors.js';
import { expandBranchesOf, expandStatementOf } from './expand-statement.js';

/** The statements as the expansion read wrote them before filters and rank existed, kept in a file: an expansion with neither is the same text, so its plans, its cursors and its cost are as they were. */
const golden: Record<string, string> = JSON.parse(readFileSync(new URL('./expand-statement.golden.json', import.meta.url), 'utf8')) as Record<string, string>;

const allowlist = allowlistFromMapping(
  firstSource(
    load(
      baseSource({
        entities: [
          { type: 'hub', label: 'Hub', stable_id: 'hubId' },
          { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
        ],
        relationships: [
          { type: 'A', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt' },
          { type: 'B', from: 'hub', to: 'leaf', observed_at: 'seenAt' },
          { type: 'C', from: 'hub', to: 'leaf', stable_id: 'tieId' },
          { type: 'D', from: 'hub', to: 'leaf' },
          { type: 'L', from: 'hub', to: 'hub' },
        ],
      }),
    ),
  ),
);

describe('the statement of an expansion with no filter and no rank', () => {
  it.each([
    ['hub-leaf-both', 'hub', 'leaf', 'both'],
    ['hub-hub-both', 'hub', 'hub', 'both'],
    ['leaf-hub-in', 'leaf', 'hub', 'in'],
  ] as const)('is the text it had before filters and rank existed: %s (a stored row with an ID, one without, dated and undated, and a row that joins a type to itself)', (name, from, to, direction) => {
    expect(expandStatementOf(allowlist, from, to, expandBranchesOf(allowlist, from, to, undefined, direction))).toBe(golden[name]);
  });

  it('holds the same columns, the same order and no column of a rank', () => {
    const text = golden['hub-leaf-both'] ?? '';
    expect(text).toContain('RETURN a, phase, tk, ts, id, rtype, dir, ntype, flag, members, first, rel, m ORDER BY phase, tk, ts DESC, id DESC, rtype DESC, dir DESC LIMIT $limit + 1');
    expect(text).not.toMatch(/\bsk\b|\bsv\b|\$filters/);
  });
});

describe('the position of the cursor of an unranked page', () => {
  it('holds the same fields as before: the phase, the kind and value of the sort, the ID, the relationship type, the direction and the neighbor type', () => {
    const next = expandNeighborsTemplate.nextPosition;
    const row = { phase: 1, tk: 6, ts: { $type: 'integer', value: '5' }, id: 'x', rtype: 'A', dir: 'out', ntype: null };
    expect(Object.keys(next?.([row as never], 25) ?? {}).sort()).toEqual(['dir', 'id', 'nType', 'phase', 'rtype', 'tk', 'ts']);
    expect(next?.([{ ...row, ts: 7 } as never], 25)).toEqual({ phase: 1, ts: 7, tk: 6, id: 'x', rtype: 'A', dir: 'out', nType: null });
  });

  it('takes the sort value from `sv` for a ranked page, and keeps the observed time out of it', () => {
    const next = expandNeighborsTemplate.nextPosition;
    expect(next?.([{ phase: 1, sk: 6, sv: 9, ts: 3, id: 'x', rtype: 'A', dir: 'out', ntype: null } as never], 25)).toEqual({ phase: 1, ts: 9, tk: 6, id: 'x', rtype: 'A', dir: 'out', nType: null });
  });
});
