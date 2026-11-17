import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { parsedPatternParams, patternAllowlist, patternMappingOf, patternParams, step } from '../testing/pattern-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { ExecuteCall } from './executor.js';
import { patternCountStatementOf, patternStatementOf } from './templates/pattern-statement.js';
import { patternParamsSchema, patternRequestOf } from './templates/pattern-request.js';
import { PATTERN_ID, patternTemplate } from './templates/pattern.js';
import { patternCountTemplate } from './templates/pattern-count.js';
import { patternNoticesOf } from './templates/pattern-notices.js';

const allowlist = patternAllowlist();
const LINKS = step({ relationshipTypes: ['LINKS'] });
const AFTER = step({ relationshipTypes: ['LINKS'], after: 'previous' });
const requestOf = (steps: Record<string, unknown>[]) => patternRequestOf(allowlist, parsedPatternParams(steps));
const refused = (steps: Record<string, unknown>[]) => {
  try {
    requestOf(steps);
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not-an-app-error';
  }
};

describe('a step ordered after the previous one, at the gate', () => {
  it('is read from the parameters of the second step on, and the first step takes none', () => {
    expect(patternParamsSchema.safeParse(patternParams([LINKS, AFTER])).success).toBe(true);
    expect(patternParamsSchema.safeParse(patternParams([AFTER])).success).toBe(false);
    expect(patternParamsSchema.safeParse(patternParams([LINKS, step({ after: 'next' })])).success).toBe(false);
    expect(requestOf([LINKS, AFTER]).steps.map((entry) => entry.ordered)).toEqual([false, true]);
    expect(requestOf([LINKS, AFTER]).timeOrdered).toBe(true);
    expect(requestOf([LINKS, LINKS]).timeOrdered).toBe(false);
  });

  it('is refused when a row of either step has no time property, whatever the definition said', () => {
    expect(refused([LINKS, step({ relationshipTypes: ['ALLIES'], after: 'previous' })])).toBe('INVALID_REQUEST');
    expect(refused([step({ relationshipTypes: ['ALLIES'] }), AFTER])).toBe('INVALID_REQUEST');
    expect(refused([LINKS, step({ relationshipTypes: ['LINKS', 'ALLIES'], after: 'previous' })])).toBe('INVALID_REQUEST');
    expect(refused([LINKS, AFTER])).toBeUndefined();
  });

  it('reads the time of the previous relationship on its own property and compares the step with it, and writes nothing of the kind without the field', () => {
    const ordered = patternStatementOf(allowlist, requestOf([LINKS, AFTER]));
    expect(ordered).toContain('AS t1');
    expect(ordered).toContain('>= t1');
    expect(ordered).toContain('`seenAt`');
    const plain = patternStatementOf(allowlist, requestOf([LINKS, LINKS]));
    expect(plain).not.toMatch(/\bt1\b/);
    const count = patternCountStatementOf(allowlist, requestOf([LINKS, AFTER]));
    expect(count).toContain('>= t1');
    expect(patternCountStatementOf(allowlist, requestOf([LINKS, LINKS]))).not.toMatch(/\bt1\b/);
  });

  it('carries the time through three steps, and writes the value of no request into the text', () => {
    const text = patternStatementOf(allowlist, requestOf([LINKS, AFTER, AFTER]));
    expect(text).toContain('>= t1');
    expect(text).toContain('>= t2');
    expect(text).not.toContain('previous');
  });

  it('lists the time properties of both steps as used properties, and reports the relationships left out for no usable time', () => {
    const used = patternTemplate.usedProperties?.(patternParams([LINKS, AFTER]) as never, allowlist) ?? [];
    expect(used.filter((entry) => 'property' in entry && entry.property === 'seenAt')).toHaveLength(1);
    const notices = patternNoticesOf({ stopListed: false, supernodes: [], bounded: false }, requestOf([LINKS, AFTER]));
    expect(notices.map((notice) => notice.code)).toContain('undatedExcluded');
    expect(patternNoticesOf({ stopListed: false, supernodes: [], bounded: false }, requestOf([LINKS, LINKS])).map((notice) => notice.code)).not.toContain('undatedExcluded');
  });

  it('moves the templates to versions 3 and 2', () => {
    expect([patternTemplate.version, patternCountTemplate.version]).toEqual(['3', '2']);
  });
});

describe('the cursor of a run with a time order', () => {
  function rig() {
    const [source] = patternMappingOf().sources;
    if (source === undefined) throw new Error('no source');
    const respond = (call: ExecuteCall) => {
      const rows = ['m-1', 'm-2', 'm-3'].slice(0, call.rowLimit).map((id, index) => {
        const a = plainNode(['Maker'], { makerId: 'A-1' }, 'e:a');
        const x = plainNode(['Maker'], { makerId: id }, `4:fx:${index}`);
        return { a, bounded: false, heavy: [], stopListed: false, x, endKey: id, endElement: `4:fx:${index}`, endType: 'maker', mid: [], r1: plainRelationship('LINKS', a, x, { linkId: `l${index}` }), r2: plainRelationship('LINKS', a, x, { linkId: `k${index}` }) };
      });
      return Promise.resolve({ status: 'rows' as const, rows });
    };
    const executor = new TestExecutor(withOnlineIndexes(source, respond));
    const parts = testSourceGate(patternMappingOf(), { executor });
    const read = (steps: Record<string, unknown>[], extra: Record<string, unknown> = {}) => parts.gate.run(gateRequest({ sourceId: 'demo', templateId: PATTERN_ID, params: patternParams(steps), limit: 2, indexes: { sourceId: source.id, entries: onlineIndexesOf(source) }, ...extra }));
    return { read, executor };
  }

  it('is refused as invalidated, before any read, when the order of a step is added or removed, and is accepted for the same request', async () => {
    const { read, executor } = rig();
    const first = await read([LINKS, AFTER]);
    expect(first.nextCursor).toBeDefined();
    const before = executor.calls.length;
    await expect(read([LINKS, LINKS], { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    expect(executor.calls).toHaveLength(before);
    await expect(read([LINKS, AFTER], { cursor: first.nextCursor })).resolves.toBeDefined();
    const plain = await read([LINKS, LINKS]);
    await expect(read([LINKS, AFTER], { cursor: plain.nextCursor })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
  });
});
