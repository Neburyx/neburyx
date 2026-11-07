import { describe, expect, it } from 'vitest';
import { gateRequest, harness, TestExecutor } from '../testing/gate.js';
import { parseMapping } from '../mapping/load.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { normalizedOf, searchModelOf, withOnlineIndexes, type StoredNode } from '../testing/search-fixtures.js';
import { allowlistFromMapping } from './allowlist.js';
import { createTemplateCatalog } from './catalog.js';
import { normalizeModelOf } from './normalize/model.js';
import { schemaIndexesTemplate } from './templates/schema-indexes.js';
import { SEARCH_EXACT_ID, searchExactTemplate } from './templates/search-exact.js';

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId', 'ownerName'], pii: [{ property: 'ownerName', class: 'name' }] }],
      relationships: [],
    }),
  ),
  'neburyx.yaml',
);
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const SHARED: StoredNode = { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'X-1', ownerName: 'X-1' } };
const OTHERS: readonly StoredNode[] = ['A2', 'A3', 'A4'].map((id, index) => ({ elementId: `4:s:${index + 2}`, label: 'Widget', properties: { widgetId: id, ownerName: 'X-1' } }));
const TARGETS = [
  { entityType: 'widget', property: 'widgetId', match: 'value' },
  { entityType: 'widget', property: 'ownerName', match: 'value' },
];

function rig() {
  const executor = new TestExecutor(withOnlineIndexes(source, searchModelOf([SHARED, ...OTHERS])));
  const parts = harness({
    catalog: createTemplateCatalog({ templates: [searchExactTemplate, schemaIndexesTemplate] }),
    executor,
    modelFor: () => normalizeModelOf(source),
    allowlistFor: () => allowlistFromMapping(source),
  });
  return { ...parts, executor };
}

const run = (limit: number) => rig().gate.run(gateRequest({ sourceId: source.id, templateId: SEARCH_EXACT_ID, params: { text: 'X-1', targets: TARGETS }, limit }));

describe('a search over two branches', () => {
  it('returns an entity that both branches match once, and cuts the combined result at the limit, not each branch', async () => {
    const page = await run(3);
    expect(normalizedOf(page).nodes.map((node) => node.ref.stableId)).toEqual(['X-1', 'A2', 'A3']);
    expect(page.hasMore).toBe(true);
  });

  it('says there is no more when the distinct matches are exactly the limit', async () => {
    const page = await run(4);
    expect(normalizedOf(page).nodes).toHaveLength(4);
    expect(page.hasMore).toBe(false);
  });

  it('asks the source for one row more than the limit and no more', async () => {
    const parts = rig();
    await parts.gate.run(gateRequest({ sourceId: source.id, templateId: SEARCH_EXACT_ID, params: { text: 'X-1', targets: TARGETS }, limit: 3 }));
    expect(parts.executor.calls.filter((call) => call.templateId === SEARCH_EXACT_ID).map((call) => call.rowLimit)).toEqual([4]);
  });

  it('asks no branch for more than the limit plus one row, however many entities carry the value', async () => {
    const many: StoredNode[] = Array.from({ length: 1000 }, (_, index) => ({ elementId: `4:m:${index}`, label: 'Widget', properties: { widgetId: `M-${index}`, ownerName: 'COMMON' } }));
    const reads: number[] = [];
    const executor = new TestExecutor(withOnlineIndexes(source, searchModelOf(many, (rows) => void reads.push(rows))));
    const parts = harness({ catalog: createTemplateCatalog({ templates: [searchExactTemplate, schemaIndexesTemplate] }), executor, modelFor: () => normalizeModelOf(source), allowlistFor: () => allowlistFromMapping(source) });
    const page = await parts.gate.run(gateRequest({ sourceId: source.id, templateId: SEARCH_EXACT_ID, params: { text: 'COMMON', targets: TARGETS }, limit: 25 }));
    expect(reads).toEqual([0, 26]);
    expect(normalizedOf(page).nodes).toHaveLength(25);
    expect(page.hasMore).toBe(true);
  });
});

