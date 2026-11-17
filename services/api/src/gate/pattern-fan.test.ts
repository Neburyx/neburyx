import { patternProblemsOf } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { parsedPatternParams, patternAllowlist, patternMappingOf, patternParams, step } from '../testing/pattern-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { validatePattern } from '../patterns/validate.js';
import type { ExecuteCall } from './executor.js';
import { patternCountStatementOf, patternStatementOf } from './templates/pattern-statement.js';
import { patternParamsSchema, patternRequestOf } from './templates/pattern-request.js';
import { PATTERN_ID } from './templates/pattern.js';

const allowlist = patternAllowlist();
const LINKS = step({ relationshipTypes: ['LINKS'] });
const fan = (atLeast: number, over: Record<string, unknown> = {}) => step({ relationshipTypes: ['LINKS'], fan: { atLeast }, ...over });
const requestOf = (steps: Record<string, unknown>[], cap?: number) => patternRequestOf(allowlist, parsedPatternParams(steps), cap);
const codeOf = (steps: Record<string, unknown>[], cap?: number) => {
  try {
    requestOf(steps, cap);
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not-an-app-error';
  }
};
const definition = (steps: readonly unknown[]) => ({ anchorType: 'maker', steps });

describe('a fan of at least n neighbours, at the contract', () => {
  it('takes an integer of 2 or more and nothing else in the field', () => {
    expect(patternProblemsOf(definition([fan(2)]))).toEqual([]);
    expect(patternProblemsOf(definition([fan(1000)]))).toEqual([]);
    for (const bad of [1, 0, -3, 2.5, '3', null]) expect(patternProblemsOf(definition([{ ...LINKS, fan: { atLeast: bad } }])).map((problem) => problem.path.join('.')), String(bad)).toEqual(['steps.0.fan.atLeast']);
    expect(patternProblemsOf(definition([{ ...LINKS, fan: { atLeast: 3, extra: 1 } }]))).toEqual([{ path: ['steps', 0, 'fan'], code: 'unknown-key' }]);
    expect(patternProblemsOf(definition([{ ...LINKS, fan: {} }]))).toEqual([{ path: ['steps', 0, 'fan', 'atLeast'], code: 'missing' }]);
    expect(patternProblemsOf(definition([{ ...LINKS, fan: 3 }])).length).toBe(1);
  });
});

describe('a fan of at least n neighbours, against the source', () => {
  const lowCap = patternMappingOf({ heavy_op_threshold: 10 }).sources[0];
  const highCap = patternMappingOf({ heavy_op_threshold: 1000 }).sources[0];
  const defaultCap = patternMappingOf().sources[0];
  if (lowCap === undefined || highCap === undefined || defaultCap === undefined) throw new Error('no source');

  it('is refused as over-ceiling above the count cap of the source, accepted at it, with a cap below and above 500', () => {
    expect(validatePattern(definition([fan(11)]), lowCap)).toEqual([{ path: ['steps', 0, 'fan', 'atLeast'], code: 'over-ceiling' }]);
    expect(validatePattern(definition([fan(10)]), lowCap)).toEqual([]);
    expect(validatePattern(definition([fan(500)]), defaultCap)).toEqual([]);
    expect(validatePattern(definition([fan(501)]), defaultCap)).toEqual([{ path: ['steps', 0, 'fan', 'atLeast'], code: 'over-ceiling' }]);
    expect(validatePattern(definition([fan(900)]), highCap)).toEqual([]);
    expect(validatePattern(definition([fan(1001)]), highCap)).toEqual([{ path: ['steps', 0, 'fan', 'atLeast'], code: 'over-ceiling' }]);
  });

  it('is refused at the gate too, before any statement is written, for a request that did not pass the validation', () => {
    expect(codeOf([fan(11)], 10)).toBe('INVALID_REQUEST');
    expect(codeOf([fan(10)], 10)).toBeUndefined();
    expect(codeOf([LINKS, fan(600)], 500)).toBe('INVALID_REQUEST');
  });
});

