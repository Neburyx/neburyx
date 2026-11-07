import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import type { AuditEvent } from '../seams/seams.js';
import { gateRequest, harness, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { RELATED_ENTITIES } from '../testing/search-app.js';
import { onlineIndexesOf, relationshipRangeIndex, relationshipTextIndex } from '../testing/search-fixtures.js';
import { allowlistFromMapping } from './allowlist.js';
import { createTemplateCatalog } from './catalog.js';
import { isNormalizedEvidence, type Normalized } from './normalize/index.js';
import { normalizeModelOf } from './normalize/model.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { renderTemplate } from './render.js';
import { SEARCH_EVIDENCE_ID, searchEvidenceTemplate } from './templates/search-evidence.js';
import { searchExactTemplate } from './templates/search-exact.js';

const RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId', 'docId'] },
  { type: 'MADE_FROM', from: 'widget', to: 'part', stable_id: 'linkId' },
  { type: 'part', from: 'gadget', to: 'widget', stable_id: 'linkId', evidence: ['recordId'] },
  { type: 'NO_ID', from: 'widget', to: 'gadget', evidence: ['recordId'] },
];
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: RELATED_ENTITIES, relationships: RELATIONSHIPS })), 'neburyx.yaml');
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const model = normalizeModelOf(source);
const allowlist = allowlistFromMapping(source);
const catalog = createTemplateCatalog({ templates: [searchExactTemplate, searchEvidenceTemplate] });
const ONLINE = { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) };

const RECORD = { relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'recordId', match: 'value' as const };
const DOC = { relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'docId', match: 'text' as const };

function rig(rows: readonly Record<string, unknown>[] = []) {
  const audit: AuditEvent[] = [];
  const executor = new TestExecutor(() => Promise.resolve({ status: 'rows' as const, rows: [...rows] }));
  const parts = harness({ catalog, executor, modelFor: () => model, allowlistFor: () => allowlist, seams: { audit: { record: (event) => Promise.resolve(void audit.push(event)) } } });
  return { ...parts, audit, executor };
}

