import { PRESET_TEMPLATES } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { createTemplateCatalog } from './catalog.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { isNormalizedLinkedCount } from './normalize/linked-entities-count.js';
import { LINKED_ENTITIES_COUNT_ID, linkedEntitiesCountTemplate } from './templates/linked-entities-count.js';

function rig(answer: (call: ExecuteCall) => ExecuteOutcome = () => ({ status: 'rows', rows: [{ matches: 0, frontierBounded: false, supernodeSkipped: false }] })) {
  const mapping = linkedMappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor });
  const read = (params: unknown) => parts.gate.run(gateRequest({ sourceId: 'demo', templateId: LINKED_ENTITIES_COUNT_ID, params, limit: 1, indexes: { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) } }));
  return { ...parts, read, executor };
}

const params = { entityType: 'maker', stableId: 'A-1', targetType: 'maker', via: ['LINKS'], direction: 'out' };
const statementOf = async (extra: Record<string, unknown>): Promise<ExecuteCall | undefined> => {
  const { read, executor } = rig();
  await read({ ...params, ...extra });
  return executor.calls.find((call) => call.templateId === LINKED_ENTITIES_COUNT_ID);
};

describe('the statement of the count of a linked-entities run', () => {
  it('for one hop reads the matching neighbors of the anchor, distinct, stops at the count cap plus one and counts them; it reads nothing else and holds only the values as parameters', async () => {
    const call = await statementOf({});
    const lines = call?.cypher.split('\n') ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('MATCH (a:`Maker`)');
    expect(lines[1]).toMatch(/^CALL \{ WITH a CALL \{ WITH a MATCH \(a\)-\[r:`LINKS`\]->\(n:`Maker`\) WHERE n <> a RETURN n, r, true AS isTarget \} WITH DISTINCT n LIMIT \$countCap \+ 1 RETURN count\(n\) AS matches \}$/);
    expect(lines[2]).toBe('RETURN matches, false AS frontierBounded, false AS supernodeSkipped');
    expect(call?.cypher).toContain('LIMIT $countCap + 1');
    expect(call?.cypher).not.toContain('A-1');
    expect(call?.cypher).not.toContain('$limit');
    expect(call?.cypher).not.toContain('*');
    expect(call?.parameters).toMatchObject({ stableId: 'A-1' });
    expect(call?.parameters).toHaveProperty('countCap');
    for (const name of ['entityType', 'targetType', 'via']) expect(call?.parameters).not.toHaveProperty(name);
    expect(call?.accessMode).toBe('READ');
  });

  it('for two hops reads the frontier and the degree of each middle entity as the run does, then streams the distinct matches, at most the count cap plus one, with no variable-length pattern', async () => {
    for (const direction of ['out', 'in', 'both']) {
      const call = await statementOf({ maxHops: 2, direction });
      const text = call?.cypher ?? '';
      expect(text, direction).toContain('LIMIT $countCap + 1 WITH collect({n: n, isTarget: isTarget}) AS found');
      expect(text, direction).toContain('count(*) AS c0');
      expect(text, direction).toContain('WITH DISTINCT x LIMIT $countCap + 1 RETURN count(x) AS matches');
      expect(text, direction).toContain('RETURN n AS x UNION ALL');
      expect(text, direction).toContain('RETURN matches, frontierBounded, size(heavy) > 0 OR stopListed AS supernodeSkipped');
      expect(text, direction).not.toMatch(/\*\d|\*\.\./);
      expect(text, direction).not.toContain('A-1');
      expect(text, direction).not.toContain('ORDER BY entry');
    }
  });

  it('applies a window to the steps that have a time, as the run does', async () => {
    const call = await statementOf({ windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' });
    expect(call?.cypher).toContain('datetime($windowFrom)');
    expect(call?.parameters).toMatchObject({ windowFrom: '2026-01-01T00:00:00.000Z' });
  });
});

describe('what the count of a linked-entities run returns', () => {
  it('is a number and two flags only, never an entity, a stable ID or a relationship', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [{ matches: 4, frontierBounded: true, supernodeSkipped: true, x: { elementId: 'e-9' } }] }));
    const page = await read(params);
    const [item] = page.items;
    expect(isNormalizedLinkedCount(item)).toBe(true);
    expect(Object.keys(item as object).sort()).toEqual(['anchorFound', 'estimateKind', 'frontierBounded', 'matches', 'supernodeSkipped', 'usable']);
    expect(item).toMatchObject({ anchorFound: true, usable: true, matches: 4, frontierBounded: true, supernodeSkipped: true });
    expect(JSON.stringify(page)).not.toContain('e-9');
  });

  it('says the anchor was not found when no row comes back, and a row without a usable number is not usable', async () => {
    expect((await rig(() => ({ status: 'rows', rows: [] })).read(params)).items[0]).toMatchObject({ anchorFound: false, usable: false });
    expect((await rig(() => ({ status: 'rows', rows: [{ frontierBounded: false }] })).read(params)).items[0]).toMatchObject({ anchorFound: true, usable: false });
  });

  it('is refused for a hop count above the cap before anything is read, as the run is', async () => {
    const { read, executor } = rig();
    await expect(read({ ...params, maxHops: 3 })).rejects.toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED' });
    expect(executor.calls.filter((call) => call.templateId === LINKED_ENTITIES_COUNT_ID)).toHaveLength(0);
  });
});

describe('the count in the catalog', () => {
  it('is not a template a pattern can bind and has no name or description to list or plan from', () => {
    expect(PRESET_TEMPLATES).not.toContain(LINKED_ENTITIES_COUNT_ID);
    expect(linkedEntitiesCountTemplate.name).toBeUndefined();
    expect(linkedEntitiesCountTemplate.description).toBeUndefined();
  });

  it('refuses a statement that is more than its one marker', () => {
    expect(() => createTemplateCatalog({ templates: [{ ...linkedEntitiesCountTemplate, cypher: '@linkedEntities(targetType) RETURN $stableId' }] })).toThrow(/not exactly its one linked entities marker/);
  });
});
