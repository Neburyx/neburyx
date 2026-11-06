import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import type { AuditEvent } from '../seams/seams.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { gateRequest, harness, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { normalizedOf } from '../testing/search-fixtures.js';
import { allowlistFromMapping } from './allowlist.js';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import { normalizeModelOf } from './normalize/model.js';
import { renderTemplate } from './render.js';
import type { IndexEntry } from './templates/schema-indexes.js';
import { SEARCH_PREFIX_ID, searchPrefixTemplate } from './templates/search-prefix.js';
import type { IndexSnapshot } from './types.js';

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
const catalog = createTemplateCatalog({ templates: [searchPrefixTemplate] });
const template = catalog.find(SEARCH_PREFIX_ID);
if (template === undefined) throw new Error('the catalog has no prefix template');

const WIDGET_ID = { entityType: 'widget', property: 'widgetId', match: 'value' as const };
const WIDGET_OWNER = { entityType: 'widget', property: 'ownerName', match: 'value' as const };
const GADGET_ID = { entityType: 'gadget', property: 'gadgetId', match: 'value' as const };
const BRANCH = (label: string, property: string): string => `MATCH (n:\`${label}\`) WHERE n.\`${property}\` STARTS WITH $text AND n.\`${property}\` <> $text RETURN n LIMIT $limit + 1`;
const STATEMENT = `CALL { ${BRANCH('Widget', 'widgetId')} UNION ${BRANCH('Gadget', 'gadgetId')} } WITH n LIMIT $limit + 1 RETURN n`;

const entry = (type: IndexEntry['type'], name: string, property: string, constrained = false): IndexEntry => ({ type, entityType: 'NODE', name, property, single: true, state: 'ONLINE', constrained });
const snapshotOf = (...entries: IndexEntry[]): IndexSnapshot => ({ sourceId: source.id, entries });
const ONLINE = snapshotOf(entry('RANGE', 'Widget', 'widgetId', true), entry('RANGE', 'Widget', 'ownerName'), entry('RANGE', 'Gadget', 'gadgetId'));

function rig(overrides: Parameters<typeof harness>[0] = {}) {
  const audit: AuditEvent[] = [];
  const executor = new TestExecutor(() => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'AC-12' }, '4:s:1'), plainNode(['Gadget'], { gadgetId: 'CU-12' }, '4:s:2'))));
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

const prefix = (params: unknown, indexes: IndexSnapshot = ONLINE, limit = 25) => gateRequest({ sourceId: source.id, templateId: SEARCH_PREFIX_ID, params, limit, indexes });

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? `${error.code}${error.reason === undefined ? '' : `:${error.reason}`}` : 'not an AppError';
  }
}