const evidence = (params: unknown, overrides: { readonly mask?: boolean } = {}) =>
  gateRequest({ sourceId: source.id, templateId: SEARCH_EVIDENCE_ID, params, limit: 25, indexes: ONLINE, ...(overrides.mask === undefined ? {} : { mask: overrides.mask }) });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('an evidence lookup the gate refuses before any read', () => {
  const REFUSED: readonly (readonly [string, unknown])[] = [
    ['a relationship type the mapping does not name', { text: 'R-1', targets: [{ ...RECORD, relationshipType: 'NOTHING' }] }],
    ['an entity type used as a relationship type', { text: 'R-1', targets: [{ ...RECORD, relationshipType: 'widget' }] }],
    ['ends the row does not map', { text: 'R-1', targets: [{ ...RECORD, to: 'part' }] }],
    ['ends in the other direction', { text: 'R-1', targets: [{ ...RECORD, from: 'gadget', to: 'widget' }] }],
    ['a property the row has no evidence for', { text: 'R-1', targets: [{ ...RECORD, property: 'linkId' }] }],
    ['a row with no evidence property', { text: 'R-1', targets: [{ ...RECORD, to: 'part', property: 'recordId' }] }],
    ['a row with no stable ID, with ends the row does not map', { text: 'R-1', targets: [{ ...RECORD, relationshipType: 'NO_ID', from: 'gadget', to: 'widget' }] }],
    ['a row with no stable ID, with a property it has no evidence for', { text: 'R-1', targets: [{ ...RECORD, relationshipType: 'NO_ID', property: 'docId' }] }],
    ['a property name with a backtick', { text: 'R-1', targets: [{ ...RECORD, property: 'recordId` OR 1=1 //' }] }],
    ['the same target twice', { text: 'R-1', targets: [RECORD, RECORD] }],
    ['a field the template does not name', { text: 'R-1', targets: [RECORD], group: 'evidence' }],
    ['an entity target', { text: 'R-1', targets: [{ entityType: 'widget', property: 'widgetId', match: 'value' }] }],
    ['no list of targets', { text: 'R-1' }],
  ];

  it.each(REFUSED)('refuses %s with INVALID_REQUEST and runs no statement', async (_name, params) => {
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(evidence(params)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });
});

describe('an evidence lookup the gate runs', () => {
  it('writes one branch for each target with the quoted names of the row, the labels of its two ends and no value, and one read', async () => {
    const { gate, executor, audit } = rig();
    await gate.run(evidence({ text: 'R-1', targets: [RECORD, DOC] }));
    expect(executor.calls).toHaveLength(1);
    const [call] = executor.calls;
    expect(call?.cypher).toBe('CALL { MATCH (a:`Widget`)-[r:`MADE_FROM`]->(b:`Gadget`) USING RANGE INDEX SEEK r:`MADE_FROM`(`recordId`) WHERE r.`recordId` IN [$text, $textInteger] AND ($cursor IS NULL OR elementId(r) > $cursor.after) WITH r, a, b ORDER BY elementId(r) LIMIT $limit + 1 RETURN r, a, b UNION MATCH (a:`Widget`)-[r:`MADE_FROM`]->(b:`Gadget`) USING TEXT INDEX r:`MADE_FROM`(`docId`) WHERE r.`docId` = $text AND ($cursor IS NULL OR elementId(r) > $cursor.after) WITH r, a, b ORDER BY elementId(r) LIMIT $limit + 1 RETURN r, a, b } WITH r, a, b ORDER BY elementId(r) LIMIT $limit + 1 RETURN r, a, b');
    expect(call?.cypher).not.toContain('R-1');
    expect(call?.rowLimit).toBe(26);
    expect(audit.map((event) => `${event.action} ${event.result}`)).toEqual(['entity.search_evidence success']);
  });

  it('keeps a relationship type that shares its name with an entity type, with the mask true and false', async () => {
    const target = { relationshipType: 'part', from: 'gadget', to: 'widget', property: 'recordId', match: 'value' as const };
    for (const mask of [false, true]) {
      const { gate, executor } = rig();
      await gate.run(evidence({ text: 'R-1', targets: [target] }, { mask }));
      expect(executor.calls[0]?.cypher).toContain('MATCH (a:`Gadget`)-[r:`part`]->(b:`Widget`) USING RANGE INDEX SEEK r:`part`(`recordId`) WHERE r.`recordId` IN [$text, $textInteger]');
    }
  });

  it('names every target in `usedProperties`, by relationship type, ends and property', () => {
    const used = searchEvidenceTemplate.usedProperties?.({ text: 'R-1', targets: [RECORD, DOC] });
    expect(used).toEqual([
      { relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'recordId' },
      { relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'docId' },
    ]);
  });

  it('needs a relationship index of the kind each target reads, and finds out before the read', async () => {
    const needs = searchEvidenceTemplate.indexNeeds?.({ text: 'R-1', targets: [RECORD, DOC] }, allowlist);
    expect(needs).toEqual([
      { relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'recordId', accepts: 'value' },
      { relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'docId', accepts: 'any' },
    ]);
    const missing = { sourceId: source.id, entries: [...ONLINE.entries.filter((entry) => !(entry.entityType === 'RELATIONSHIP' && entry.property === 'docId')), relationshipTextIndex('MADE_FROM', 'docId', 'POPULATING')] };
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(gateRequest({ sourceId: source.id, templateId: SEARCH_EVIDENCE_ID, params: { text: 'R-1', targets: [RECORD, DOC] }, limit: 25, indexes: missing })))).toBe('SOURCE_UNAVAILABLE');
    expect(executor.calls).toEqual([]);
    const online = { sourceId: source.id, entries: [...ONLINE.entries.filter((entry) => !(entry.entityType === 'RELATIONSHIP' && entry.property === 'docId')), relationshipTextIndex('MADE_FROM', 'docId')] };
    const ok = rig();
    expect(await codeOf(ok.gate.run(gateRequest({ sourceId: source.id, templateId: SEARCH_EVIDENCE_ID, params: { text: 'R-1', targets: [RECORD, DOC] }, limit: 25, indexes: online })))).toBe('ok');
    expect(ok.executor.calls).toHaveLength(1);
  });

  it('does not take a node index for a relationship property', async () => {
    const nodeOnly = { sourceId: source.id, entries: [...ONLINE.entries.filter((entry) => entry.entityType !== 'RELATIONSHIP'), { ...relationshipRangeIndex('MADE_FROM', 'recordId'), entityType: 'NODE' as const }] };
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(gateRequest({ sourceId: source.id, templateId: SEARCH_EVIDENCE_ID, params: { text: 'R-1', targets: [RECORD] }, limit: 25, indexes: nodeOnly })))).toBe('SOURCE_UNAVAILABLE');
    expect(executor.calls).toEqual([]);
  });

  it('renders a read of nothing for an empty list of targets and writes no value into the statement', () => {
    expect(searchEvidenceTemplate.readsNothing?.({ text: 'R-1', targets: [] }, allowlist)).toBe(true);
    const rendered = renderTemplate(catalog.find(SEARCH_EVIDENCE_ID) ?? failNoTemplate(), { text: 'R-1', targets: [] }, allowlist, 25);
    expect(rendered.cypher).toBe('CALL {  } WITH r, a, b ORDER BY elementId(r) LIMIT $limit + 1 RETURN r, a, b');
  });
});

