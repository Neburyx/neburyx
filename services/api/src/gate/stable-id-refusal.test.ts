import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { ExecuteOutcome } from './executor.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { patternMappingOf } from '../testing/pattern-fixtures.js';
import { onlineIndexesOf, schemaAnswer, type IndexRow } from '../testing/search-fixtures.js';
import { LOOKUP_INVENTORY } from '../testing/stable-id-lookups.js';
import { testSourceGate } from '../testing/source-gate.js';

/**
 * A read that finds an element by its stable ID is refused when the index that serves it is missing, still being built, failed or only TEXT, before any statement names the label:
 * the same for the single reads as for the batched ones. The hint in the statement does not protect a read whose index is gone (the server scans, or fails), so the refusal is the guard's.
 */
const mapping = patternMappingOf();
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const ONLINE = onlineIndexesOf(source);

const GAPS: readonly (readonly [string, readonly IndexRow[], string])[] = [
  ['missing', [], 'index-unavailable'],
  ['building', ONLINE.map((row) => ({ ...row, state: 'POPULATING' })), 'index-building'],
  ['failed', ONLINE.map((row) => ({ ...row, state: 'FAILED' })), 'index-failed'],
  ['TEXT only', ONLINE.map((row) => ({ ...row, type: 'TEXT' })), 'index-unavailable'],
];

function rig(schema: () => ExecuteOutcome) {
  const executor = new TestExecutor((call) => Promise.resolve(call.templateId === 'schema-indexes' ? schema() : { status: 'rows', rows: [] }));
  const parts = testSourceGate(mapping, { executor });
  const run = (templateId: string, params: Record<string, unknown>) => parts.gate.run(gateRequest({ sourceId: 'demo', templateId, params, limit: 25 }));
  return { executor, run };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? `${error.code}:${error.reason ?? ''}` : 'not an AppError';
  }
}

const cases = Object.entries(LOOKUP_INVENTORY).flatMap(([id, params]) => GAPS.map(([gap, entries, reason]) => [id, gap, params, entries, reason] as const));

describe('a lookup by stable ID is refused when its index is not usable', () => {
  it.each(cases)('%s, index %s: SOURCE_UNAVAILABLE with the gap, one schema read and no statement', async (id, _gap, params, entries, reason) => {
    const { executor, run } = rig(() => schemaAnswer(entries));
    expect(await codeOf(run(id, params))).toBe(`SOURCE_UNAVAILABLE:${reason}`);
    expect(executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes']);
  });

  it.each(Object.entries(LOOKUP_INVENTORY))('%s sends its statement, with the hint, when the source will not list its indexes (the one case the guard cannot protect)', async (id, params) => {
    const { executor, run } = rig(() => ({ status: 'unavailable', reason: 'refused' }));
    expect(await codeOf(run(id, params))).toBe('ok');
    const sent = executor.calls.filter((call) => call.templateId !== 'schema-indexes');
    expect(sent.length).toBeGreaterThan(0);
    for (const call of sent) expect(call.cypher).toContain('USING INDEX SEEK');
  });

  it('lets each of them through when every index is online (the check is not refusing everything)', async () => {
    for (const [id, params] of Object.entries(LOOKUP_INVENTORY)) {
      const { executor, run } = rig(() => schemaAnswer(ONLINE));
      expect(await codeOf(run(id, params))).toBe('ok');
      expect(executor.calls.some((call) => call.templateId === id)).toBe(true);
    }
  });
});
