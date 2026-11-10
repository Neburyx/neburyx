import { describe, expect, it } from 'vitest';
import type { GraphEdge } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import { account, chain, hidingEdgeRedact, hidingRedact, DERIVED_AGGREGATE, DERIVED_ENTITIES, DERIVED_RULE, DERIVED_STORED, device, pathOf } from '../testing/derived-fixtures.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainRelationship } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { redactItems } from './redact/index.js';
import { DERIVED_EDGE_SUPPORT_ID } from './templates/derived-edge-support.js';
import { isNormalizedSupports } from './normalize/derived-run.js';

function mappingWith(overrides: Record<string, unknown> = {}) {
  return parseMapping(fileOf(baseSource({ id: 'demo', entities: DERIVED_ENTITIES, relationships: DERIVED_STORED, derived: [DERIVED_RULE], ...overrides })), 'neburyx.yaml');
}

function rig(answer: (call: ExecuteCall) => ExecuteOutcome, mapping = mappingWith(), redact?: Parameters<typeof testSourceGate>[1] extends infer O ? (O extends { redact?: infer R } ? R : never) : never) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor, ...(redact === undefined ? {} : { redact }) });
  const read = (params: unknown, limit = 25, mask?: boolean) =>
    parts.gate.run(gateRequest({ sourceId: 'demo', templateId: DERIVED_EDGE_SUPPORT_ID, params, limit, ...(mask === undefined ? {} : { mask }), indexes: { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) } }));
  return { ...parts, read, executor };
}

const end = (stableId: string) => ({ sourceId: 'demo', entityType: 'maker', stableId });
const params = { ruleId: 'shared-tool', ends: [end('A-1'), end('A-2')] };
const dataCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === DERIVED_EDGE_SUPPORT_ID);
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
};
const derivedOf = (edges: readonly GraphEdge[]) => edges.filter((edge) => edge.semantics === 'derived');

async function itemOf(rows: readonly Record<string, unknown>[], limit = 25, mapping = mappingWith()) {
  const { read } = rig(() => ({ status: 'rows', rows }), mapping);
  const page = await read(params, limit);
  const [item] = page.items;
  if (item === undefined || !isNormalizedSupports(item as never)) throw new Error('no supports item');
  const supports = item as unknown as { edges: GraphEdge[]; chains: { middle: { stableId: string }[]; supports: unknown[] }[]; lost: number; dropped: Record<string, number>; warnings: string[]; evidence: unknown[] };
  return { page, ...supports };
}

describe('the statement of the supports of a derived relationship', () => {
  it('is written from the rule with both ends fixed, quoted names and the bound, and holds only values as parameters', async () => {
    const { read, executor } = rig(() => ({ status: 'rows', rows: [] }));
    await read(params);
    const [call] = dataCalls(executor);
    expect(call?.cypher).toBe(
      [
        'MATCH (a:`Maker`) WHERE a.`makerId` IN [$ends[0].stableId, $ends[0].stableInteger] WITH a ORDER BY elementId(a) LIMIT 1',
        'MATCH (b:`Maker`) WHERE b.`makerId` IN [$ends[1].stableId, $ends[1].stableInteger] WITH a, b ORDER BY elementId(b) LIMIT 1',
        'CALL { WITH a, b MATCH (a)-[:`USES_TOOL`]-(m1:`Tool`)-[:`USES_TOOL`]-(b:`Maker`) WHERE b <> a AND coalesce(m1.`isCommon`, false) <> true RETURN DISTINCT m1 LIMIT $limit + 1 }',
        'CALL { WITH a, b, m1 MATCH p = (a)-[:`USES_TOOL`]-(m1:`Tool`)-[:`USES_TOOL`]-(b:`Maker`) RETURN p LIMIT 1 }',
        'RETURN p',
      ].join('\n'),
    );
    expect(call?.cypher).not.toContain('A-1');
    expect(call?.parameters).toMatchObject({ limit: 25 });
    expect(call?.accessMode).toBe('READ');
  });

  it('returns every tuple of middle entities of a longer chain, so parallel relationships are one tuple', async () => {
    const mapping = mappingWith({ derived: [{ id: 'long', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL', 'maker', 'USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 1 }] });
    const { read, executor } = rig(() => ({ status: 'rows', rows: [] }), mapping);
    await read({ ...params, ruleId: 'long' });
    const cypher = dataCalls(executor)[0]?.cypher ?? '';
    expect(cypher).toContain('RETURN DISTINCT m1, m2, m3 LIMIT $limit + 1 }');
    expect(cypher).toContain('CALL { WITH a, b, m1, m2, m3 MATCH p = ');
  });
});

