import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { AuditEvent } from '../seams/seams.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { gateRequest, harness, TestExecutor } from '../testing/gate.js';
import { parseMapping } from '../mapping/load.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { normalizedOf } from '../testing/search-fixtures.js';
import { SourceGateError, allowlistFromMapping } from './allowlist.js';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import { normalizeModelOf } from './normalize/model.js';
import { renderTemplate } from './render.js';
import { SEARCH_EXACT_ID, searchExactTemplate } from './templates/search-exact.js';

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId', 'ownerName'], pii: [{ property: 'ownerName', class: 'name' }] },
        { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId'] },
      ],
      relationships: [],
    }),
  ),
  'neburyx.yaml',
);
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const model = normalizeModelOf(source);
const allowlist = allowlistFromMapping(source);
const catalog = createTemplateCatalog({ templates: [searchExactTemplate] });
const template = catalog.find(SEARCH_EXACT_ID);
if (template === undefined) throw new Error('the catalog has no search template');

const WIDGET_ID = { entityType: 'widget', property: 'widgetId', match: 'value' as const };
const GADGET_ID = { entityType: 'gadget', property: 'gadgetId', match: 'value' as const };
const STATEMENT =
  'CALL { MATCH (n:`Widget`) WHERE n.`widgetId` IN [$text, $textInteger] RETURN n LIMIT $limit + 1 UNION ' +
  'MATCH (n:`Gadget`) WHERE n.`gadgetId` IN [$text, $textInteger] RETURN n LIMIT $limit + 1 } WITH n LIMIT $limit + 1 RETURN n';

const ONLINE = {
  sourceId: source.id,
  entries: [
    { type: 'RANGE' as const, entityType: 'NODE' as const, name: 'Widget', property: 'widgetId', single: true, state: 'ONLINE', constrained: true },
    { type: 'RANGE' as const, entityType: 'NODE' as const, name: 'Widget', property: 'ownerName', single: true, state: 'ONLINE', constrained: false },
    { type: 'RANGE' as const, entityType: 'NODE' as const, name: 'Gadget', property: 'gadgetId', single: true, state: 'ONLINE', constrained: false },
  ],
};

function rig(overrides: Parameters<typeof harness>[0] = {}) {
  const audit: AuditEvent[] = [];
  const executor = new TestExecutor(() => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'AC-1' }, '4:s:1'), plainNode(['Gadget'], { gadgetId: 'CU-1' }, '4:s:2'))));
  const parts = harness({
    catalog,
    executor,
    modelFor: () => model,
    allowlistFor: () => allowlist,
    seams: { audit: { record: (event) => Promise.resolve(void audit.push(event)) } },
    ...overrides,
  });
  return { ...parts, audit };
}