const NO_ID = { relationshipType: 'NO_ID', from: 'widget', to: 'gadget', property: 'recordId', match: 'value' as const };

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.reason : 'not an AppError';
  }
}

describe('an evidence lookup of a row with no stable ID', () => {
  it('writes its branch as a row with one is written: the quoted names of the row, the labels of its ends and the index it seeks', async () => {
    const { gate, executor } = rig();
    await gate.run(evidence({ text: 'R-1', targets: [NO_ID] }));
    expect(executor.calls[0]?.cypher).toContain('CALL { MATCH (a:`Widget`)-[r:`NO_ID`]->(b:`Gadget`) USING RANGE INDEX SEEK r:`NO_ID`(`recordId`) WHERE r.`recordId` IN [$text, $textInteger] AND ($cursor IS NULL OR elementId(r) > $cursor.after)');
  });

  it('needs the index of its evidence property as any other row', () => {
    expect(searchEvidenceTemplate.indexNeeds?.({ text: 'R-1', targets: [NO_ID] }, allowlist)).toEqual([{ relationshipType: 'NO_ID', from: 'widget', to: 'gadget', property: 'recordId', accepts: 'value' }]);
  });

  it.each([
    ['missing', [], 'index-unavailable'],
    ['building', [relationshipRangeIndex('NO_ID', 'recordId', 'POPULATING')], 'index-building'],
    ['failed', [relationshipRangeIndex('NO_ID', 'recordId', 'FAILED')], 'index-failed'],
  ] as const)('refuses a read written by hand whose index is %s, before any statement runs', async (_name, extra, reason) => {
    const indexes = { sourceId: source.id, entries: [...ONLINE.entries.filter((entry) => !(entry.entityType === 'RELATIONSHIP' && entry.name === 'NO_ID')), ...extra] };
    const { gate, executor, audit } = rig();
    const request = gateRequest({ sourceId: source.id, templateId: SEARCH_EVIDENCE_ID, params: { text: 'R-1', targets: [NO_ID] }, limit: 25, indexes });
    expect(await codeOf(gate.run(request))).toBe('SOURCE_UNAVAILABLE');
    expect(await reasonOf(gate.run(request))).toBe(reason);
    expect(executor.calls).toEqual([]);
    expect(audit.map((event) => event.result)).toEqual(['refused', 'refused']);
  });
});