describe('a request for the supports', () => {
  it('is INVALID_REQUEST, and reads nothing, for a rule not in the mapping, ends of other types, a list of one end or a field the request may not hold', async () => {
    const { read, executor } = rig(() => ({ status: 'rows', rows: [] }));
    expect(await codeOf(read({ ...params, ruleId: 'unknown' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ ...params, ends: [end('A-1'), { ...end('T-1'), entityType: 'tool' }] }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ ...params, ends: [{ ...end('T-1'), entityType: 'tool' }, end('A-2')] }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ ...params, ends: [end('A-1')] }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ ...params, via: ['USES_TOOL'] }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ ...params, ends: [end('A-1'), { ...end('A-2'), sourceId: 'other' }] }))).toBe('SOURCE_MISMATCH');
    expect(dataCalls(executor)).toHaveLength(0);
  });

  it('is INVALID_REQUEST while masking is asked and the rule uses a pii property for its stop list', async () => {
    const entities = [DERIVED_ENTITIES[0], { ...DERIVED_ENTITIES[1], pii: [{ property: 'isCommon', class: 'text' }] }];
    const { read, executor } = rig(() => ({ status: 'rows', rows: [] }), mappingWith({ entities }));
    expect(await codeOf(read(params, 25, true))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toHaveLength(0);
    expect(await codeOf(read(params, 25, false))).toBe('ok');
  });

  it('is refused before any data is read when the stable-ID index of an end is not online', async () => {
    const mapping = mappingWith();
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [] }));
    const parts = testSourceGate(mapping, { executor });
    const code = await codeOf(parts.gate.run(gateRequest({ sourceId: 'demo', templateId: DERIVED_EDGE_SUPPORT_ID, params, limit: 25, indexes: { sourceId: 'demo', entries: [] } })));
    expect(code).not.toBe('ok');
    expect(dataCalls(executor)).toHaveLength(0);
  });
});

