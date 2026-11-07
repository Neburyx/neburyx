import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { MAX_FACET_PROBES } from '../mapping/model.js';
import { parseMapping } from '../mapping/load.js';
import type { AuditEvent } from '../seams/seams.js';
import { gateRequest, harness, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { RELATED_ENTITIES } from '../testing/search-app.js';
import { facetRowOf, onlineIndexesOf, textIndex } from '../testing/search-fixtures.js';
import { allowlistFromMapping } from './allowlist.js';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import { normalizeModelOf } from './normalize/model.js';
import { renderTemplate } from './render.js';
import { SEARCH_FACETS_ID, searchFacetsTemplate, normalizeFacetCounts, type FacetProbe } from './templates/search-facets.js';
import { searchEvidenceTemplate } from './templates/search-evidence.js';

const RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId', 'docId'] },
  { type: 'NO_ID', from: 'widget', to: 'gadget', evidence: ['recordId'] },
];
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: RELATED_ENTITIES, relationships: RELATIONSHIPS })), 'neburyx.yaml');
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const model = normalizeModelOf(source);
const allowlist = allowlistFromMapping(source);
const catalog = createTemplateCatalog({ templates: [searchFacetsTemplate] });
const ONLINE = { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) };

const WIDGET_ID = { kind: 'search' as const, entityType: 'widget', property: 'widgetId', match: 'value' as const };
const WIDGET_OWNER = { kind: 'search' as const, entityType: 'widget', property: 'ownerName', match: 'value' as const };
const WIDGET_BATCH = { kind: 'reference' as const, entityType: 'widget', property: 'batchRef', match: 'value' as const };
const GADGET_ID = { kind: 'search' as const, entityType: 'gadget', property: 'gadgetId', match: 'text' as const };
const RECORD = { kind: 'evidence' as const, relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'recordId', match: 'value' as const };
const DOC = { kind: 'evidence' as const, relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'docId', match: 'text' as const };

function rig(count = 3) {
  const audit: AuditEvent[] = [];
  const executor = new TestExecutor((call) => Promise.resolve(facetRowOf(call, count)));
  const parts = harness({ catalog, executor, modelFor: () => model, allowlistFor: () => allowlist, seams: { audit: { record: (event) => Promise.resolve(void audit.push(event)) } } });
  return { ...parts, audit, executor };
}

const facets = (probes: readonly FacetProbe[] | unknown, overrides: { readonly mask?: boolean; readonly indexes?: typeof ONLINE; readonly limit?: number } = {}) =>
  gateRequest({ sourceId: source.id, templateId: SEARCH_FACETS_ID, params: { text: 'T-1', probes }, limit: overrides.limit ?? 25, indexes: overrides.indexes ?? ONLINE, ...(overrides.mask === undefined ? {} : { mask: overrides.mask }) });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('a facet read the gate refuses before any read', () => {
  const REFUSED: readonly (readonly [string, unknown])[] = [
    ['an entity type the mapping does not name', [{ targets: [{ ...WIDGET_ID, entityType: 'nothing' }] }]],
    ['a property that is not in the list its kind names', [{ targets: [{ ...WIDGET_ID, property: 'batchRef' }] }]],
    ['a reference target that names a search property', [{ targets: [{ ...WIDGET_BATCH, property: 'widgetId' }] }]],
    ['a relationship type the mapping does not name', [{ targets: [{ ...RECORD, relationshipType: 'NOTHING' }] }]],
    ['an entity type used as a relationship type', [{ targets: [{ ...RECORD, relationshipType: 'widget' }] }]],
    ['a relationship row that has no stable ID, with a property it has no evidence for', [{ targets: [{ ...RECORD, relationshipType: 'NO_ID', property: 'docId' }] }]],
    ['ends the row does not map', [{ targets: [{ ...RECORD, from: 'gadget', to: 'widget' }] }]],
    ['a property name with a backtick', [{ targets: [{ ...WIDGET_ID, property: 'widgetId` OR 1=1 //' }] }]],
    ['one probe of both kinds', [{ targets: [WIDGET_ID, RECORD] }]],
    ['the same target twice in a probe', [{ targets: [WIDGET_ID, WIDGET_ID] }]],
    ['a probe with no target', [{ targets: [] }]],
    ['a field a probe does not name', [{ targets: [WIDGET_ID], label: 'x' }]],
    ['a target of an unknown kind', [{ targets: [{ ...WIDGET_ID, kind: 'startsWith' }] }]],
    ['more probes than the limit', Array.from({ length: MAX_FACET_PROBES + 1 }, () => ({ targets: [WIDGET_ID] }))],
    ['a probe number in a probe', [{ index: 7, targets: [WIDGET_ID] }]],
    ['no list of probes', undefined],
  ];

  it.each(REFUSED)('refuses %s with INVALID_REQUEST and runs no statement', async (_name, probes) => {
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(facets(probes)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });

  it('refuses a field the template does not name, and a text of 201 characters', async () => {
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(gateRequest({ sourceId: source.id, templateId: SEARCH_FACETS_ID, params: { text: 'T-1', probes: [{ targets: [WIDGET_ID] }], group: 'facets' }, limit: 25, indexes: ONLINE })))).toBe('INVALID_REQUEST');
    expect(await codeOf(gate.run(gateRequest({ sourceId: source.id, templateId: SEARCH_FACETS_ID, params: { text: 'a'.repeat(201), probes: [{ targets: [WIDGET_ID] }] }, limit: 25, indexes: ONLINE })))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });
});