describe('a prefix search the gate refuses before any read', () => {
  const REFUSED: readonly (readonly [string, unknown])[] = [
    ['an entity type the mapping does not name', { text: 'AC', targets: [{ entityType: 'nothing', property: 'widgetId', match: 'value' }] }],
    ['a property that is not a search property of its type', { text: 'AC', targets: [{ entityType: 'widget', property: 'status', match: 'value' }] }],
    ['a property name with a backtick', { text: 'AC', targets: [{ entityType: 'widget', property: 'widgetId` OR 1=1 //', match: 'value' }] }],
    ['the same target twice', { text: 'AC', targets: [WIDGET_ID, WIDGET_ID] }],
    ['a text of one character', { text: 'A', targets: [WIDGET_ID] }],
    ['an empty text', { text: '', targets: [WIDGET_ID] }],
    ['a text of 201 characters', { text: 'A'.repeat(201), targets: [WIDGET_ID] }],
    ['a field the template does not name', { text: 'AC', targets: [WIDGET_ID], property: 'widgetId' }],
    ['a target with a label of its own', { text: 'AC', targets: [{ ...WIDGET_ID, label: 'Widget' }] }],
    ['a target with an entity type from the request body', { text: 'AC', entityType: 'widget', targets: [WIDGET_ID] }],
    ['no list of targets', { text: 'AC' }],
  ];

  it.each(REFUSED)('refuses %s, reads nothing and records it as refused', async (_name, params) => {
    const { gate, executor, audit } = rig();
    expect(await failureOf(gate.run(prefix(params)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'entity.search', result: 'refused' });
  });

  it('counts the length of the text in characters, 2 to 200', async () => {
    const { gate } = rig();
    expect(await failureOf(gate.run(prefix({ text: '😀'.repeat(200), targets: [WIDGET_ID] })))).toBe('ok');
    expect(await failureOf(gate.run(prefix({ text: '😀'.repeat(201), targets: [WIDGET_ID] })))).toBe('INVALID_REQUEST');
    expect(await failureOf(gate.run(prefix({ text: '😀😀', targets: [WIDGET_ID] })))).toBe('ok');
    expect(await failureOf(gate.run(prefix({ text: '😀', targets: [WIDGET_ID] })))).toBe('INVALID_REQUEST');
  });
});

describe('a prefix search that asks for masking', () => {
  it('refuses a target that names a personal-data property, reads nothing and records it as refused', async () => {
    const { gate, executor, audit } = rig();
    expect(await failureOf(gate.run({ ...prefix({ text: 'Iv', targets: [WIDGET_ID, WIDGET_OWNER] }), mask: true }))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
    expect(audit[0]).toMatchObject({ result: 'refused' });
  });

  it('accepts the same target when the request does not ask for masking, and a masked request without it', async () => {
    const { gate } = rig();
    expect(await failureOf(gate.run(prefix({ text: 'Iv', targets: [WIDGET_ID, WIDGET_OWNER] })))).toBe('ok');
    expect(await failureOf(gate.run({ ...prefix({ text: 'Iv', targets: [WIDGET_ID] }), mask: true }))).toBe('ok');
  });

  it('masks the personal-data properties of the rows after the read', async () => {
    const parts = rig({ executor: new TestExecutor(() => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'AC-12', ownerName: 'Ivo Lowe' })))) });
    const page = await parts.gate.run({ ...prefix({ text: 'AC', targets: [WIDGET_ID] }), mask: true });
    expect(normalizedOf(page).nodes[0]?.properties.find((property) => property.key === 'ownerName')).toMatchObject({ masked: true, maskedBy: 'request' });
  });
});

describe('a prefix search whose index is not there', () => {
  const WITHOUT_WIDGET = snapshotOf(entry('RANGE', 'Gadget', 'gadgetId'));
  const BUILDING = snapshotOf(entry('RANGE', 'Widget', 'widgetId'), { ...entry('RANGE', 'Gadget', 'gadgetId'), state: 'POPULATING' });

  it.each([
    ['a type with no index', WITHOUT_WIDGET],
    ['an index that is being built', BUILDING],
  ])('is refused for %s as an index that is unavailable, before any data read, and recorded as refused', async (_name, indexes) => {
    const { gate, executor, audit } = rig();
    expect(await failureOf(gate.run(prefix({ text: 'AC', targets: [WIDGET_ID, GADGET_ID] }, indexes)))).toBe('SOURCE_UNAVAILABLE:index-unavailable');
    expect(executor.calls).toEqual([]);
    expect(audit[0]).toMatchObject({ action: 'entity.search', result: 'refused' });
  });

  it.each([
    ['a constraint', snapshotOf(entry('RANGE', 'Widget', 'widgetId', true), entry('RANGE', 'Gadget', 'gadgetId', true))],
    ['a RANGE index', snapshotOf(entry('RANGE', 'Widget', 'widgetId'), entry('RANGE', 'Gadget', 'gadgetId'))],
    ['a TEXT index', snapshotOf(entry('TEXT', 'Widget', 'widgetId'), entry('TEXT', 'Gadget', 'gadgetId'))],
  ])('is served by %s', async (_name, indexes) => {
    const { gate, executor } = rig();
    expect(await failureOf(gate.run(prefix({ text: 'AC', targets: [WIDGET_ID, GADGET_ID] }, indexes)))).toBe('ok');
    expect(executor.calls).toHaveLength(1);
  });
});