describe('the rows of the supports', () => {
  it('give one derived edge that names the supports of every chain, in the order of the chains, and one chain for each row', async () => {
    const { edges, chains } = await itemOf([chain('A-1', 'A-2', 'D-1'), chain('A-1', 'A-2', 'D-2'), chain('A-1', 'A-2', 'D-3')]);
    const derived = derivedOf(edges);
    expect(derived).toHaveLength(1);
    expect(derived[0]?.derivation?.supportingEdgeRefs.map((ref) => ('stableId' in ref ? ref.stableId : ''))).toEqual(['A-1-D-1', 'A-2-D-1', 'A-1-D-2', 'A-2-D-2', 'A-1-D-3', 'A-2-D-3']);
    expect(chains.map((entry) => entry.middle.map((middle) => middle.stableId))).toEqual([['D-1'], ['D-2'], ['D-3']]);
  });

  it('give the records of a stored support and an aggregate support with no stable ID and no member value', async () => {
    const a = account('A-1');
    const b = account('A-2');
    const d = device('D-1');
    const row = pathOf(a, [
      { relationship: plainRelationship('USES_TOOL', a, d), end: d },
      { relationship: plainRelationship('USES_TOOL', b, d), end: b },
    ]);
    const { edges, chains } = await itemOf([row], 25, mappingWith({ relationships: DERIVED_AGGREGATE }));
    expect(chains[0]?.supports).toHaveLength(2);
    expect(edges.filter((edge) => 'aggregate' in edge.ref)).toHaveLength(2);
    expect(derivedOf(edges)).toHaveLength(1);
  });

  it('answer the limit and report the cut when the read found one chain beyond it', async () => {
    const rows = ['D-1', 'D-2', 'D-3'].map((via) => chain('A-1', 'A-2', via));
    const cut = await itemOf(rows, 2);
    expect(cut.page.hasMore).toBe(true);
    expect(cut.chains).toHaveLength(2);
    const whole = await itemOf(rows.slice(0, 2), 2);
    expect(whole.page.hasMore).toBe(false);
  });

  it('leave out a chain the normalizer cannot account for, say so in the warnings and count it as lost', async () => {
    const stranger = { ...account('X-9'), labels: ['Stranger'] };
    const a = account('A-1');
    const d = device('D-9');
    const bad = pathOf(a, [
      { relationship: plainRelationship('USES_TOOL', a, d, { useId: 'E-1' }), end: d },
      { relationship: plainRelationship('USES_TOOL', stranger, d, { useId: 'E-2' }), end: stranger as never },
    ]);
    const { chains, lost, dropped, edges } = await itemOf([chain('A-1', 'A-2', 'D-1'), bad]);
    expect(chains).toHaveLength(1);
    expect(lost).toBe(1);
    expect(dropped['not-mapped']).toBeGreaterThan(0);
    expect(derivedOf(edges)).toHaveLength(1);
  });

  it('give no derived edge when no chain holds', async () => {
    const { edges, chains } = await itemOf([]);
    expect(derivedOf(edges)).toHaveLength(0);
    expect(chains).toHaveLength(0);
  });
});

describe('the redact stage over the supports', () => {
  const rows = [chain('A-1', 'A-2', 'D-1'), chain('A-1', 'A-2', 'D-2'), chain('A-1', 'A-2', 'D-3')];
  const edgesOf = async (hidden: string) => {
    const { read } = rig(() => ({ status: 'rows', rows }), mappingWith(), hidingRedact(hidden, redactItems));
    const [item] = (await read(params)).items;
    return { edges: (item?.['edges'] ?? []) as GraphEdge[], dropped: item?.['dropped'] as Record<string, number>, warnings: item?.['warnings'] as string[] };
  };

  it('keeps the derived edge when every end, middle entity and support is shown', async () => {
    expect(derivedOf((await edgesOf('nobody')).edges)).toHaveLength(1);
  });

  it('drops the derived edge when an end is hidden', async () => {
    const { edges, dropped } = await edgesOf('A-2');
    expect(derivedOf(edges)).toHaveLength(0);
    expect(dropped).not.toHaveProperty('not-visible');
  });

  it('drops the derived edge when the middle entity of any one chain is hidden, though its support edges are shown', async () => {
    const { edges, dropped, warnings } = await edgesOf('D-2');
    expect(derivedOf(edges)).toHaveLength(0);
    expect(dropped).not.toHaveProperty('not-visible');
    expect(warnings.join(' ')).not.toMatch(/left out|not shown/);
  });

  it('drops the derived edge when a supporting edge is hidden and both its ends are shown', async () => {
    const { read } = rig(() => ({ status: 'rows', rows }), mappingWith(), hidingEdgeRedact('A-2-D-2', redactItems));
    const [item] = (await read(params)).items;
    expect(derivedOf((item?.['edges'] ?? []) as GraphEdge[])).toHaveLength(0);
    expect(item?.['dropped']).not.toHaveProperty('not-visible');
  });

  it('does not check a chain past the limit, because it is not read: the read is trimmed to the limit before it is normalized', async () => {
    const { read } = rig(() => ({ status: 'rows', rows }), mappingWith(), hidingRedact('D-3', redactItems));
    const page = await read(params, 2);
    const [item] = page.items;
    expect(page.hasMore).toBe(true);
    expect(derivedOf((item?.['edges'] ?? []) as GraphEdge[])).toHaveLength(1);
  });
});
