import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, patternMappingOf, patternParams, step } from '../testing/pattern-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { PATTERN_ID } from './templates/pattern.js';
import { DERIVED_RULE } from '../testing/derived-fixtures.js';

function rig(mapping = patternMappingOf(), answer: (call: ExecuteCall) => ExecuteOutcome = () => ({ status: 'rows', rows: [] })) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor });
  const read = (params: unknown, extra: Record<string, unknown> = {}, limit = 25) =>
    parts.gate.run(gateRequest({ sourceId: 'demo', templateId: PATTERN_ID, params, limit, indexes: { sourceId: source.id, entries: onlineIndexesOf(source) }, ...extra }));
  return { ...parts, read, executor };
}

const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
};
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await failureOf(promise);
  return error === undefined ? 'ok' : error instanceof AppError ? error.code : 'not an AppError';
};
const dataCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === PATTERN_ID);
const many = (count: number) => Array.from({ length: count }, () => step());

describe('the pattern template at the gate', () => {
  it('runs one statement in a read call, with the values as parameters, the count cap and the limit', async () => {
    const { read, executor } = rig();
    await read(patternParams([step({ windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' })]), {}, 10);
    const [call] = dataCalls(executor);
    expect(call).toMatchObject({ accessMode: 'READ' });
    expect(call?.parameters).toMatchObject({ stableId: 'A-1', limit: 10, steps: [{ windowFrom: '2026-01-01T00:00:00Z' }] });
    expect(call?.parameters).toHaveProperty('countCap');
    expect(call?.parameters).not.toHaveProperty('anchorType');
    expect(call?.cypher).not.toContain('A-1');
  });

  it('is refused by the gate for three steps on a source whose max_hops is 2, carrying 2, and by the schema for five', async () => {
    const two = rig(patternMappingOf({ max_hops: 2 }));
    expect(await failureOf(two.read(patternParams(many(3))))).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 2 } });
    expect(await codeOf(two.read(patternParams(many(2))))).toBe('ok');
    expect(await codeOf(rig(patternMappingOf({ max_hops: 4 })).read(patternParams(many(4))))).toBe('ok');
    expect(await codeOf(rig(patternMappingOf({ max_hops: 4 })).read(patternParams(many(5))))).toBe('INVALID_REQUEST');
    expect(dataCalls(two.executor)).toHaveLength(1);
  });

  it.each([
    ['an anchor type the mapping does not have', patternParams([step()], { anchorType: 'nothing' })],
    ['an arrival type the mapping does not have', patternParams([step({ arrivesAt: 'nothing' })])],
    ['a relationship type the mapping does not have', patternParams([step({ relationshipTypes: ['NOPE'] })])],
    ['a relationship type that does not join the types in the direction', patternParams([step({ relationshipTypes: ['USES_TOOL'], direction: 'in', arrivesAt: 'tool' })])],
    ['a step with no relationship type', patternParams([step({ relationshipTypes: [] })])],
    ['no steps', patternParams([])],
    ['a key the schema does not name', patternParams([step()], { extra: 1 })],
    ['a window with one instant', patternParams([step({ windowFrom: '2026-01-01T00:00:00Z' })])],
    ['a window that is not an instant', patternParams([step({ windowFrom: 'yesterday', windowTo: 'today' })])],
    ['a condition on a property that is not filterable', patternParams([step({ conditions: [{ on: 'neighbor', property: 'makerId', op: 'eq', value: { kind: 'text', value: 'x' } }] })])],
    ['a condition on a relationship property that is not filterable', patternParams([step({ conditions: [{ on: 'relationship', property: 'linkId', op: 'eq', value: { kind: 'text', value: 'x' } }] })])],
  ])('refuses %s without reading the source', async (_name, params) => {
    const { read, executor } = rig();
    expect(await codeOf(read(params))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toHaveLength(0);
  });

  it('refuses a condition on a personal-data property of the arrival type while masking is asked, and reads nothing', async () => {
    const entities = PATTERN_ENTITIES.map((entity) => (entity.type === 'maker' ? { ...entity, pii: [{ property: 'region', class: 'text' }] } : entity));
    const personal = linkedMappingOf({ entities, relationships: PATTERN_RELATIONSHIPS, derived: [DERIVED_RULE], patterns: [] });
    const params = patternParams([step({ conditions: [{ on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'x' } }] })]);
    const masked = rig(personal);
    expect(await codeOf(masked.read(params, { mask: true }))).toBe('INVALID_REQUEST');
    expect(dataCalls(masked.executor)).toHaveLength(0);
    expect(await codeOf(rig(personal).read(params, { mask: false }))).toBe('ok');
  });
});
