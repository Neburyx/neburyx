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
const CLOSE = step({ relationshipTypes: ['LINKS'], closesAtAnchor: true });
const TOOL = step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' });
const definition = (steps: readonly unknown[]) => ({ anchorType: 'maker', steps });
const refused = (steps: Record<string, unknown>[]) => {
  try {
    patternRequestOf(allowlist, parsedPatternParams(steps));
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not-an-app-error';
  }
};

describe('a cycle back to the anchor, at the contract', () => {
  it('closes on the last of two to four steps, with the one value true', () => {
    for (const count of [2, 3, 4]) expect(patternProblemsOf(definition([...Array.from({ length: count - 1 }, () => LINKS), CLOSE])), String(count)).toEqual([]);
    expect(patternProblemsOf(definition([CLOSE]))).toEqual([{ path: ['steps', 0, 'closesAtAnchor'], code: 'bad-value' }]);
    expect(patternProblemsOf(definition([CLOSE, LINKS]))).toEqual([{ path: ['steps', 0, 'closesAtAnchor'], code: 'bad-value' }]);
    expect(patternProblemsOf(definition([LINKS, CLOSE, LINKS]))).toEqual([{ path: ['steps', 1, 'closesAtAnchor'], code: 'bad-value' }]);
    for (const bad of [false, 1, 'true', null]) expect(patternProblemsOf(definition([LINKS, { ...LINKS, closesAtAnchor: bad }])).map((problem) => problem.path.join('.')), String(bad)).toEqual(['steps.1.closesAtAnchor']);
  });

  it('is the schema’s too-many for five steps, found before any mapping problem', () => {
    expect(patternProblemsOf(definition([LINKS, LINKS, LINKS, LINKS, CLOSE]))).toEqual([{ path: ['steps'], code: 'too-many' }]);
  });
});

describe('a cycle, against the source', () => {
  const mapping = patternMappingOf({ max_hops: 2 }).sources[0];
  const normal = patternMappingOf().sources[0];
  if (mapping === undefined || normal === undefined) throw new Error('no source');

  it('is fine at the length the source allows and cycle-too-long above it, instead of too-many-hops', () => {
    expect(validatePattern(definition([LINKS, CLOSE]), mapping)).toEqual([]);
    expect(validatePattern(definition([LINKS, LINKS, CLOSE]), mapping)).toEqual([{ path: ['steps'], code: 'cycle-too-long' }]);
    expect(validatePattern(definition([LINKS, LINKS, LINKS]), mapping)).toEqual([{ path: ['steps'], code: 'too-many-hops' }]);
    expect(validatePattern(definition([LINKS, LINKS, LINKS, CLOSE]), normal)).toEqual([]);
  });

  it('is bad-value when the last step arrives at another type than the anchor’s', () => {
    expect(validatePattern(definition([TOOL, step({ relationshipTypes: ['STOCKED_AT'], arrivesAt: 'shop', closesAtAnchor: true })]), normal)).toEqual([{ path: ['steps', 1, 'closesAtAnchor'], code: 'bad-value' }]);
    expect(validatePattern(definition([TOOL, step({ relationshipTypes: ['USES_TOOL'], direction: 'in', arrivesAt: 'maker', closesAtAnchor: true })]), normal)).toEqual([]);
  });
});

describe('a cycle, at the gate', () => {
  it('is refused for one step, for a closing step that is not last, and for another arrival type, whatever the definition said', () => {
    expect(patternParamsSchema.safeParse(patternParams([LINKS, CLOSE])).success).toBe(true);
    expect(patternParamsSchema.safeParse(patternParams([CLOSE])).success).toBe(false);
    expect(patternParamsSchema.safeParse(patternParams([CLOSE, LINKS])).success).toBe(false);
    expect(refused([LINKS, CLOSE])).toBeUndefined();
    expect(refused([TOOL, step({ relationshipTypes: ['STOCKED_AT'], arrivesAt: 'shop', closesAtAnchor: true })])).toBe('INVALID_REQUEST');
  });

  it('writes the closing step to arrive at the anchor, with the nodes between distinct and no relationship used twice, and no other step differently', () => {
    const request = patternRequestOf(allowlist, parsedPatternParams([LINKS, LINKS, CLOSE]));
    expect(request.steps.map((entry) => entry.closes)).toEqual([false, false, true]);
    const text = patternStatementOf(allowlist, request);
    expect(text).toContain('n3 = a AND n3 <> n1 AND n3 <> n2 AND r3 <> r1 AND r3 <> r2');
    expect(text).toContain('WITH a, n1, n2, r1, r2 MATCH (n2)-[r3:`LINKS`]->(n3:`Maker`)');
    expect(text).toContain('n2 <> a AND n2 <> n1');
    expect(patternCountStatementOf(allowlist, request)).toContain('n3 = a AND n3 <> n1 AND n3 <> n2 AND r3 <> r1 AND r3 <> r2');
    expect(patternStatementOf(allowlist, patternRequestOf(allowlist, parsedPatternParams([LINKS, LINKS, LINKS])))).not.toContain('= a');
  });
});

describe('the cursor of a cycle', () => {
  it('is refused as invalidated, before any read, when the closing is added or removed', async () => {
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
    const first = await read([LINKS, CLOSE]);
    expect(first.nextCursor).toBeDefined();
    const before = executor.calls.length;
    await expect(read([LINKS, LINKS], { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    expect(executor.calls).toHaveLength(before);
    await expect(read([LINKS, CLOSE], { cursor: first.nextCursor })).resolves.toBeDefined();
  });
});