describe('the statement of a fan', () => {
  const first = requestOf([fan(3)]);
  const later = requestOf([LINKS, fan(4)]);

  it('reads the degree of the origin first, bounded, and counts the neighbours only for an origin within the cap', () => {
    const text = patternStatementOf(allowlist, first);
    expect(text).toContain('AS degree0');
    expect(text.indexOf('AS degree0')).toBeLessThan(text.indexOf('AS fanned0'));
    expect(text).toContain('WHERE degree0 <= $countCap');
    expect(text).toContain('WITH DISTINCT n1 LIMIT $countCap + 1');
    expect(text).toContain('$steps[0].fan.atLeast');
    const laterText = patternStatementOf(allowlist, later);
    expect(laterText.indexOf('AS degree }')).toBeLessThan(laterText.indexOf('AS fanned }'));
    expect(laterText).toContain('c.fanned >= $steps[1].fan.atLeast');
  });

  it('is read the same by the run and by the count it is estimated with, and the number is a parameter, never text', () => {
    for (const request of [first, later]) {
      const run = patternStatementOf(allowlist, request);
      const count = patternCountStatementOf(allowlist, request);
      const fragment = /CALL \{ WITH (a|n), degree0? WITH \1 WHERE degree0? <= \$countCap CALL \{.*?\} WITH DISTINCT n\d LIMIT \$countCap \+ 1 RETURN count\(\*\) AS fanned0? \}/.exec(run)?.[0];
      expect(fragment, 'a fan fragment').toBeDefined();
      expect(count).toContain(fragment);
      expect(run).not.toMatch(/atLeast: ?\d/);
      expect(run).not.toContain('>= 3');
      expect(run).not.toContain('>= 4');
    }
  });

  it('writes nothing of a fan for a step that has none, and the supernode origin is the anchor’s heavy list', () => {
    expect(patternStatementOf(allowlist, requestOf([LINKS, LINKS]))).not.toContain('fanned');
    expect(patternStatementOf(allowlist, first)).toContain('CASE WHEN heavy0 THEN [a] ELSE [] END');
    expect(patternCountStatementOf(allowlist, requestOf([fan(3)]))).toContain('CASE WHEN heavy0 THEN 1 ELSE 0 END AS supernodes');
  });

  it('takes the conditions and the window of its step into the count, not the order of the path', () => {
    const request = requestOf([LINKS, fan(3, { after: 'previous', conditions: [{ on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'x' } }] })]);
    const text = patternStatementOf(allowlist, request);
    const fanRead = /CALL \{ WITH n, degree WITH n WHERE degree <= \$countCap CALL \{(.*?)\} WITH DISTINCT n2/.exec(text)?.[1] ?? '';
    expect(fanRead).toContain('lane');
    expect(fanRead).not.toContain('>= t1');
    expect(fanRead).not.toContain('<>');
    expect(text).toContain('>= t1');
  });
});

describe('the parameters of a fan at the gate', () => {
  it('read the field from the second step on as well as the first, and keep the other caps', () => {
    expect(patternParamsSchema.safeParse(patternParams([fan(3), fan(4)])).success).toBe(true);
    expect(patternParamsSchema.safeParse(patternParams([step({ fan: { atLeast: 1 } })])).success).toBe(false);
    expect(requestOf([LINKS, fan(4)]).steps.map((entry) => entry.fan)).toEqual([undefined, 4]);
  });
});

describe('the cursor of a run with a fan', () => {
  function rig() {
    const [source] = patternMappingOf().sources;
    if (source === undefined) throw new Error('no source');
    const respond = (call: ExecuteCall) => {
      const rows = ['m-1', 'm-2', 'm-3'].slice(0, call.rowLimit).map((id, index) => {
        const a = plainNode(['Maker'], { makerId: 'A-1' }, 'e:a');
        const x = plainNode(['Maker'], { makerId: id }, `4:fx:${index}`);
        return { a, bounded: false, heavy: [], stopListed: false, x, endKey: id, endElement: `4:fx:${index}`, endType: 'maker', mid: [], r1: plainRelationship('LINKS', a, x, { linkId: `l${index}` }) };
      });
      return Promise.resolve({ status: 'rows' as const, rows });
    };
    const executor = new TestExecutor(withOnlineIndexes(source, respond));
    const parts = testSourceGate(patternMappingOf(), { executor });
    const read = (steps: Record<string, unknown>[], extra: Record<string, unknown> = {}) => parts.gate.run(gateRequest({ sourceId: 'demo', templateId: PATTERN_ID, params: patternParams(steps), limit: 2, indexes: { sourceId: source.id, entries: onlineIndexesOf(source) }, ...extra }));
    return { read, executor };
  }

  it('is refused as invalidated, before any read, when the fan is added, removed or changed, and accepted for the same request', async () => {
    const { read, executor } = rig();
    const first = await read([fan(3)]);
    expect(first.nextCursor).toBeDefined();
    const before = executor.calls.length;
    for (const other of [[LINKS], [fan(4)], [fan(2)]]) await expect(read(other, { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    expect(executor.calls).toHaveLength(before);
    await expect(read([fan(3)], { cursor: first.nextCursor })).resolves.toBeDefined();
  });

  it('is refused by the gate itself above the count cap of the source, before any read', async () => {
    const { read, executor } = rig();
    await expect(read([fan(501)])).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(executor.calls.filter((call) => call.templateId === PATTERN_ID)).toHaveLength(0);
  });
});