describe('a search over the targets of two entity types whose labels a node carries both of', () => {
  const twoTypes = parseMapping(
    fileOf(
      baseSource({
        id: 'demo',
        entities: [
          { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['code'] },
          { type: 'gadget ü', label: 'Gadget', stable_id: 'gadgetId', search: ['code'] },
          { type: 'twin', label: 'Widget', stable_id: 'twinId', search: ['code'] },
        ],
        relationships: [],
      }),
    ),
    'neburyx.yaml',
  ).sources[0];
  if (twoTypes === undefined) throw new Error('the mapping has no source');
  const BOTH: StoredNode = { elementId: '4:b:1', label: 'Widget', alsoLabels: ['Gadget'], properties: { code: 'C-1', widgetId: 'W-1', gadgetId: 'GD-1', twinId: 'T-1' } };
  const search = (targets: readonly object[]) => {
    const executor = new TestExecutor(withOnlineIndexes(twoTypes, searchModelOf([BOTH])));
    const parts = harness({ catalog: createTemplateCatalog({ templates: [searchExactTemplate, schemaIndexesTemplate] }), executor, modelFor: () => normalizeModelOf(twoTypes), allowlistFor: () => allowlistFromMapping(twoTypes) });
    return parts.gate.run(gateRequest({ sourceId: twoTypes.id, templateId: SEARCH_EXACT_ID, params: { text: 'C-1', targets }, limit: 25 }));
  };
  const code = (entityType: string) => ({ entityType, property: 'code', match: 'value' });
  const refsOf = (page: Awaited<ReturnType<typeof search>>) => normalizedOf(page).nodes.map((node) => [node.ref.entityType, node.ref.stableId]);

  it('is a hit of the type the target names, with that type\'s stable ID, and is not counted as dropped', async () => {
    const page = await search([code('gadget ü')]);
    expect(refsOf(page)).toEqual([['gadget ü', 'GD-1']]);
    expect(normalizedOf(page).dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
  });

  it('is one hit of each type that a target of that type matched, also of two types that share a label', async () => {
    expect(refsOf(await search([code('widget'), code('gadget ü')]))).toEqual([
      ['widget', 'W-1'],
      ['gadget ü', 'GD-1'],
    ]);
    expect(refsOf(await search([code('widget'), code('twin')]))).toEqual([
      ['widget', 'W-1'],
      ['twin', 'T-1'],
    ]);
  });

  it('returns each target\'s entity type from a list parameter the gate fills, never as query text', async () => {
    const executor = new TestExecutor(withOnlineIndexes(twoTypes, searchModelOf([BOTH])));
    const parts = harness({ catalog: createTemplateCatalog({ templates: [searchExactTemplate, schemaIndexesTemplate] }), executor, modelFor: () => normalizeModelOf(twoTypes), allowlistFor: () => allowlistFromMapping(twoTypes) });
    await parts.gate.run(gateRequest({ sourceId: twoTypes.id, templateId: SEARCH_EXACT_ID, params: { text: 'C-1', targets: [code('widget'), code('gadget ü')] }, limit: 25 }));
    const call = executor.calls.find((entry) => entry.templateId === SEARCH_EXACT_ID);
    expect(call?.cypher).toContain('RETURN n, $branchEntityTypes[0] AS entityType');
    expect(call?.cypher).toContain('RETURN n, $branchEntityTypes[1] AS entityType');
    expect(call?.cypher).not.toContain('gadget');
    expect(call?.parameters['branchEntityTypes']).toEqual(['widget', 'gadget ü']);
  });

  it('refuses a request that sets the branch entity types itself, before any read', async () => {
    const executor = new TestExecutor(withOnlineIndexes(twoTypes, searchModelOf([BOTH])));
    const parts = harness({ catalog: createTemplateCatalog({ templates: [searchExactTemplate, schemaIndexesTemplate] }), executor, modelFor: () => normalizeModelOf(twoTypes), allowlistFor: () => allowlistFromMapping(twoTypes) });
    await expect(parts.gate.run(gateRequest({ sourceId: twoTypes.id, templateId: SEARCH_EXACT_ID, params: { text: 'C-1', targets: [code('widget')], branchEntityTypes: ['twin'] }, limit: 25 }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(executor.calls.filter((entry) => entry.templateId === SEARCH_EXACT_ID)).toEqual([]);
  });
});
