import { PRESET_TEMPLATES } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { sharedMappingOf } from '../testing/shared-attribute-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { allowlistFromMapping } from './allowlist.js';
import { createTemplateCatalog } from './catalog.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { isNormalizedSharedCount } from './normalize/shared-attribute-count.js';
import { SHARED_ATTRIBUTE_COUNT_ID, sharedAttributeCountTemplate } from './templates/shared-attribute-count.js';
import { sharedAttributeHeadOf, sharedAttributeRequestOf, sharedAttributeStatementOf } from './templates/shared-attribute-statement.js';

function rig(answer: (call: ExecuteCall) => ExecuteOutcome = () => ({ status: 'rows', rows: [{ matches: 0, anchorBounded: false, skipped: false }] })) {
  const mapping = sharedMappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor });
  const read = (params: unknown) => parts.gate.run(gateRequest({ sourceId: 'demo', templateId: SHARED_ATTRIBUTE_COUNT_ID, params, limit: 1, indexes: { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) } }));
  return { ...parts, read, executor, source, mapping };
}

const allowlistOf = (mapping: ReturnType<typeof sharedMappingOf>) => {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  return allowlistFromMapping(source);
};

const params = { entityType: 'maker', stableId: 'A-1', attributeType: 'tool', via: 'USES_TOOL' };

describe('the statement of the count of a shared-attribute run', () => {
  it('is written from the mapping with quoted names, begins with the clauses of the run, stops at the count cap plus one, and holds only the values as parameters', async () => {
    const { read, executor, mapping } = rig();
    await read({ ...params, minShared: 2 });
    const [call] = executor.calls.filter((entry) => entry.templateId === SHARED_ATTRIBUTE_COUNT_ID);
    const allowlist = allowlistOf(mapping);
    const head = sharedAttributeHeadOf(allowlist, sharedAttributeRequestOf(allowlist, params));
    expect(call?.cypher.split('\n').slice(0, head.length)).toEqual(head);
    expect(call?.cypher.split('\n').slice(head.length)).toEqual([
      'CALL { WITH a, xs UNWIND xs AS x MATCH (x)<-[rb:`USES_TOOL`]-(b:`Maker`) WHERE b <> a WITH DISTINCT a, b CALL { WITH a, b MATCH (b)-[rc:`USES_TOOL`]->(y:`Tool`)<-[ra:`USES_TOOL`]-(a) WHERE coalesce(y.`isCommon`, false) <> true WITH DISTINCT y LIMIT $minShared RETURN count(y) AS shared } WITH b, shared WHERE shared >= $minShared WITH b LIMIT $countCap + 1 RETURN count(b) AS matches }',
      'RETURN matches, anchorBounded, skipped',
    ]);
    expect(call?.cypher).toContain('LIMIT $countCap + 1');
    expect(call?.cypher).not.toContain('A-1');
    expect(call?.cypher).not.toContain('$limit');
    expect(call?.parameters).toMatchObject({ stableId: 'A-1', minShared: 2 });
    expect(call?.parameters).toHaveProperty('countCap');
    for (const name of ['entityType', 'attributeType', 'via']) expect(call?.parameters).not.toHaveProperty(name);
    expect(call?.accessMode).toBe('READ');
  });

  it('shares its first clauses with the statement of the run, written by the one helper', async () => {
    const mapping = sharedMappingOf();
    const allowlist = allowlistOf(mapping);
    const request = sharedAttributeRequestOf(allowlist, params);
    const head = sharedAttributeHeadOf(allowlist, request).join('\n');
    expect(sharedAttributeStatementOf(allowlist, request).startsWith(head)).toBe(true);
  });

  it('applies a window to both reads of the matches, as the run does', async () => {
    const { read, executor } = rig();
    await read({ ...params, windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' });
    const [call] = executor.calls.filter((entry) => entry.templateId === SHARED_ATTRIBUTE_COUNT_ID);
    expect(call?.cypher.match(/datetime\(\$windowFrom\)/g)?.length).toBe(4);
    expect(call?.parameters).toMatchObject({ windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' });
  });
});

describe('what the count returns', () => {
  it('is a number and two flags only, never an entity, a stable ID or a relationship', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [{ matches: 501, anchorBounded: true, skipped: true, b: { elementId: 'e-1' } }] }));
    const page = await read(params);
    const [item] = page.items;
    expect(isNormalizedSharedCount(item)).toBe(true);
    expect(Object.keys(item as object).sort()).toEqual(['anchorBounded', 'anchorFound', 'estimateKind', 'matches', 'skipped', 'usable']);
    expect(item).toMatchObject({ anchorFound: true, usable: true, matches: 501, anchorBounded: true, skipped: true });
    expect(JSON.stringify(page)).not.toContain('e-1');
  });

  it('says the anchor was not found when no row comes back, and a row without a usable number is not usable', async () => {
    const none = await rig(() => ({ status: 'rows', rows: [] })).read(params);
    expect(none.items[0]).toMatchObject({ anchorFound: false, usable: false, matches: 0 });
    for (const matches of [undefined, -1, 1.5, '3']) {
      const page = await rig(() => ({ status: 'rows', rows: [{ matches, anchorBounded: false, skipped: false }] })).read(params);
      expect(page.items[0]).toMatchObject({ anchorFound: true, usable: false });
    }
  });

  it('declares its own audit action', async () => {
    expect(sharedAttributeCountTemplate.auditAction).toBe('entity.shared_attribute_count');
  });
});

describe('the count in the catalog', () => {
  it('is not a template a pattern can bind, has no name or description to list or plan from, and cannot be named by a preset', () => {
    expect(PRESET_TEMPLATES).not.toContain(SHARED_ATTRIBUTE_COUNT_ID);
    expect(sharedAttributeCountTemplate.name).toBeUndefined();
    expect(sharedAttributeCountTemplate.description).toBeUndefined();
    expect(() => sharedMappingOf({ patterns: [{ id: 'p', name: 'P', template: SHARED_ATTRIBUTE_COUNT_ID, bind: { anchor: 'maker', attribute: 'tool', via: 'USES_TOOL' } }] })).toThrow();
  });

  it('refuses a statement that is more than its one marker, which is where a request value could be written in', () => {
    expect(() => createTemplateCatalog({ templates: [{ ...sharedAttributeCountTemplate, cypher: '@sharedAttribute(attributeType) RETURN $stableId' }] })).toThrow(/not exactly its one shared attribute marker/);
  });
});