const search = (params: unknown, limit = 25) => gateRequest({ sourceId: source.id, templateId: SEARCH_EXACT_ID, params, limit, indexes: ONLINE });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('a search the gate refuses before any read', () => {
  const REFUSED: readonly (readonly [string, unknown])[] = [
    ['an entity type the mapping does not name', { text: 'AC-1', targets: [{ entityType: 'nothing', property: 'widgetId', match: 'value' }] }],
    ['a property that is not a search property of its type', { text: 'AC-1', targets: [{ entityType: 'widget', property: 'status', match: 'value' }] }],
    ['a property name with a backtick', { text: 'AC-1', targets: [{ entityType: 'widget', property: 'widgetId` OR 1=1 //', match: 'value' }] }],
    ['an entity type name with a backtick', { text: 'AC-1', targets: [{ entityType: 'wid`get', property: 'widgetId', match: 'value' }] }],
    ['the same target twice', { text: 'AC-1', targets: [WIDGET_ID, WIDGET_ID] }],
    ['an empty text', { text: '', targets: [WIDGET_ID] }],
    ['a match form the template does not know', { text: 'AC-1', targets: [{ ...WIDGET_ID, match: 'prefix' }] }],
    ['a target with no match form', { text: 'AC-1', targets: [{ entityType: 'widget', property: 'widgetId' }] }],
    ['a text of 201 characters', { text: 'A'.repeat(201), targets: [WIDGET_ID] }],
    ['a field the template does not name', { text: 'AC-1', targets: [WIDGET_ID], limit: 1 }],
    ['a target with a field the template does not name', { text: 'AC-1', targets: [{ ...WIDGET_ID, label: 'Widget' }] }],
    ['no list of targets', { text: 'AC-1' }],
  ];

  it.each(REFUSED)('refuses %s, reads nothing and records it as refused', async (_name, params) => {
    const { gate, executor, audit } = rig();
    expect(await codeOf(gate.run(search(params)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'entity.search', result: 'refused' });
  });

  it('counts the length of the text in characters', async () => {
    const { gate } = rig();
    expect(await codeOf(gate.run(search({ text: '😀'.repeat(200), targets: [WIDGET_ID] })))).toBe('ok');
    expect(await codeOf(gate.run(search({ text: '😀'.repeat(201), targets: [WIDGET_ID] })))).toBe('INVALID_REQUEST');
    expect(await codeOf(gate.run(search({ text: '😀', targets: [WIDGET_ID] })))).toBe('ok');
    expect(await codeOf(gate.run(search({ text: 'A', targets: [WIDGET_ID] })))).toBe('ok');
  });

  it('refuses a mapping whose search property cannot be quoted, when the allowlist is built', () => {
    const [account] = source.entities;
    if (account === undefined) throw new Error('the pack has no entity type');
    const hostile = { ...source, entities: [{ ...account, search: ['widgetId', 'owner`Name'] }, ...source.entities.slice(1)] };
    expect(() => allowlistFromMapping(hostile)).toThrow(SourceGateError);
  });
});

describe('the statement of a search', () => {
  const render = (text: string, targets: readonly object[], limit = 25) => renderTemplate(template, template.paramsSchema.parse({ text, targets }), allowlist, limit);

  it('has one branch for each target, joined by UNION and cut by one limit over the combined result, with names from the mapping only, quoted', () => {
    const rendered = render('AC-1', [WIDGET_ID, GADGET_ID]);
    expect(rendered.cypher).toBe(STATEMENT);
    expect(rendered.parameters).toEqual({ text: 'AC-1', textInteger: null, limit: 25 });
  });

  it('writes a single branch for a single target and a branch for every property of a type that has two', () => {
    expect(render('AC-1', [WIDGET_ID]).cypher.match(/UNION/g)).toBeNull();
    const both = render('AC-1', [WIDGET_ID, { entityType: 'widget', property: 'ownerName', match: 'value' }]).cypher;
    expect(both.match(/MATCH/g)).toHaveLength(2);
    expect(both).toContain('n.`ownerName` IN [$text, $textInteger]');
  });

  it('writes a text branch for a property that has a TEXT index only, matching the text and not the integer it can be', () => {
    const rendered = render('123', [{ ...WIDGET_ID, match: 'text' }, GADGET_ID]);
    expect(rendered.cypher).toContain('MATCH (n:`Widget`) WHERE n.`widgetId` = $text RETURN n LIMIT $limit + 1');
    expect(rendered.cypher).toContain('MATCH (n:`Gadget`) WHERE n.`gadgetId` IN [$text, $textInteger] RETURN n LIMIT $limit + 1');
  });

  it('cuts every branch at the limit plus one, so a value that many entities carry cannot make the union read them all', () => {
    for (const targets of [[WIDGET_ID], [WIDGET_ID, GADGET_ID], [{ ...WIDGET_ID, match: 'text' as const }, GADGET_ID]]) {
      const { cypher } = render('AC-1', targets);
      expect(cypher.match(/RETURN n LIMIT \$limit \+ 1/g)).toHaveLength(targets.length);
      expect(cypher).toMatch(/\} WITH n LIMIT \$limit \+ 1 RETURN n$/);
    }
  });

  it.each(['toLower', 'toUpper', 'trim', 'STARTS WITH', 'ENDS WITH', 'CONTAINS', '=~', 'normalize'])('holds no %s on the property or the parameter, so an index serves it', (word) => {
    expect(render('AC-1', [WIDGET_ID, GADGET_ID]).cypher).not.toContain(word);
  });

  it('keeps the typed text out of the statement, whatever it holds', () => {
    const text = "x' OR 1=1 // `y` $z @searchBranches(targets)";
    const rendered = render(text, [WIDGET_ID]);
    expect(rendered.cypher).toBe(render('AC-1', [WIDGET_ID]).cypher);
    expect(rendered.parameters['text']).toBe(text);
  });
});

describe('the integer a text can also be', () => {
  const integerOf = (text: string): unknown => template.paramsSchema.parse({ text, targets: [] });

  it.each(['12', '123', '-42', '9007199254740993', '9223372036854775807', '-9223372036854775808'])('reads %s as the text and as a tagged 64-bit integer', (text) => {
    expect(integerOf(text)).toMatchObject({ text, textInteger: { $type: 'integer', value: text } });
  });

  it.each(['007', '+5', '-0', '1e3', '1.0', ' 12', '12 ', '9223372036854775808', '-9223372036854775809', 'AC-1', '１２'])('reads %s as text only', (text) => {
    expect(integerOf(text)).toMatchObject({ text, textInteger: null });
  });
});

describe('a search through the real gate with a fake adapter', () => {
  it('runs the stages in order as one READ with one more row than the limit, audits it as entity.search, and returns the rows as normalized nodes', async () => {
    const { gate, executor, audit, observer } = rig();
    const page = await gate.run(search({ text: 'AC-1', targets: [WIDGET_ID, GADGET_ID] }));
    expect(observer.events.map((event) => event.stage)).toEqual(['resolve', 'validate', 'authorize', 'execute', 'normalize', 'redact', 'audit']);
    expect(observer.events.every((event) => event.outcome === 'ok')).toBe(true);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ accessMode: 'READ', rowLimit: 26, cypher: STATEMENT, templateId: SEARCH_EXACT_ID });
    expect(audit).toEqual([expect.objectContaining({ action: 'entity.search', result: 'success', sourceId: source.id })]);
    const { nodes } = normalizedOf(page);
    expect(nodes.map((node) => node.ref.stableId)).toEqual(['AC-1', 'CU-1']);
    expect(nodes.map((node) => node.ref.entityType)).toEqual(['widget', 'gadget']);
  });

  it('masks the personal-data properties of the rows when the request asks, after the read', async () => {
    const parts = rig({ executor: new TestExecutor(() => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'AC-1', ownerName: 'Ivo Lowe' })))) });
    const page = await parts.gate.run({ ...search({ text: 'AC-1', targets: [WIDGET_ID] }), mask: true });
    expect(normalizedOf(page).nodes[0]?.properties.find((property) => property.key === 'ownerName')).toMatchObject({ masked: true, maskedBy: 'request' });
  });
});