describe('what the evidence lookup normalizes', () => {
  const widgetNode = plainNode(['Widget'], { widgetId: 'W-1' });
  const gadgetNode = plainNode(['Gadget'], { gadgetId: 'GT-1' });
  const member = (elementId: string, properties: Record<string, unknown>) => ({ r: plainRelationship('NO_ID', widgetNode, gadgetNode, properties, elementId), a: widgetNode, b: gadgetNode });
  const itemOf = async (rows: readonly Record<string, unknown>[], params: unknown = { text: 'R-1', targets: [NO_ID] }) => {
    const { gate } = rig(rows);
    const page = await gate.run(evidence(params));
    const [item] = page.items;
    if (item === undefined || !isNormalized(item) || !isNormalizedEvidence(item)) throw new Error('the page holds no evidence');
    return item;
  };

  it('gives each relationship of a row with no stable ID its element ID and records as a member of the aggregate of its ends, and keeps the aggregate edge as it was', async () => {
    const item = await itemOf([member('5:n:1', { recordId: 'R-1' }), member('5:n:2', { recordId: 'R-1' })]);
    const aggregate = { type: 'NO_ID', from: { sourceId: source.id, entityType: 'widget', stableId: 'W-1' }, to: { sourceId: source.id, entityType: 'gadget', stableId: 'GT-1' } };
    expect(item.evidence).toEqual([
      { elementId: '5:n:1', of: { aggregate }, records: [{ sourceRecordId: 'R-1' }] },
      { elementId: '5:n:2', of: { aggregate }, records: [{ sourceRecordId: 'R-1' }] },
    ]);
    expect(item.edges).toHaveLength(1);
    expect(item.edges[0]).toMatchObject({ ref: { sourceId: source.id, aggregate }, memberCount: { value: 2, quality: 'exact', scope: 'members' }, evidenceRefs: [] });
  });

  it('keeps an evidence value that is neither text nor a number as unreadable with its property, beside the values it can read', async () => {
    const stored = { r: plainRelationship('MADE_FROM', widgetNode, gadgetNode, { linkId: 'L-1', recordId: 'R-1', docId: [1, 2] }, '5:s:1'), a: widgetNode, b: gadgetNode };
    const item = await itemOf([stored, member('5:n:1', { recordId: { $type: 'point', srid: 7203, x: 1, y: 2 } })], { text: 'R-1', targets: [RECORD, NO_ID] });
    expect(item.evidence.map((entry) => entry.records)).toEqual([[{ sourceRecordId: 'R-1' }, { property: 'docId', unreadable: true }], [{ property: 'recordId', unreadable: true }]]);
  });

  it('resolves an end whose labels match two entity types as the type its row maps, so the relationship is not left out', async () => {
    const both = plainNode(['Widget', 'Gadget'], { widgetId: 'W-2', gadgetId: 'GT-2' });
    const row = { r: plainRelationship('NO_ID', both, gadgetNode, { recordId: 'R-1' }, '5:n:9'), a: both, b: gadgetNode };
    const item = await itemOf([row]);
    expect(item.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
    expect(item.evidence).toEqual([{ elementId: '5:n:9', of: { aggregate: { type: 'NO_ID', from: { sourceId: source.id, entityType: 'widget', stableId: 'W-2' }, to: { sourceId: source.id, entityType: 'gadget', stableId: 'GT-1' } } }, records: [{ sourceRecordId: 'R-1' }] }]);
  });
});

function isNormalized(item: unknown): item is Normalized {
  return typeof item === 'object' && item !== null && 'nodes' in item && Array.isArray(item.nodes) && 'edges' in item && Array.isArray(item.edges);
}

function failNoTemplate(): never {
  throw new Error('the catalog has no evidence template');
}
