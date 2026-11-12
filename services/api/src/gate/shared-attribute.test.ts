import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { DERIVED_RULE } from '../testing/derived-fixtures.js';
import { SHARED_RELATIONSHIPS, sharedMappingOf } from '../testing/shared-attribute-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { derivedRuleRunTemplate } from './templates/derived-rule-run.js';
import { SHARED_ATTRIBUTE_ID, sharedAttributeTemplate } from './templates/shared-attribute.js';

function rig(mapping = sharedMappingOf(), answer: (call: ExecuteCall) => ExecuteOutcome = () => ({ status: 'rows', rows: [] })) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor });
  const read = (params: unknown, limit = 25, mask?: boolean) =>
    parts.gate.run(gateRequest({ sourceId: 'demo', templateId: SHARED_ATTRIBUTE_ID, params, limit, ...(mask === undefined ? {} : { mask }), indexes: { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) } }));
  return { ...parts, read, executor };
}

const params = { entityType: 'maker', stableId: 'A-1', attributeType: 'tool', via: 'USES_TOOL' };
const dataCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === SHARED_ATTRIBUTE_ID);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('the statement of a shared-attribute run', () => {
  it('is written from the mapping with quoted names, the stop-list condition and the bounds, and holds only the values as parameters', async () => {
    const { read, executor } = rig();
    await read(params, 10);
    const [call] = dataCalls(executor);
    expect(call?.cypher).toBe(
      [
        'MATCH (a:`Maker`) WHERE a.`makerId` IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1',
        'CALL { WITH a OPTIONAL MATCH (a)-[:`USES_TOOL`]->(s:`Tool`) WHERE coalesce(s.`isCommon`, false) = true WITH s LIMIT 1 RETURN count(s) > 0 AS skipped }',
        'CALL { WITH a MATCH (a)-[ra:`USES_TOOL`]->(x:`Tool`) WHERE coalesce(x.`isCommon`, false) <> true WITH DISTINCT x LIMIT $countCap + 1 WITH collect(x) AS mine RETURN size(mine) > $countCap AS anchorBounded, mine[..$countCap] AS xs }',
        'CALL { WITH a, xs UNWIND xs AS x MATCH (x)<-[rb:`USES_TOOL`]-(b:`Maker`) WHERE b <> a WITH DISTINCT b, x LIMIT $countCap + 1 WITH collect({b: b, x: x}) AS pairs RETURN size(pairs) > $countCap AS pairsBounded, pairs[..$countCap] AS kept }',
        'CALL { WITH a, kept UNWIND kept AS q WITH a, q.b AS b, collect(q.x) AS xs WHERE size(xs) >= $minShared WITH a, b, xs ORDER BY elementId(b) LIMIT $limit + 1 CALL { WITH a, b, xs UNWIND xs[..5] AS x CALL { WITH a, x MATCH (a)-[ra:`USES_TOOL`]->(x) RETURN ra LIMIT 1 } CALL { WITH b, x MATCH (b)-[rb:`USES_TOOL`]->(x) RETURN rb LIMIT 1 } RETURN collect(x) AS shown, collect(ra) AS ras, collect(rb) AS rbs } RETURN collect({b: b, shown: shown, ras: ras, rbs: rbs, shared: size(xs), cut: size(xs) > 5}) AS ms }',
        'UNWIND CASE WHEN size(ms) = 0 THEN [null] ELSE ms END AS m',
        'RETURN a, skipped, anchorBounded OR pairsBounded AS bounded, m.b AS b, m.shown AS xs, m.ras AS ras, m.rbs AS rbs, m.shared AS shared, m.cut AS evidenceCut',
      ].join('\n'),
    );
    expect(call?.cypher).not.toContain('A-1');
    expect(call?.cypher).not.toContain('10');
    expect(call?.parameters).toMatchObject({ stableId: 'A-1', limit: 10, minShared: 1 });
    expect(call?.parameters).toHaveProperty('countCap');
    for (const name of ['entityType', 'attributeType', 'via']) expect(call?.parameters).not.toHaveProperty(name);
    expect(call?.accessMode).toBe('READ');
  });

  it('compares the mapped time property as an instant, as the window says, only when a window is given', async () => {
    const { read, executor } = rig();
    await read({ ...params, windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z', minShared: 3 });
    const [call] = dataCalls(executor);
    expect(call?.cypher).toContain('`seenAt` IS :: ZONED DATETIME');
    expect(call?.cypher).toContain('`seenAt` IS :: LOCAL DATETIME THEN datetime({datetime: ra.`seenAt`, timezone: \'UTC\'})');
    expect(call?.cypher).toContain('`seenAt` IS :: DATE THEN datetime({date: rb.`seenAt`, timezone: \'UTC\'})');
    expect(call?.cypher).toContain(">= datetime($windowFrom)");
    expect(call?.cypher).toContain('< datetime($windowTo)');
    expect(call?.cypher).not.toContain('2026');
    expect(call?.parameters).toMatchObject({ windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z', minShared: 3 });
  });

  it('leaves out the stop-list condition when no derived rule runs over the types', async () => {
    const { read, executor } = rig(sharedMappingOf({ derived: [] }));
    await read(params);
    const cypher = dataCalls(executor)[0]?.cypher ?? '';
    expect(cypher).toContain('WITH a, false AS skipped');
    expect(cypher).not.toContain('coalesce');
    expect(cypher).toContain('MATCH (a)-[ra:`USES_TOOL`]->(x:`Tool`) WITH DISTINCT x LIMIT $countCap + 1');
  });

  it('uses the stop-list property of every rule over the same types, and ignores a rule of another shape', async () => {
    const other = { id: 'other', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 1, stop_list_property: 'isOther' };
    const longer = { id: 'long', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL', 'maker', 'USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 1, stop_list_property: 'isLong' };
    const { read, executor } = rig(sharedMappingOf({ derived: [DERIVED_RULE, other, longer] }));
    await read(params);
    const cypher = dataCalls(executor)[0]?.cypher ?? '';
    expect(cypher).toContain('coalesce(x.`isCommon`, false) <> true AND coalesce(x.`isOther`, false) <> true');
    expect(cypher).not.toContain('isLong');
  });
});

describe('a request for a shared-attribute run', () => {
  it.each([
    ['an attribute type the mapping does not have', { ...params, attributeType: 'nothing' }],
    ['a relationship type the mapping does not have', { ...params, via: 'NOTHING' }],
    ['a relationship type that does not join the two types in the mapped direction', { ...params, entityType: 'tool', attributeType: 'maker' }],
    ['a list of attribute types', { ...params, attributeType: ['tool', 'maker'] }],
    ['a value the schema does not name', { ...params, cypher: 'MATCH (n) RETURN n' }],
    ['a minimum of shared nodes below one', { ...params, minShared: 0 }],
    ['a window with one instant', { ...params, windowFrom: '2026-01-01T00:00:00.000Z' }],
  ])('is refused with INVALID_REQUEST for %s, and nothing reaches the executor', async (_name, request) => {
    const { read, executor } = rig();
    expect(await codeOf(read(request))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toHaveLength(0);
  });

  it('is refused for a window on a relationship type with no mapped time property', async () => {
    const { read, executor } = rig(sharedMappingOf({ relationships: [{ type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' }] }));
    expect(await codeOf(read({ ...params, windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' }))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toHaveLength(0);
  });

  it('is refused for a limit above the max_page of the source', async () => {
    const { read } = rig();
    expect(await codeOf(read(params, 51))).toBe('QUERY_BUDGET_EXCEEDED');
  });
});

describe('the catalog entry of the shared-attribute template', () => {
  it('is a version 1 read that is cut to a lower bound, with the audit action of the template', () => {
    expect(sharedAttributeTemplate).toMatchObject({ id: 'shared-attribute', version: '1', auditAction: 'entity.shared_attribute_run', paged: false, cutMeans: 'lowerBound' });
    expect(SHARED_RELATIONSHIPS).toHaveLength(1);
  });

  it('tells the planner which of the two templates a plain question and a question for the chain plan', () => {
    expect(sharedAttributeTemplate.description).toContain('Plan this template for a plain question of who shares an attribute');
    expect(sharedAttributeTemplate.description).toContain('a question that asks for the chain that shows the link plans derived-rule-run');
    expect(derivedRuleRunTemplate.description).toContain('Plan this template for a question that asks for the chain that shows the link');
    expect(derivedRuleRunTemplate.description).toContain('a plain question of who shares an attribute plans shared-attribute');
  });
});
