import { describe, expect, it } from 'vitest';
import type { GraphEdge } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { redactItems } from './redact/index.js';
import { account, chain, hidingRedact, DERIVED_AGGREGATE, DERIVED_ENTITIES, DERIVED_RULE, DERIVED_STORED, device, pathOf, uses } from '../testing/derived-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { DERIVED_RULE_RUN_ID } from './templates/derived-rule-run.js';

function mappingWith(overrides: Record<string, unknown> = {}) {
  return parseMapping(fileOf(baseSource({ id: 'demo', entities: DERIVED_ENTITIES, relationships: DERIVED_STORED, derived: [DERIVED_RULE], ...overrides })), 'neburyx.yaml');
}

function rig(answer: (call: ExecuteCall) => ExecuteOutcome, mapping = mappingWith(), redact?: Parameters<typeof testSourceGate>[1] extends infer O ? (O extends { redact?: infer R } ? R : never) : never) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor, ...(redact === undefined ? {} : { redact }) });
  const read = (params: unknown, limit = 25, mask?: boolean) =>
    parts.gate.run(gateRequest({ sourceId: 'demo', templateId: DERIVED_RULE_RUN_ID, params, limit, ...(mask === undefined ? {} : { mask }), indexes: { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) } }));
  return { ...parts, read, executor };
}

const params = { entityType: 'maker', stableId: 'A-1', ruleId: 'shared-tool' };
const dataCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === DERIVED_RULE_RUN_ID);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('the statement of a rule run', () => {
  it('is written from the rule of the mapping with quoted names, the stop-list condition and the bound, and holds only the values as parameters', async () => {
    const { read, executor } = rig(() => ({ status: 'rows', rows: [] }));
    await read(params);
    const [call] = dataCalls(executor);
    expect(call?.cypher).toBe(
      [
        'MATCH (a:`Maker`) WHERE a.`makerId` IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1',
        'CALL { WITH a MATCH (a)-[:`USES_TOOL`]-(m1:`Tool`)-[:`USES_TOOL`]-(b:`Maker`) WHERE b <> a AND coalesce(m1.`isCommon`, false) <> true RETURN DISTINCT b LIMIT $limit + 1 }',
        'CALL { WITH a, b MATCH p = (a)-[:`USES_TOOL`]-(m1:`Tool`)-[:`USES_TOOL`]-(b:`Maker`) WHERE b <> a AND coalesce(m1.`isCommon`, false) <> true RETURN p LIMIT 1 }',
        'RETURN p',
      ].join('\n'),
    );
    expect(call?.cypher).not.toContain('A-1');
    expect(call?.parameters).toMatchObject({ stableId: 'A-1', limit: 25 });
    expect(call?.parameters).not.toHaveProperty('ruleId');
    expect(call?.accessMode).toBe('READ');
  });

  it('follows each hop of a longer chain through the labels of the rule and leaves out the stop-list condition when the rule has none', async () => {
    const mapping = mappingWith({ derived: [{ id: 'long', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL', 'maker', 'USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 1 }] });
    const { read, executor } = rig(() => ({ status: 'rows', rows: [] }), mapping);
    await read({ ...params, ruleId: 'long' });
    const cypher = dataCalls(executor)[0]?.cypher ?? '';
    expect(cypher).toContain('(a)-[:`USES_TOOL`]-(m1:`Tool`)-[:`USES_TOOL`]-(m2:`Maker`)-[:`USES_TOOL`]-(m3:`Tool`)-[:`USES_TOOL`]-(b:`Maker`) WHERE b <> a RETURN DISTINCT b LIMIT $limit + 1');
    expect(cypher).not.toContain('coalesce');
  });
});

describe('a request for a rule run', () => {
  it('is INVALID_REQUEST, and reads nothing, for a rule that is not in the mapping, a rule of another entity type or an unknown entity type', async () => {
    const { read, executor } = rig(() => ({ status: 'rows', rows: [] }));
    expect(await codeOf(read({ ...params, ruleId: 'unknown-rule' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ ...params, entityType: 'tool' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ ...params, entityType: 'nothing' }))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toHaveLength(0);
  });

  it('is INVALID_REQUEST for a field the request may not hold, such as a relationship type or a cap', async () => {
    const { read, executor } = rig(() => ({ status: 'rows', rows: [] }));
    expect(await codeOf(read({ ...params, via: ['USES_TOOL'] }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ ...params, countCap: 5 }))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toHaveLength(0);
  });

  it('is INVALID_REQUEST while masking is asked and the rule uses a pii property for its stop list, and runs when masking is not asked', async () => {
    const entities = [DERIVED_ENTITIES[0], { ...DERIVED_ENTITIES[1], pii: [{ property: 'isCommon', class: 'text' }] }];
    const { read, executor } = rig(() => ({ status: 'rows', rows: [] }), mappingWith({ entities }));
    expect(await codeOf(read(params, 25, true))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toHaveLength(0);
    expect(await codeOf(read(params, 25, false))).toBe('ok');
    expect(dataCalls(executor)).toHaveLength(1);
  });

  it('is refused before any data is read when the stable-ID index of the entity type is not online', async () => {
    const mapping = mappingWith();
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('no source');
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [] }));
    const parts = testSourceGate(mapping, { executor });
    const code = await codeOf(parts.gate.run(gateRequest({ sourceId: 'demo', templateId: DERIVED_RULE_RUN_ID, params, limit: 25, indexes: { sourceId: 'demo', entries: [] } })));
    expect(code).not.toBe('ok');
    expect(dataCalls(executor)).toHaveLength(0);
  });
});