describe('a facet read the gate runs', () => {
  it('writes one probe for each list of targets, with the quoted names, the numbers the code writes and no value, in one read', async () => {
    const { gate, executor, audit } = rig();
    await gate.run(facets([{ targets: [WIDGET_ID, WIDGET_OWNER, WIDGET_BATCH] }, { targets: [GADGET_ID] }, { targets: [RECORD, DOC] }]));
    expect(executor.calls).toHaveLength(1);
    const [call] = executor.calls;
    expect(call?.cypher).toBe(
      [
        'CALL { CALL { MATCH (n:`Widget`) WHERE n.`widgetId` IN [$text, $textInteger] RETURN n LIMIT $countCap + 1 UNION MATCH (n:`Widget`) WHERE n.`ownerName` IN [$text, $textInteger] RETURN n LIMIT $countCap + 1 UNION MATCH (n:`Widget`) WHERE n.`batchRef` IN [$text, $textInteger] RETURN n LIMIT $countCap + 1 } WITH n LIMIT $countCap + 1 RETURN count(*) AS c0 }',
        'CALL { CALL { MATCH (n:`Gadget`) WHERE n.`gadgetId` = $text RETURN n LIMIT $countCap + 1 } WITH n LIMIT $countCap + 1 RETURN count(*) AS c1 }',
        'CALL { CALL { MATCH (a:`Widget`)-[r:`MADE_FROM`]->(b:`Gadget`) USING RANGE INDEX SEEK r:`MADE_FROM`(`recordId`) WHERE r.`recordId` IN [$text, $textInteger] RETURN r LIMIT $countCap + 1 UNION MATCH (a:`Widget`)-[r:`MADE_FROM`]->(b:`Gadget`) USING TEXT INDEX r:`MADE_FROM`(`docId`) WHERE r.`docId` = $text RETURN r LIMIT $countCap + 1 } WITH r LIMIT $countCap + 1 RETURN count(*) AS c2 }',
        'RETURN c0, c1, c2',
      ].join('\n'),
    );
    expect(call?.cypher).not.toContain('T-1');
    // the probes are cut at the source's count cap, filled in by the gate, and never at the page limit
    expect(call?.parameters).toMatchObject({ text: 'T-1', limit: 25, countCap: DEFAULT_BUDGETS.countCap });
    expect(call?.rowLimit).toBe(26);
    expect(audit.map((event) => `${event.action} ${event.result}`)).toEqual(['entity.search_facets success']);
  });

  it('answers one item with the counts in the order of the probes', async () => {
    const { gate } = rig(7);
    const page = await gate.run(facets([{ targets: [WIDGET_ID] }, { targets: [GADGET_ID] }]));
    expect(page.items).toEqual([{ counts: [7, 7], cap: DEFAULT_BUDGETS.countCap }]);
    expect(page.hasMore).toBe(false);
  });

  it('keeps the mask from reaching an entity target of a personal-data property, and leaves an evidence target alone', async () => {
    const withMask = rig();
    expect(await codeOf(withMask.gate.run(facets([{ targets: [WIDGET_OWNER] }], { mask: true })))).toBe('INVALID_REQUEST');
    expect(withMask.executor.calls).toEqual([]);
    const without = rig();
    expect(await codeOf(without.gate.run(facets([{ targets: [WIDGET_OWNER] }], { mask: false })))).toBe('ok');
    const evidence = rig();
    expect(await codeOf(evidence.gate.run(facets([{ targets: [RECORD] }], { mask: true })))).toBe('ok');
  });

  it('names every target in `usedProperties`, by entity type or by relationship row', () => {
    expect(searchFacetsTemplate.usedProperties?.({ text: 'T-1', probes: [{ targets: [WIDGET_ID, WIDGET_BATCH] }, { targets: [RECORD] }] })).toEqual([
      { entityType: 'widget', property: 'widgetId' },
      { entityType: 'widget', property: 'batchRef' },
      { relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'recordId' },
    ]);
  });

  it('needs the index of the kind each target reads and refuses before the read when one is not online', async () => {
    const needs = searchFacetsTemplate.indexNeeds?.({ text: 'T-1', probes: [{ targets: [WIDGET_ID, GADGET_ID] }, { targets: [DOC] }] }, allowlist);
    expect(needs).toEqual([
      { entityType: 'widget', property: 'widgetId', accepts: 'value' },
      { entityType: 'gadget', property: 'gadgetId', accepts: 'any' },
      { relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'docId', accepts: 'any' },
    ]);
    const missing = { sourceId: source.id, entries: [...ONLINE.entries.filter((entry) => !(entry.entityType === 'NODE' && entry.property === 'gadgetId')), textIndex('Gadget', 'gadgetId', 'POPULATING')] };
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(facets([{ targets: [GADGET_ID] }], { indexes: missing })))).toBe('SOURCE_UNAVAILABLE');
    expect(executor.calls).toEqual([]);
  });

  it('reads nothing for an empty list of probes: no statement and no read, with the event kept', async () => {
    expect(searchFacetsTemplate.readsNothing?.({ text: 'T-1', probes: [] }, allowlist)).toBe(true);
    const rendered = renderTemplate(catalog.find(SEARCH_FACETS_ID) ?? failNoTemplate(), { text: 'T-1', probes: [] }, allowlist, 25);
    expect(rendered.cypher).toBe('');
    const { gate, executor, audit } = rig();
    const page = await gate.run(facets([]));
    expect(page.items).toEqual([]);
    expect(executor.calls).toEqual([]);
    expect(audit.map((event) => event.action)).toEqual(['entity.search_facets']);
  });
});

