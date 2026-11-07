import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { gateRequest, harness, SOURCE_A, TEST_REFERENCE_KEYS, testCatalog, testTemplate, TestExecutor } from '../testing/gate.js';
import { makeToken } from '../reference/token.js';
import { normalizeModelOf } from './normalize/model.js';
import { readPosition } from './validate.js';
import type { Row, Template } from './types.js';

const mapping = mappingOf(
  sourceWith('source-a', {
    entities: [
      { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
      { type: 'thing', label: 'Thing', stable_id: 'thingId' },
    ],
    relationships: [{ type: 'USES', from: 'thing', to: 'phone' }],
    derived: [],
  }),
);
const [source] = mapping.sources;
if (source === undefined) throw new Error('no source');
const model = normalizeModelOf(source);

const CYPHER = 'MATCH (n) WHERE $cursor IS NULL OR n.id > $cursor.id RETURN n.id AS id, n.kind AS kind ORDER BY n.id LIMIT $limit + 1';

function template(): Template {
  return testTemplate({
    id: 'paged-references',
    cypher: CYPHER,
    paged: true,
    sort: 'id:asc',
    referencePositions: [{ entityType: 'kind', stableId: 'id' }],
    nextPosition: (rows: readonly Row[]) => {
      const last = rows.at(-1);
      return last === undefined ? undefined : { kind: String(last['kind']), id: String(last['id']) };
    },
    normalize: (rows) => rows.map((row) => ({ id: String(row['id']) })),
  });
}

function rig(kind: string, ids: readonly string[]) {
  const executor = new TestExecutor((call) => {
    const after = call.parameters['cursor'];
    const afterId = typeof after === 'object' && after !== null && 'id' in after ? String(after['id']) : undefined;
    const rows = ids.filter((id) => afterId === undefined || id > afterId).slice(0, call.rowLimit).map((id) => ({ id, kind }));
    return Promise.resolve({ status: 'rows' as const, rows });
  });
  const parts = harness({ catalog: testCatalog([template()]), executor, modelFor: () => model });
  const page = (cursor?: string) => parts.gate.run(gateRequest({ templateId: 'paged-references', limit: 2, sourceId: SOURCE_A, ...(cursor === undefined ? {} : { cursor }) }));
  return { page, executor };
}

const payloadOf = (cursor: string): string => Buffer.from(cursor.split('.')[1] ?? '', 'base64url').toString('utf8');
const VALUES = ['+1-212-555-0100', '+1-212-555-0101', '+1-212-555-0102', '+1-212-555-0103', '+1-212-555-0104'];

describe('a cursor whose position holds the stable ID of a keyed entity', () => {
  it('holds the token and not the value, and the token is the reference of that value', async () => {
    const { page } = rig('phone', VALUES);
    const first = await page();
    const text = payloadOf(first.nextCursor ?? '');
    expect(text).not.toContain('212-555');
    expect(text).toContain(makeToken(TEST_REFERENCE_KEYS, { sourceId: SOURCE_A, entityType: 'phone' }, VALUES[1] ?? ''));
  });

  it('is read back to the value before the keyset parameters are built, so the pages continue in the order of the values without a repeat or a gap', async () => {
    const { page, executor } = rig('phone', VALUES);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 5; round += 1) {
      const answer = await page(cursor);
      for (const item of answer.items) seen.push(String((item as { id: string }).id));
      cursor = answer.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(VALUES);
    const cursors = executor.calls.map((call) => call.parameters['cursor']).filter((value) => value !== null && value !== undefined);
    expect(cursors).toEqual([{ kind: 'phone', id: VALUES[1] }, { kind: 'phone', id: VALUES[3] }]);
  });

  it('keeps a position of a type that is not keyed as it is', async () => {
    const { page } = rig('thing', VALUES);
    const first = await page();
    expect(payloadOf(first.nextCursor ?? '')).toContain(VALUES[1]);
  });

  it('refuses, as CURSOR_INVALIDATED, a position whose token does not read back in this source and entity type', () => {
    const own = template();
    const bad = { kind: 'phone', id: 'p1.not-a-token' };
    expect(() => readPosition(own, bad, { model, sourceId: SOURCE_A }, TEST_REFERENCE_KEYS)).toThrowError(expect.objectContaining({ code: 'CURSOR_INVALIDATED' }));
    const foreign = { kind: 'phone', id: makeToken(TEST_REFERENCE_KEYS, { sourceId: 'another', entityType: 'phone' }, VALUES[0] ?? '') };
    expect(() => readPosition(own, foreign, { model, sourceId: SOURCE_A }, TEST_REFERENCE_KEYS)).toThrowError(expect.objectContaining({ code: 'CURSOR_INVALIDATED' }));
    const wrongType = { kind: 'thing', id: makeToken(TEST_REFERENCE_KEYS, { sourceId: SOURCE_A, entityType: 'phone' }, VALUES[0] ?? '') };
    expect(readPosition(own, wrongType, { model, sourceId: SOURCE_A }, TEST_REFERENCE_KEYS)).toEqual(wrongType);
  });

  it('refuses a tampered cursor', async () => {
    const { page } = rig('phone', VALUES);
    const first = await page();
    const cursor = first.nextCursor ?? '';
    await expect(page(`${cursor.slice(0, -2)}AA`)).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
  });
});
