import { describe, expect, it } from 'vitest';
import { makeToken } from '../reference/token.js';
import { gateRequest, TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { patternParams, step } from '../testing/pattern-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { ExecuteCall } from './executor.js';
import { PATTERN_ID } from './templates/pattern.js';

const KEYED = [
  { type: 'maker', label: 'Maker', stable_id: 'makerId' },
  { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
  { type: 'tool', label: 'Tool', stable_id: 'toolId' },
];
const RELATIONSHIPS = [
  { type: 'USES_PHONE', from: 'maker', to: 'phone', stable_id: 'useId' },
  { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' },
];
const PHONES = ['+1-212-555-0100', '+1-212-555-0101', '+1-212-555-0102', '+1-212-555-0103', '+1-212-555-0104'];
const TOOLS = ['t-1', 't-2', 't-3', 't-4', 't-5'];

const keyedMapping = () => linkedMappingOf({ entities: KEYED, relationships: RELATIONSHIPS, derived: [], patterns: [] });
const PHONE_STEP = step({ relationshipTypes: ['USES_PHONE'], arrivesAt: 'phone' });
const TOOL_STEP = step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' });

interface EndRow {
  readonly endType: string;
  readonly endKey: string;
  readonly endElement: string;
}

/** A source whose statement returns, after the position of the cursor, the next of the ends in order (the fake does the keyset the statement does). */
function rig(endType: 'phone' | 'tool', ends: readonly string[]) {
  const [source] = keyedMapping().sources;
  if (source === undefined) throw new Error('no source');
  const label = endType === 'phone' ? 'Handle' : 'Tool';
  const property = endType === 'phone' ? 'phoneNumber' : 'toolId';
  const relationship = endType === 'phone' ? 'USES_PHONE' : 'USES_TOOL';
  const respond = (call: ExecuteCall) => {
    const position = call.parameters['cursor'] as { endKey?: string } | null;
    const rows = ends
      .filter((end) => position === null || position === undefined || end > String(position.endKey))
      .slice(0, call.rowLimit)
      .map((end, index) => {
        const a = plainNode(['Maker'], { makerId: 'A-1' }, 'e:a');
        const x = plainNode([label], { [property]: end }, `4:fx:${ends.indexOf(end)}`);
        return { a, bounded: false, heavy: [], stopListed: false, x, endKey: end, endElement: `4:fx:${ends.indexOf(end)}`, endType, mid: [], r1: plainRelationship(relationship, a, x, { useId: `u${index}` }), hops: 1 };
      });
    return Promise.resolve({ status: 'rows' as const, rows });
  };
  const executor = new TestExecutor(withOnlineIndexes(source, respond));
  const parts = testSourceGate(keyedMapping(), { executor, referenceKeys: TEST_REFERENCE_KEYS });
  const read = (steps: Record<string, unknown>[], extra: Record<string, unknown> = {}, limit = 2) =>
    parts.gate.run(gateRequest({ sourceId: 'demo', templateId: PATTERN_ID, params: patternParams(steps), limit, indexes: { sourceId: source.id, entries: onlineIndexesOf(source) }, ...extra }));
  return { read, executor };
}

const payloadOf = (cursor: string): string => Buffer.from(cursor.split('.')[1] ?? '', 'base64url').toString('utf8');
const dataCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === PATTERN_ID);

describe('the cursor of a pattern run', () => {
  it('is signed from the last row read when there is more, and absent on the last page', async () => {
    const { read } = rig('tool', TOOLS);
    const first = await read([TOOL_STEP]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();
    const last = await read([TOOL_STEP], { limit: 10 });
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeUndefined();
  });

  it('reads the next page after the position: the keyset parameter holds the end ID as text and the element ID, and pages never repeat or skip', async () => {
    const { read, executor } = rig('tool', TOOLS);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 6; round += 1) {
      const answer = await read([TOOL_STEP], cursor === undefined ? {} : { cursor });
      for (const item of answer.items) for (const match of (item as { matches: { match: { stableId: string } }[] }).matches) seen.push(match.match.stableId);
      cursor = answer.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(TOOLS);
    const second = dataCalls(executor)[1]?.parameters['cursor'];
    expect(second).toEqual({ endType: 'tool', endKey: 't-2', endElement: '4:fx:1' });
    expect(dataCalls(executor)[0]?.parameters['cursor']).toBeNull();
  });

  it('holds the token and not the value for a keyed end type, and reads it back to the value for the statement', async () => {
    const { read, executor } = rig('phone', PHONES);
    const first = await read([PHONE_STEP]);
    const text = payloadOf(first.nextCursor ?? '');
    expect(text).not.toContain('212-555');
    expect(text).toContain(makeToken(TEST_REFERENCE_KEYS, { sourceId: 'demo', entityType: 'phone' }, PHONES[1] ?? ''));
    await read([PHONE_STEP], { cursor: first.nextCursor });
    expect(dataCalls(executor)[1]?.parameters['cursor']).toMatchObject({ endType: 'phone', endKey: PHONES[1] });
  });

  it('is refused as invalidated, before any read, for another pattern, another anchor or masking, and is accepted for another page size', async () => {
    const { read, executor } = rig('tool', TOOLS);
    const first = await read([TOOL_STEP]);
    const before = dataCalls(executor).length;
    const other = (steps: Record<string, unknown>[], extra: Record<string, unknown> = {}) => read(steps, { cursor: first.nextCursor, ...extra });
    await expect(other([step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool', conditions: [] , direction: 'both' })])).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    await expect(read([TOOL_STEP], { cursor: first.nextCursor, params: patternParams([TOOL_STEP], { stableId: 'A-2' }) })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    await expect(read([TOOL_STEP], { cursor: first.nextCursor, mask: true })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    expect(dataCalls(executor)).toHaveLength(before);
    await expect(read([TOOL_STEP], { cursor: first.nextCursor }, 3)).resolves.toBeDefined();
  });

  it('is CURSOR_INVALIDATED, with no read, for a tampered, truncated or empty cursor', async () => {
    const { read, executor } = rig('tool', TOOLS);
    const first = await read([TOOL_STEP]);
    const [head, body, tag] = (first.nextCursor ?? '..').split('.');
    const before = dataCalls(executor).length;
    for (const bad of ['', 'x', `${head}.${body}x.${tag}`, `${head}.${body}`, `${head}.${body}.${tag}x`, `${head}.${body?.slice(0, -2)}.${tag}`]) await expect(read([TOOL_STEP], { cursor: bad }), bad).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    expect(dataCalls(executor)).toHaveLength(before);
  });
});
