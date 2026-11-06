import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import type { AuditEvent } from '../seams/seams.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { gateRequest, harness, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { RELATED_ENTITIES } from '../testing/search-app.js';
import { onlineIndexesOf } from '../testing/search-fixtures.js';
import { allowlistFromMapping } from './allowlist.js';
import { createTemplateCatalog } from './catalog.js';
import { normalizeModelOf } from './normalize/model.js';
import { renderTemplate } from './render.js';
import { SEARCH_EXACT_ID, searchExactTemplate } from './templates/search-exact.js';
import { SEARCH_RELATED_ID, searchRelatedTemplate } from './templates/search-related.js';

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: RELATED_ENTITIES, relationships: [] })), 'neburyx.yaml');
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const model = normalizeModelOf(source);
const allowlist = allowlistFromMapping(source);
const catalog = createTemplateCatalog({ templates: [searchExactTemplate, searchRelatedTemplate] });
const template = catalog.find(SEARCH_RELATED_ID);
if (template === undefined) throw new Error('the catalog has no related template');

const BATCH = { entityType: 'widget', property: 'batchRef', match: 'value' as const };
const WIDGET_REF = { entityType: 'gadget', property: 'widgetRef', match: 'value' as const };
const OWNER_REF = { entityType: 'widget', property: 'ownerRef', match: 'value' as const };
const ONLINE = { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) };

function rig() {
  const audit: AuditEvent[] = [];
  const executor = new TestExecutor(() => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'W-1', batchRef: 'BT-1' }, '4:s:1'))));
  const parts = harness({ catalog, executor, modelFor: () => model, allowlistFor: () => allowlist, seams: { audit: { record: (event) => Promise.resolve(void audit.push(event)) } } });
  return { ...parts, audit };
}

const related = (params: unknown, overrides: { readonly mask?: boolean; readonly templateId?: string } = {}) =>
  gateRequest({ sourceId: source.id, templateId: overrides.templateId ?? SEARCH_RELATED_ID, params, limit: 25, indexes: ONLINE, ...(overrides.mask === undefined ? {} : { mask: overrides.mask }) });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('a related lookup the gate refuses before any read', () => {
  const REFUSED: readonly (readonly [string, unknown])[] = [
    ['a property that is only a search property', { text: 'BT-1', targets: [{ entityType: 'widget', property: 'widgetId', match: 'value' }] }],
    ['an entity type the mapping does not name', { text: 'BT-1', targets: [{ entityType: 'nothing', property: 'batchRef', match: 'value' }] }],
    ['a property the type does not have', { text: 'BT-1', targets: [{ entityType: 'widget', property: 'widgetRef', match: 'value' }] }],
    ['a type that has no reference property', { text: 'BT-1', targets: [{ entityType: 'part', property: 'partId', match: 'value' }] }],
    ['a property name with a backtick', { text: 'BT-1', targets: [{ entityType: 'widget', property: 'batchRef` OR 1=1 //', match: 'value' }] }],
    ['the same target twice', { text: 'BT-1', targets: [BATCH, BATCH] }],
    ['a field the template does not name', { text: 'BT-1', targets: [BATCH], group: 'related' }],
    ['no list of targets', { text: 'BT-1' }],
  ];

  it.each(REFUSED)('refuses %s, reads nothing and records it as refused', async (_name, params) => {
    const { gate, executor, audit } = rig();
    expect(await codeOf(gate.run(related(params)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
    expect(audit).toEqual([expect.objectContaining({ action: 'entity.search_related', result: 'refused' })]);
  });

  it('refuses a search property as a related target and a reference property as an exact target', async () => {
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(related({ text: 'BT-1', targets: [BATCH] }, { templateId: SEARCH_EXACT_ID })))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });

  it('refuses a personal-data target while the request asks for masking, and renders the same target unmasked', async () => {
    const masked = rig();
    expect(await codeOf(masked.gate.run(related({ text: 'BT-1', targets: [OWNER_REF] }, { mask: true })))).toBe('INVALID_REQUEST');
    expect(masked.executor.calls).toEqual([]);
    const plain = rig();
    expect(await codeOf(plain.gate.run(related({ text: 'BT-1', targets: [OWNER_REF] })))).toBe('ok');
    expect(plain.executor.calls).toHaveLength(1);
  });
});

describe('the statement of a related lookup', () => {
  const render = (text: string, targets: readonly object[], limit = 25) => renderTemplate(template, template.paramsSchema.parse({ text, targets }), allowlist, limit);

  it('has one branch for each target, joined by UNION and cut by one limit over the combined result, with names from the mapping only, quoted', () => {
    const rendered = render('BT-1', [BATCH, WIDGET_REF]);
    expect(rendered.cypher).toBe(
      'CALL { MATCH (n:`Widget`) WHERE n.`batchRef` IN [$text, $textInteger] RETURN n LIMIT $limit + 1 UNION ' +
        'MATCH (n:`Gadget`) WHERE n.`widgetRef` IN [$text, $textInteger] RETURN n LIMIT $limit + 1 } WITH n LIMIT $limit + 1 RETURN n',
    );
    expect(rendered.parameters).toEqual({ text: 'BT-1', textInteger: null, limit: 25 });
  });

  it('writes the equality form for a TEXT-indexed target and cuts every branch at the limit plus one', () => {
    const { cypher } = render('7', [{ ...BATCH, match: 'text' }, WIDGET_REF]);
    expect(cypher).toContain('MATCH (n:`Widget`) WHERE n.`batchRef` = $text RETURN n LIMIT $limit + 1');
    expect(cypher.match(/RETURN n LIMIT \$limit \+ 1/g)).toHaveLength(2);
  });

  it('keeps the typed text out of the statement, whatever it holds', () => {
    const text = "x' OR 1=1 // `y` $z @searchBranches(targets)";
    expect(render(text, [BATCH]).cypher).toBe(render('BT-1', [BATCH]).cypher);
  });

  it('leaves the statement of the exact search as it was, byte for byte', () => {
    const exact = catalog.find(SEARCH_EXACT_ID);
    if (exact === undefined) throw new Error('the catalog has no exact template');
    const target = { entityType: 'widget', property: 'widgetId', match: 'value' };
    expect(renderTemplate(exact, exact.paramsSchema.parse({ text: 'W-1', targets: [target] }), allowlist, 25).cypher).toBe(
      'CALL { MATCH (n:`Widget`) WHERE n.`widgetId` IN [$text, $textInteger] RETURN n LIMIT $limit + 1 } WITH n LIMIT $limit + 1 RETURN n',
    );
  });
});

describe('a related lookup through the real gate with a fake adapter', () => {
  it('runs as one READ with one more row than the limit, names the targets as used properties, and audits it as entity.search_related', async () => {
    const { gate, executor, audit } = rig();
    const page = await gate.run(related({ text: 'BT-1', targets: [BATCH] }));
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ accessMode: 'READ', rowLimit: 26, templateId: SEARCH_RELATED_ID });
    expect(page.hasMore).toBe(false);
    expect(audit).toEqual([expect.objectContaining({ action: 'entity.search_related', result: 'success', sourceId: source.id })]);
    expect(searchRelatedTemplate.usedProperties?.({ text: 'BT-1', targets: [BATCH, WIDGET_REF] })).toEqual([BATCH, WIDGET_REF]);
  });

  it('reads nothing for no targets, still runs every stage and records one event', async () => {
    const { gate, executor, audit } = rig();
    const page = await gate.run(related({ text: 'BT-1', targets: [] }));
    expect(executor.calls).toEqual([]);
    expect(page).toMatchObject({ hasMore: false });
    expect(audit).toEqual([expect.objectContaining({ action: 'entity.search_related', result: 'success' })]);
  });

  it('is refused when the index of a target is not online, with no data read', async () => {
    const { gate, executor } = rig();
    const gone = { sourceId: source.id, entries: ONLINE.entries.filter((entry) => entry.property !== 'batchRef') };
    expect(await codeOf(gate.run({ ...related({ text: 'BT-1', targets: [BATCH] }), indexes: gone }))).toBe('SOURCE_UNAVAILABLE');
    expect(executor.calls).toEqual([]);
  });
});