describe('the counts of a facet read the gate cannot trust', () => {
  const run = (rows: readonly Record<string, unknown>[], countCap = DEFAULT_BUDGETS.countCap) => {
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows' as const, rows }));
    const parts = harness({ catalog, executor, modelFor: () => model, allowlistFor: () => allowlist, budgetsFor: () => ({ ...DEFAULT_BUDGETS, countCap }) });
    return codeOf(parts.gate.run(facets([{ targets: [WIDGET_ID] }, { targets: [GADGET_ID] }])));
  };

  it.each([
    ['a negative count', [{ c0: -1, c1: 0 }]],
    ['a count that is not a whole number', [{ c0: 1.5, c1: 0 }]],
    ['a count above the count cap plus one', [{ c0: DEFAULT_BUDGETS.countCap + 2, c1: 0 }]],
    ['a count that is not a number', [{ c0: '3', c1: 0 }]],
    ['a missing count', [{ c0: 3 }, { c0: 3, c1: 3 }]],
    ['a column with another name', [{ c0: 3, total: 3 }]],
    ['an extra row', [{ c0: 1, c1: 1 }, { c0: 1, c1: 1 }]],
  ])('fails with INTERNAL_ERROR for %s, with no value in the failure', async (_name, rows) => {
    expect(await run(rows)).toBe('INTERNAL_ERROR');
  });

  it('accepts the count cap plus one and zero, and takes the cap of the source and not the page limit', async () => {
    expect(await run([{ c0: DEFAULT_BUDGETS.countCap + 1, c1: 0 }])).toBe('ok');
    expect(await run([{ c0: 11, c1: 0 }], 10)).toBe('ok');
    expect(await run([{ c0: 12, c1: 0 }], 10)).toBe('INTERNAL_ERROR');
    expect(await run([{ c0: 26, c1: 0 }], 100)).toBe('ok');
  });

  it('answers no item for no row, which the service refuses as it refuses a count it cannot read', () => {
    expect(normalizeFacetCounts([], undefined, { sourceId: 'demo', hasMore: false, model: normalizeModelOf(source), limit: 25, countCap: 500 })).toEqual([]);
  });

  it('holds no value of the row in the failure it raises', () => {
    try {
      normalizeFacetCounts([{ c0: 999, c1: 0 }], undefined, { sourceId: 'demo', hasMore: false, model: normalizeModelOf(source), limit: 25, countCap: 500 });
      throw new Error('expected a failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(JSON.stringify([(error as AppError).code, (error as AppError).message])).not.toContain('999');
    }
  });
});

describe('the catalog refuses a facet template that breaks the structure', () => {
  const failure = (overrides: Partial<TemplateDefinition>): string => {
    try {
      createTemplateCatalog({ templates: [{ ...searchFacetsTemplate, ...overrides }] });
    } catch (error) {
      if (error instanceof CatalogError) return error.message;
      throw error;
    }
    throw new Error('expected the catalog to be refused');
  };
  const spec = searchFacetsTemplate.facetProbes;
  if (spec === undefined) throw new Error('the facet template has no probes');

  it('has Cypher that is more than its one marker', () => {
    expect(failure({ cypher: '@facetProbes(probes) RETURN 1' })).toContain('not exactly its one facet probe marker');
    expect(failure({ cypher: 'MATCH (n) RETURN n' })).toContain('not exactly its one facet probe marker');
  });

  it('uses the marker without declaring probes, and declares probes with search branches too', () => {
    const { facetProbes: _removed, ...rest } = searchFacetsTemplate;
    expect(() => createTemplateCatalog({ templates: [rest] })).toThrow('uses the facet probe marker without declaring facet probes');
    expect(failure({ searchBranches: searchEvidenceTemplate.searchBranches })).toContain('declares search branches');
  });

  it('declares a parameter its schema does not have as a list', () => {
    expect(failure({ facetProbes: { ...spec, param: 'text' }, cypher: '@facetProbes(text)' })).toContain('does not have as a list');
  });

  it.each([
    ['a node branch with no limit of its own', { node: { ...spec.node, value: 'MATCH (n:@label) WHERE n.@property IN [$text, $textInteger] RETURN n' } }, 'no LIMIT $countCap + 1 of its own'],
    ['a node branch cut at the page limit and not the count cap', { node: { ...spec.node, value: 'MATCH (n:@label) WHERE n.@property IN [$text, $textInteger] RETURN n LIMIT $limit + 1' } }, 'no LIMIT $countCap + 1 of its own'],
    ['a node branch that returns another variable', { node: { ...spec.node, text: 'MATCH (m:@label) WHERE m.@property = $text RETURN m LIMIT $countCap + 1' } }, 'does not return the one variable'],
    ['a node branch with an evidence placeholder', { node: { ...spec.node, value: 'MATCH (n:@label) WHERE n.@property IN [$text, $textInteger] AND n.@type = 1 RETURN n LIMIT $limit + 1' } }, 'placeholders of its targets'],
    ['an evidence branch with a missing placeholder', { evidence: { ...spec.evidence, text: 'MATCH (a)-[r:@type]->(b) USING TEXT INDEX r:@type(@property) WHERE r.@property = $text RETURN r LIMIT $limit + 1' } }, 'placeholders of its targets'],
    ['an evidence branch that returns the ends too', { evidence: { ...spec.evidence, value: spec.evidence.value.replace('RETURN r LIMIT', 'RETURN r, a, b LIMIT') } }, 'does not return the one variable'],
  ])('has %s', (_name, change, message) => {
    expect(failure({ facetProbes: { ...spec, ...change } })).toContain(message);
  });

  it('has a count cap of its own in its parameter schema, which only the gate fills', () => {
    expect(failure({ paramsSchema: z.strictObject({ text: z.string(), probes: z.array(z.unknown()), countCap: z.number().int() }) })).toContain('has the gate-filled parameter countCap in its parameter schema');
  });

  it('does not name the properties it uses or the indexes it needs', () => {
    expect(failure({ usedProperties: undefined })).toContain('does not name the properties it uses');
    expect(failure({ indexNeeds: undefined })).toContain('does not name the indexes it needs');
  });
});

function failNoTemplate(): never {
  throw new Error('the catalog has no facet template');
}
