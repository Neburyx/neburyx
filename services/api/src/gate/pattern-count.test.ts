import { PRESET_TEMPLATES } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, patternMappingOf, patternParams, step } from '../testing/pattern-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { DERIVED_RULE } from '../testing/derived-fixtures.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { createTemplateCatalog } from './catalog.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { isNormalizedPatternCount, normalizePatternCount } from './normalize/pattern-count.js';
import { PATTERN_COUNT_ID, patternCountTemplate } from './templates/pattern-count.js';
import { patternTemplate } from './templates/pattern.js';

const COUNT_ROW = { matches: 0, bounded: false, stopListed: false, supernodes: 0 };

function rig(mapping = patternMappingOf(), answer: (call: ExecuteCall) => ExecuteOutcome = () => ({ status: 'rows', rows: [COUNT_ROW] })) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor });
  const read = (params: unknown, extra: Record<string, unknown> = {}) =>
    parts.gate.run(gateRequest({ sourceId: 'demo', templateId: PATTERN_COUNT_ID, params, limit: 1, indexes: { sourceId: source.id, entries: onlineIndexesOf(source) }, ...extra }));
  return { ...parts, read, executor };
}

const countCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === PATTERN_COUNT_ID);
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
};

describe('the count of a pattern run at the gate', () => {
  it('runs one statement in a read call with the values as parameters and the count cap, and holds none of the values', async () => {
    const { read, executor } = rig();
    await read(patternParams([step({ windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' })]));
    const [call] = countCalls(executor);
    expect(call).toMatchObject({ accessMode: 'READ' });
    expect(call?.parameters).toMatchObject({ stableId: 'A-1', steps: [{ windowFrom: '2026-01-01T00:00:00Z' }] });
    expect(call?.parameters).toHaveProperty('countCap');
    expect(call?.cypher).toContain('LIMIT $countCap + 1 RETURN count(n1) AS matches');
    expect(call?.cypher).not.toContain('A-1');
    expect(call?.cypher).not.toContain('$limit');
  });

  it('is refused for more steps than the source allows before anything is read, as the run is', async () => {
    const { read, executor } = rig(patternMappingOf({ max_hops: 2 }));
    expect(await codeOf(read(patternParams([step(), step(), step()])))).toBe('QUERY_BUDGET_EXCEEDED');
    expect(countCalls(executor)).toHaveLength(0);
  });

  it('refuses a condition on a personal-data property while masking is asked, as the run does, and reads nothing', async () => {
    const entities = PATTERN_ENTITIES.map((entity) => (entity.type === 'maker' ? { ...entity, pii: [{ property: 'region', class: 'text' }] } : entity));
    const personal = linkedMappingOf({ entities, relationships: PATTERN_RELATIONSHIPS, derived: [DERIVED_RULE], patterns: [] });
    const params = patternParams([step({ conditions: [{ on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'x' } }] })]);
    const masked = rig(personal);
    expect(await codeOf(masked.read(params, { mask: true }))).toBe('INVALID_REQUEST');
    expect(countCalls(masked.executor)).toHaveLength(0);
    expect(await codeOf(rig(personal).read(params, { mask: false }))).toBe('ok');
  });

  it.each([
    ['is timed out', { status: 'timeout' as const }, 'QUERY_TIMEOUT'],
    ['is unreachable', { status: 'unavailable' as const, reason: 'unreachable' as const }, 'SOURCE_UNAVAILABLE'],
  ])('is the error of the failure when the read %s', async (_name, outcome, code) => {
    const { read } = rig(patternMappingOf(), () => outcome);
    expect(await codeOf(read(patternParams([step()])))).toBe(code);
  });

  it('is ACCESS_DENIED when the person may not read the source, and nothing is read', async () => {
    const defaults = communitySeams();
    const mapping = patternMappingOf();
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('the mapping has no source');
    const executor = new TestExecutor(withOnlineIndexes(source, () => Promise.resolve({ status: 'rows', rows: [COUNT_ROW] })));
    const parts = testSourceGate(mapping, { executor, seams: { policy: { authorizeSource: () => Promise.resolve({ allowed: false as const, reason: 'no' }) }, coordinator: defaults.coordinator, audit: defaults.audit } });
    const read = parts.gate.run(gateRequest({ sourceId: 'demo', templateId: PATTERN_COUNT_ID, params: patternParams([step()]), limit: 1, indexes: { sourceId: source.id, entries: onlineIndexesOf(source) } }));
    expect(await codeOf(read)).toBe('ACCESS_DENIED');
    expect(countCalls(executor)).toHaveLength(0);
  });

  it('is audited as its own call, with the action of the count', async () => {
    const events: AuditEvent[] = [];
    const defaults = communitySeams();
    const mapping = patternMappingOf();
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('the mapping has no source');
    const executor = new TestExecutor(withOnlineIndexes(source, () => Promise.resolve({ status: 'rows', rows: [COUNT_ROW] })));
    const parts = testSourceGate(mapping, { executor, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event) => (events.push(event), Promise.resolve()) } } });
    await parts.gate.run(gateRequest({ sourceId: 'demo', templateId: PATTERN_COUNT_ID, params: patternParams([step()]), limit: 1, indexes: { sourceId: source.id, entries: onlineIndexesOf(source) } }));
    expect(events.map((event) => event.action)).toContain('pattern.count');
  });
});

describe('what the count of a pattern run returns', () => {
  it('is numbers and flags only, never an entity, a stable ID or a relationship', async () => {
    const { read } = rig(patternMappingOf(), () => ({ status: 'rows', rows: [{ matches: 4, bounded: true, stopListed: true, supernodes: 2, x: { elementId: 'e-9' }, a: { elementId: 'e-8' } }] }));
    const page = await read(patternParams([step()]));
    const [item] = page.items;
    expect(isNormalizedPatternCount(item)).toBe(true);
    expect(Object.keys(item as object).sort()).toEqual(['anchorFound', 'bounded', 'estimateKind', 'matches', 'stopListed', 'supernodes', 'usable']);
    expect(item).toMatchObject({ anchorFound: true, usable: true, matches: 4, bounded: true, stopListed: true, supernodes: 2 });
    expect(JSON.stringify(page)).not.toContain('e-9');
    expect(JSON.stringify(page)).not.toContain('e-8');
  });

  it('says the anchor was not found when no row comes back, and a row without a usable number is not usable', () => {
    expect(normalizePatternCount([])).toMatchObject({ anchorFound: false, usable: false, matches: 0 });
    expect(normalizePatternCount([{ bounded: false }])).toMatchObject({ anchorFound: true, usable: false, matches: 0 });
    for (const bad of [-1, 1.5, '3', null, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(normalizePatternCount([{ matches: bad }]), String(bad)).toMatchObject({ usable: false, matches: 0 });
  });

  it('takes a flag only when it is true and a supernode count only when it is a whole number', () => {
    expect(normalizePatternCount([{ matches: 1, bounded: 'yes', stopListed: 1, supernodes: -3 }])).toMatchObject({ bounded: false, stopListed: false, supernodes: 0 });
  });
});

describe('the count in the catalog', () => {
  it('is not a template a pattern can bind, is not the pattern template and has no name or description to list or plan from', () => {
    expect(PRESET_TEMPLATES).not.toContain(PATTERN_COUNT_ID);
    expect(patternCountTemplate.name).toBeUndefined();
    expect(patternCountTemplate.description).toBeUndefined();
    expect(patternCountTemplate.auditAction).toBe('pattern.count');
    expect(patternCountTemplate.id).not.toBe(patternTemplate.id);
  });

  it('declares what the run declares, so the reads its login needs are the run’s and no more', () => {
    for (const key of ['hops', 'paramsSchema', 'entityParams', 'referenceParams', 'relationshipParams', 'indexNeeds', 'usedProperties', 'scope'] as const) expect(patternCountTemplate[key], key).toBe(patternTemplate[key]);
    expect(patternCountTemplate).toMatchObject({ version: '1', paged: false, cutMeans: 'lowerBound' });
    expect(patternCountTemplate.nextPosition).toBeUndefined();
    expect(patternCountTemplate.referencePositions).toBeUndefined();
  });

  it('refuses a statement that is more than its one marker', () => {
    expect(() => createTemplateCatalog({ templates: [{ ...patternCountTemplate, cypher: '@pattern(anchorType) RETURN $stableId' }] })).toThrow(/not exactly its one pattern marker/);
  });
});