describe('a search with nothing to read', () => {
  it('runs every stage but the read, records one audit event, and answers with no row', async () => {
    const { gate, executor, audit, observer } = rig();
    const page = await gate.run(search({ text: 'AC-1', targets: [] }));
    expect(executor.calls).toEqual([]);
    expect(page).toMatchObject({ hasMore: false });
    expect(normalizedOf(page).nodes).toEqual([]);
    expect(observer.events.map((event) => event.stage)).toEqual(['resolve', 'validate', 'authorize', 'execute', 'normalize', 'redact', 'audit']);
    expect(audit).toEqual([expect.objectContaining({ action: 'entity.search', result: 'success' })]);
  });

  it('still refuses a principal the policy refuses, and a source that is not usable, without calling the executor', async () => {
    const denied = rig({ seams: { policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'denied' }) } } });
    expect(await codeOf(denied.gate.run(search({ text: 'AC-1', targets: [] })))).toBe('ACCESS_DENIED');
    expect(denied.executor.calls).toEqual([]);
    const unusable = rig({ usability: { isUsable: () => false } });
    expect(await codeOf(unusable.gate.run(search({ text: 'AC-1', targets: [] })))).toBe('SOURCE_UNAVAILABLE');
    expect(unusable.executor.calls).toEqual([]);
  });
});

describe('the declaration of the search branches', () => {
  const declared = searchExactTemplate.searchBranches;
  if (declared === undefined) throw new Error('the search template declares no search branches');
  const failure = (overrides: Partial<TemplateDefinition>): string => {
    try {
      createTemplateCatalog({ templates: [{ ...searchExactTemplate, ...overrides }] });
    } catch (error) {
      if (error instanceof CatalogError) return error.message;
      throw error;
    }
    return 'accepted';
  };
  const NOT_PLACEHOLDERS = 'the template entity-search has a branch text that does not hold exactly the placeholders of its targets (@label, @property)';

  it('is accepted as written', () => {
    expect(failure({})).toBe('accepted');
  });

  it('is refused when the statement uses the marker and the template declares no search branches', () => {
    expect(failure({ searchBranches: undefined })).toBe('the template entity-search uses the search branch marker without declaring search branches');
  });

  it('is refused when the declared branches are not used exactly once for that parameter', () => {
    expect(failure({ cypher: 'CALL { MATCH (n) RETURN n } WITH n LIMIT $limit + 1 RETURN n' })).toBe('the template entity-search declares search branches and does not use its branch marker exactly once');
    expect(failure({ cypher: 'CALL { @searchBranches(targets) UNION @searchBranches(targets) } WITH n LIMIT $limit + 1 RETURN n' })).toBe('the template entity-search declares search branches and does not use its branch marker exactly once');
  });

  it('is refused when a branch text holds anything but the two placeholders', () => {
    expect(failure({ searchBranches: { ...declared, value: 'MATCH (n:@label) WHERE n.id = @other RETURN n LIMIT $limit + 1' } })).toBe(NOT_PLACEHOLDERS);
    expect(failure({ searchBranches: { ...declared, text: 'MATCH (n:@label) RETURN n LIMIT $limit + 1' } })).toBe(NOT_PLACEHOLDERS);
  });

  it('is refused when a branch text has no limit of its own', () => {
    expect(failure({ searchBranches: { ...declared, value: 'MATCH (n:@label) WHERE n.@property IN [$text, $textInteger] RETURN n' } })).toBe('the template entity-search has a branch text with no LIMIT $limit + 1 of its own');
    expect(failure({ searchBranches: { ...declared, text: 'MATCH (n:@label) WHERE n.@property = $text RETURN n' } })).toBe('the template entity-search has a branch text with no LIMIT $limit + 1 of its own');
  });

  it('is refused without the enclosing limit, and without the properties it uses', () => {
    expect(failure({ cypher: 'CALL { @searchBranches(targets) } RETURN n' })).toBe('the template entity-search has search branches and its Cypher has no enclosing LIMIT $limit + 1');
    expect(failure({ usedProperties: undefined })).toBe('the template entity-search has search branches and does not name the properties it uses');
  });

  it('names every target in the properties it uses, so a masked request is checked', () => {
    expect(searchExactTemplate.usedProperties?.({ text: 'AC-1', targets: [WIDGET_ID, GADGET_ID] })).toEqual([WIDGET_ID, GADGET_ID]);
  });
});
