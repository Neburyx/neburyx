import { describe, expect, it } from 'vitest';
import { patternAllowlist, parsedPatternParams, step } from '../testing/pattern-fixtures.js';
import { AppError } from '../errors.js';
import { patternRequestOf } from './templates/pattern-request.js';
import { patternCountStatementOf, patternStatementOf } from './templates/pattern-statement.js';

const allowlist = patternAllowlist();
const request = (steps: Record<string, unknown>[], over: Record<string, unknown> = {}, list = allowlist) => patternRequestOf(list, parsedPatternParams(steps, over));
const count = (steps: Record<string, unknown>[], over: Record<string, unknown> = {}, list = allowlist): string => patternCountStatementOf(list, request(steps, over, list));
const run = (steps: Record<string, unknown>[]): string => patternStatementOf(allowlist, request(steps));

const WINDOW = { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' };
const regionIs = { on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'north' } };
const regionIn = { on: 'neighbor', property: 'region', op: 'in', values: [{ kind: 'text', value: 'north' }, { kind: 'text', value: 'south' }] };
const rankBetween = { on: 'neighbor', property: 'rank', op: 'between', from: { kind: 'number', value: 1 }, to: { kind: 'number', value: 9 } };
const channelIs = { on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'web' } };
const TOOL = step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' });
const BACK = step({ relationshipTypes: ['USES_TOOL'], direction: 'in', arrivesAt: 'maker' });

const SHAPES: readonly (readonly [string, Record<string, unknown>[]])[] = [
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
  ['two-steps-with-conditions', [step({ conditions: [regionIs], ...WINDOW }), step({ conditions: [rankBetween, channelIs] })]],
];

describe('the count statement of a pattern', () => {
  it.each(SHAPES)('is pinned for %s', async (name, steps) => {
    await expect(count(steps)).toMatchFileSnapshot(`./pattern-count-golden/${name}.cypher`);
  });

  it.each(SHAPES)('shares the run statement fragments for %s and differs only in the last step and the answer', (_name, steps) => {
    const runLines = run(steps).split('\n');
    const countLines = count(steps).split('\n');
    const hops = steps.length;
    expect(countLines[0]).toBe(runLines[0]);
    if (hops === 1) {
      const shared = runLines[1]?.match(/CALL \{ (WITH a CALL \{ .* \}) WITH n1, r1 LIMIT/u)?.[1] ?? '';
      expect(shared).not.toBe('');
      expect(countLines[1]).toContain(shared);
      return;
    }
    const lastRun = 2 * hops - 1;
    for (let index = 1; index < lastRun; index += 1) expect(countLines[index]).toBe(runLines[index]);
    const runPrefix = runLines[lastRun]?.split(' WITH e, n')[0];
    const countPrefix = countLines[lastRun]?.split(' WITH DISTINCT')[0];
    expect(countPrefix).toBe(runPrefix);
  });

  it.each(SHAPES)('streams the distinct arrivals at the count cap plus one and answers numbers and flags only for %s', (_name, steps) => {
    const text = count(steps);
    expect(text).toContain('WITH DISTINCT n');
    expect(text).toContain('LIMIT $countCap + 1 RETURN count(n');
    const last = text.split('\n').at(-1) ?? '';
    expect(last).toMatch(/^RETURN matches, .* AS bounded, .* AS stopListed, .* AS supernodes$/u);
    expect(text).not.toMatch(/\b(CREATE|MERGE|DELETE|SET|REMOVE|DROP|LOAD|CALL (db|apoc|dbms))\b/u);
    expect(text).not.toMatch(/^\s*(EXPLAIN|PROFILE)\b/u);
    expect(last).not.toMatch(/\b(a|x|n\d+|r\d+)\b(?! AS)/u);
  });

  it('holds no request value and is byte equal for requests that differ only in values', () => {
    const sentinel = 'zz-sentinel-9f3a';
    const first = count([step({ conditions: [regionIs, rankBetween, channelIs], ...WINDOW }), step({ conditions: [regionIn] })], { stableId: 'A-1' });
    const second = count([step({ conditions: [{ ...regionIs, value: { kind: 'text', value: sentinel } }, rankBetween, channelIs], ...WINDOW }), step({ conditions: [regionIn] })], { stableId: sentinel });
    expect(second).toBe(first);
    for (const text of [first, second]) {
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain('north');
      expect(text).not.toContain('A-1');
    }
  });

  it('refuses a request that names a type the mapping does not hold, and builds nothing', () => {
    expect(() => count([step({ arrivesAt: 'not-mapped' })])).toThrow(AppError);
    expect(() => count([step({ relationshipTypes: ['NOT_MAPPED'] })])).toThrow(AppError);
  });

  it('refuses more steps than the compiler allows, as the run statement does', () => {
    const five = Array.from({ length: 5 }, () => step());
    expect(() => run(five)).toThrow();
    expect(() => count(five)).toThrow();
  });
});