describe('the statement of a prefix search', () => {
  const render = (text: string, targets: readonly object[], limit = 25) => renderTemplate(template, template.paramsSchema.parse({ text, targets }), allowlist, limit);

  it('has one branch for each target, joined by UNION, cut by a limit in each branch and one over the combined result, with names from the mapping only, quoted', () => {
    const rendered = render('AC', [WIDGET_ID, GADGET_ID]);
    expect(rendered.cypher).toBe(STATEMENT);
    expect(rendered.parameters).toEqual({ text: 'AC', limit: 25 });
  });

  it('writes the same branch for the two match forms of a target', () => {
    expect(render('AC', [{ ...WIDGET_ID, match: 'text' }]).cypher).toBe(render('AC', [WIDGET_ID]).cypher);
  });

  it('leaves out a value equal to the text, as stored and with no function on the property', () => {
    const { cypher } = render('AC', [WIDGET_ID, GADGET_ID]);
    expect(cypher.match(/<> \$text/g)).toHaveLength(2);
    for (const word of ['toLower', 'toUpper', 'trim', 'ENDS WITH', 'CONTAINS', '=~', 'normalize']) expect(cypher).not.toContain(word);
  });

  it.each(['A%', 'A_', 'A\\', "O'", 'x` OR 1=1 // $z @searchBranches(targets)', '%%'])('keeps the typed text %s out of the statement, as a parameter only', (text) => {
    const rendered = render(text, [WIDGET_ID]);
    expect(rendered.cypher).toBe(render('AC', [WIDGET_ID]).cypher);
    expect(rendered.parameters['text']).toBe(text);
  });
});

describe('a prefix search through the real gate with a fake adapter', () => {
  it('runs the stages in order as one READ with one more row than the limit, audits it as entity.search, and returns the rows as normalized nodes', async () => {
    const { gate, executor, audit, observer } = rig();
    const page = await gate.run(prefix({ text: 'AC', targets: [WIDGET_ID, GADGET_ID] }));
    expect(observer.events.map((event) => event.stage)).toEqual(['resolve', 'validate', 'authorize', 'execute', 'normalize', 'redact', 'audit']);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ accessMode: 'READ', rowLimit: 26, cypher: STATEMENT, templateId: SEARCH_PREFIX_ID });
    expect(audit).toEqual([expect.objectContaining({ action: 'entity.search', result: 'success', sourceId: source.id })]);
    expect(normalizedOf(page).nodes.map((node) => node.ref.stableId)).toEqual(['AC-12', 'CU-12']);
  });

  it('runs every stage but the read when there is no target, and records one audit event', async () => {
    const { gate, executor, audit, observer } = rig();
    const page = await gate.run(prefix({ text: 'AC', targets: [] }));
    expect(executor.calls).toEqual([]);
    expect(page).toMatchObject({ hasMore: false });
    expect(normalizedOf(page).nodes).toEqual([]);
    expect(observer.events.map((event) => event.stage)).toEqual(['resolve', 'validate', 'authorize', 'execute', 'normalize', 'redact', 'audit']);
    expect(audit).toEqual([expect.objectContaining({ action: 'entity.search', result: 'success' })]);
  });
});

describe('the declaration of the prefix template', () => {
  const failure = (overrides: Partial<TemplateDefinition>): string => {
    try {
      createTemplateCatalog({ templates: [{ ...searchPrefixTemplate, ...overrides }] });
    } catch (error) {
      if (error instanceof CatalogError) return error.message;
      throw error;
    }
    return 'accepted';
  };

  it('is accepted as written', () => {
    expect(failure({})).toBe('accepted');
  });

  it('is refused when a branch has no limit of its own, and without the enclosing limit or the properties it uses', () => {
    const declared = searchPrefixTemplate.searchBranches;
    if (declared === undefined) throw new Error('the prefix template declares no branches');
    expect(failure({ searchBranches: { ...declared, value: 'MATCH (n:@label) WHERE n.@property STARTS WITH $text RETURN n' } })).toBe('the template entity-search-prefix has a branch text with no LIMIT $limit + 1 of its own');
    expect(failure({ cypher: 'CALL { @searchBranches(targets) } RETURN n' })).toBe('the template entity-search-prefix has search branches and its Cypher has no enclosing LIMIT $limit + 1');
    expect(failure({ usedProperties: undefined })).toBe('the template entity-search-prefix has search branches and does not name the properties it uses');
  });

  it('names every target in the properties it uses and in the indexes it needs, any kind of index meeting the need', () => {
    const params = { text: 'AC', targets: [WIDGET_ID, GADGET_ID] };
    expect(searchPrefixTemplate.usedProperties?.(params)).toEqual([WIDGET_ID, GADGET_ID]);
    expect(searchPrefixTemplate.indexNeeds?.(params, allowlist)).toEqual([
      { entityType: 'widget', property: 'widgetId', accepts: 'any' },
      { entityType: 'gadget', property: 'gadgetId', accepts: 'any' },
    ]);
  });
});