const derivedOf = (edges: readonly GraphEdge[]) => edges.filter((edge) => edge.semantics === 'derived');
const itemOf = async (rows: readonly Record<string, unknown>[], limit = 25, mapping = mappingWith()) => {
  const { read } = rig(() => ({ status: 'rows', rows }), mapping);
  const page = await read(params, limit);
  const [item] = page.items;
  if (item === undefined) throw new Error('no item');
  return { page, nodes: item['nodes'] as { ref: { entityType: string; stableId: string } }[], edges: item['edges'] as GraphEdge[], dropped: item['dropped'] as Record<string, number> };
};

describe('the rows of a rule run', () => {
  it('give one derived edge for each other end, with the rule and its version from the mapping and the supports in chain order', async () => {
    const { edges, nodes } = await itemOf([chain('A-1', 'A-2'), chain('A-1', 'A-3', 'D-2')]);
    const derived = derivedOf(edges);
    expect(derived).toHaveLength(2);
    expect(derived[0]).toMatchObject({ semantics: 'derived', from: { entityType: 'maker', stableId: 'A-1' }, to: { entityType: 'maker', stableId: 'A-2' }, derivation: { ruleId: 'shared-tool', ruleVersion: 2 } });
    const supports = derived[0]?.derivation?.supportingEdgeRefs ?? [];
    expect(supports).toHaveLength(2);
    expect(supports.map((ref) => ('stableId' in ref ? ref.stableId : ''))).toEqual(['A-1-D-1', 'A-2-D-1']);
    expect(nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'A-2', 'A-3', 'D-1', 'D-2']);
  });

  it('give one derived edge when two rows reach the same other end', async () => {
    const { edges } = await itemOf([chain('A-1', 'A-2', 'D-1'), chain('A-1', 'A-2', 'D-2')]);
    expect(derivedOf(edges)).toHaveLength(1);
  });

  it('give no derived edge for a path whose end the mapping does not describe, and count it as not mapped', async () => {
    const a = account('A-1');
    const d = device('D-1');
    const stranger = plainNode(['Stranger'], { id: 'X-1' });
    const row = pathOf(a, [
      { relationship: uses(a, d, 'E-1'), end: d },
      { relationship: plainRelationship('USES_TOOL', stranger, d, { useId: 'E-2' }), end: stranger as never },
    ]);
    const { edges, dropped } = await itemOf([row]);
    expect(derivedOf(edges)).toHaveLength(0);
    expect(dropped['not-mapped']).toBeGreaterThan(0);
  });

  it('give an aggregate support whose member count is a lower bound when the relationship type has no stable ID', async () => {
    const a = account('A-1');
    const b = account('A-2');
    const d = device('D-1');
    const row = pathOf(a, [
      { relationship: plainRelationship('USES_TOOL', a, d), end: d },
      { relationship: plainRelationship('USES_TOOL', b, d), end: b },
    ]);
    const { edges } = await itemOf([row], 25, mappingWith({ relationships: DERIVED_AGGREGATE }));
    const supports = edges.filter((edge) => edge.semantics !== 'derived');
    expect(supports).toHaveLength(2);
    for (const support of supports) expect(support.memberCount).toMatchObject({ quality: 'lowerBound' });
    expect(derivedOf(edges)).toHaveLength(1);
    expect(derivedOf(edges)[0]?.derivation?.supportingEdgeRefs).toHaveLength(2);
  });

  it('answer the limit and report more when the read found one end beyond it, and never a shorter list passed as whole', async () => {
    const rows = ['A-2', 'A-3', 'A-4'].map((id) => chain('A-1', id));
    const { page, edges } = await itemOf(rows, 2);
    expect(page.hasMore).toBe(true);
    expect(derivedOf(edges)).toHaveLength(2);
    const whole = await itemOf(rows.slice(0, 2), 2);
    expect(whole.page.hasMore).toBe(false);
  });

  it('carry no stored edge as a derived one: the supports stay stored edges', async () => {
    const { edges } = await itemOf([chain('A-1', 'A-2')]);
    expect(edges.filter((edge) => edge.semantics === 'stored')).toHaveLength(2);
  });
});

describe('the redact stage over a rule run', () => {
  it('drops a derived edge whose end the person cannot see, counts it as not visible and says so in the warnings, and keeps the others', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [chain('A-1', 'O-1', 'D-1'), chain('A-1', 'O-2', 'D-2')] }), mappingWith(), hidingRedact('O-1', redactItems));
    const [item] = (await read(params)).items;
    const edges = (item?.['edges'] ?? []) as GraphEdge[];
    expect(derivedOf(edges).map((edge) => edge.to.stableId)).toEqual(['O-2']);
    expect((item?.['dropped'] as Record<string, number>)['not-visible']).toBe(1);
    expect(item?.['warnings']).toContain('1 derived edge was left out because their ends or supports are not shown.');
  });
});