describe('the declaration of the two search templates', () => {
  it('names the list each template checks its targets against', () => {
    expect(searchExactTemplate.searchBranches?.allowlist).toBe('search');
    expect(searchRelatedTemplate.searchBranches?.allowlist).toBe('reference');
  });

  it('keeps the checks of the catalog for the related template', () => {
    const declared = searchRelatedTemplate.searchBranches;
    if (declared === undefined) throw new Error('the related template declares no search branches');
    const failure = (overrides: Partial<typeof searchRelatedTemplate>): string => {
      try {
        createTemplateCatalog({ templates: [{ ...searchRelatedTemplate, ...overrides }] });
      } catch (error) {
        return error instanceof Error ? error.message : 'not an error';
      }
      return 'accepted';
    };
    expect(failure({})).toBe('accepted');
    expect(failure({ searchBranches: { ...declared, value: 'MATCH (n:@label) WHERE n.@property IN [$text, $textInteger] RETURN n' } })).toBe('the template entity-related has a branch text with no LIMIT $limit + 1 of its own');
    expect(failure({ cypher: 'CALL { @searchBranches(targets) } RETURN n' })).toBe('the template entity-related has search branches and its Cypher has no enclosing LIMIT $limit + 1');
    expect(failure({ usedProperties: undefined })).toBe('the template entity-related has search branches and does not name the properties it uses');
    expect(failure({ indexNeeds: undefined })).toBe('the template entity-related has search branches and does not name the indexes it needs');
    expect(failure({ searchBranches: Object.assign({}, declared, { allowlist: 'anything' }) })).toBe('the template entity-related has search branches and does not say which allowlist its targets are checked against');
    expect(failure({ searchBranches: Object.assign({}, declared, { allowlist: undefined }) })).toBe('the template entity-related has search branches and does not say which allowlist its targets are checked against');
  });
});

