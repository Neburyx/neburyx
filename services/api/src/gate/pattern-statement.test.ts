import { describe, expect, it } from 'vitest';
import { patternAllowlist, parsedPatternParams, step } from '../testing/pattern-fixtures.js';
import { patternRequestOf } from './templates/pattern-request.js';
import { patternStatementOf } from './templates/pattern-statement.js';

const allowlist = patternAllowlist();
const compile = (steps: Record<string, unknown>[], over: Record<string, unknown> = {}, list = allowlist): string => patternStatementOf(list, patternRequestOf(list, parsedPatternParams(steps, over)));

const WINDOW = { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' };
const regionIs = { on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'north' } };
const regionIn = { on: 'neighbor', property: 'region', op: 'in', values: [{ kind: 'text', value: 'north' }, { kind: 'text', value: 'south' }] };
const rankBetween = { on: 'neighbor', property: 'rank', op: 'between', from: { kind: 'number', value: 1 }, to: { kind: 'number', value: 9 } };
const channelIs = { on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'web' } };
const TOOL = step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' });
const BACK = step({ relationshipTypes: ['USES_TOOL'], direction: 'in', arrivesAt: 'maker' });

const GOLDEN: readonly (readonly [string, Record<string, unknown>[]])[] = [
  ['one-step', [step()]],
  ['two-steps', [TOOL, BACK]],
  ['four-steps', [TOOL, step({ relationshipTypes: ['STOCKED_AT'], arrivesAt: 'shop' }), step({ relationshipTypes: ['ENDORSES'], arrivesAt: 'maker' }), step()]],
  ['list-of-types', [step({ relationshipTypes: ['LINKS', 'TRUSTS'] })]],
  ['direction-in', [step({ direction: 'in' })]],
  ['direction-both', [step({ direction: 'both' })]],
  ['node-condition-eq', [step({ conditions: [regionIs] })]],
  ['node-condition-in', [step({ conditions: [regionIn] })]],
  ['node-condition-between', [step({ conditions: [rankBetween] })]],
  ['relationship-condition', [step({ conditions: [channelIs] })]],
  ['window', [step({ ...WINDOW })]],
  ['window-mixed-types', [step({ relationshipTypes: ['LINKS', 'TRUSTS'], ...WINDOW })]],
];

describe('the statement of a pattern', () => {
  it.each(GOLDEN)('is pinned for %s', async (name, steps) => {
    await expect(compile(steps)).toMatchFileSnapshot(`./pattern-golden/${name}.cypher`);
  });

  it('is a pure function of the shape: the same request twice gives the same text, and a frozen request is read as it is', () => {
    const request = Object.freeze(patternRequestOf(allowlist, parsedPatternParams([TOOL, BACK])));
    expect(patternStatementOf(allowlist, request)).toBe(patternStatementOf(allowlist, request));
  });

  it('is byte equal for requests that differ only in values, and holds none of them', () => {
    const sentinel = 'zz-sentinel-9f3a';
    const first = compile([step({ conditions: [regionIs, rankBetween, channelIs], ...WINDOW }), step({ conditions: [regionIn] })], { stableId: 'A-1' });
    const second = compile(
      [
        step({ conditions: [{ ...regionIs, value: { kind: 'text', value: sentinel } }, { ...rankBetween, from: { kind: 'number', value: 55 }, to: { kind: 'number', value: 77 } }, { ...channelIs, value: { kind: 'text', value: sentinel } }], windowFrom: '2030-05-05T00:00:00Z', windowTo: '2030-06-06T00:00:00Z' }),
        step({ conditions: [{ ...regionIn, values: [{ kind: 'text', value: sentinel }, { kind: 'text', value: `${sentinel}-2` }] }] }),
      ],
      { stableId: sentinel },
    );
    expect(second).toBe(first);
    for (const text of [first, second]) {
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain('2030');
      expect(text).not.toContain('north');
      expect(text).not.toContain('A-1');
    }
  });

  it('changes with the shape: a condition form, a window and the number of steps each change the text', () => {
    const base = compile([step()]);
    expect(compile([step({ conditions: [regionIs] })])).not.toBe(base);
    expect(compile([step({ conditions: [regionIn] })])).not.toBe(compile([step({ conditions: [regionIs] })]));
    expect(compile([step({ conditions: [{ ...rankBetween, to: undefined }] })])).not.toBe(compile([step({ conditions: [rankBetween] })]));
    expect(compile([step({ ...WINDOW })])).not.toBe(base);
    expect(compile([step(), step()])).not.toBe(base);
  });

  it('reads no more than the count cap plus one at a step, and every match is inside a block that is cut', () => {
    for (const [, steps] of GOLDEN) {
      const text = compile(steps);
      const lines = text.split('\n');
      const matches = text.match(/MATCH /g)?.length ?? 0;
      expect(matches).toBeGreaterThan(0);
      for (const line of lines) {
        if (line.startsWith('MATCH (a:')) {
          expect(line).toMatch(/LIMIT 1$/);
          continue;
        }
        const blocks = line.match(/CALL \{/g)?.length ?? 0;
        if (line.includes('MATCH ')) {
          expect(blocks).toBeGreaterThan(0);
          expect(line).toMatch(/LIMIT \$countCap \+ 1|LIMIT \$limit \+ 1/);
        }
      }
      expect(text).toContain('LIMIT $limit + 1');
      expect(text.match(/LIMIT \$countCap \+ 1/g)?.length ?? 0).toBeGreaterThanOrEqual(steps.length);
    }
  });

  it('checks the nodes a step starts from for the count cap and the stop-list, only between steps', () => {
    expect(compile([step()])).not.toContain('degree');
    const two = compile([TOOL, BACK]);
    expect(two).toContain('c.degree > $countCap');
    expect(two).toContain('coalesce(n.`isCommon`, false) = true');
    const stops = (text: string): number => text.match(/coalesce\(/g)?.length ?? 0;
    expect(stops(compile([step(), step()]))).toBe(0);
  });

  it('orders the matches by stable ID and breaks ties between paths by the stable IDs of the entities between', () => {
    expect(compile([TOOL, BACK])).toContain('ORDER BY p.n2.`makerId`, p.n1.`toolId`');
    expect(compile([step()])).toContain('ORDER BY p.n1.`makerId`');
  });

  it('answers one row with no match when the anchor is found and nothing matches, and none when the anchor is missing', () => {
    const text = compile([step()]);
    expect(text).toContain('UNWIND CASE WHEN size(ms) = 0 THEN [null] ELSE ms END AS m');
    expect(text.split('\n')[0]).toContain('WITH a ORDER BY elementId(a) LIMIT 1');
  });

  it('reads the members of the edges of a hop whose rows have no stable ID, each with the count cap plus one', () => {
    const text = compile([TOOL, step({ relationshipTypes: ['STOCKED_AT'], arrivesAt: 'shop' })]);
    expect(text).toContain('OPTIONAL MATCH (s)-[rr:`STOCKED_AT`]->(e)');
    expect(text).toContain('members2');
    expect(text).toContain('AS membersCut');
    expect(compile([step()])).not.toContain('membersCut');
  });

  it('reads a window on the time property of the rows that have one, and a node never twice on a path', () => {
    const text = compile([step({ relationshipTypes: ['LINKS', 'TRUSTS'], ...WINDOW })]);
    expect(text.match(/datetime\(\$steps\[0\]\.windowFrom\)/g)?.length).toBe(1);
    expect(compile([TOOL, BACK])).toContain('n2 <> a AND n2 <> n1');
  });
});
