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
import { normalizeModelOf } from './normalize/model.js';
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

function rig() {
  const audit: AuditEvent[] = [];
  const executor = new TestExecutor(() => Promise.resolve({ status: 'rows' as const, rows: [] }));
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
    ['a row with no stable ID', { text: 'R-1', targets: [{ ...RECORD, relationshipType: 'NO_ID' }] }],
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
    expect(call?.cypher).toBe('CALL { MATCH (a:`Widget`)-[r:`MADE_FROM`]->(b:`Gadget`) USING RANGE INDEX SEEK r:`MADE_FROM`(`recordId`) WHERE r.`recordId` IN [$text, $textInteger] RETURN r, a, b LIMIT $limit + 1 UNION MATCH (a:`Widget`)-[r:`MADE_FROM`]->(b:`Gadget`) USING TEXT INDEX r:`MADE_FROM`(`docId`) WHERE r.`docId` = $text RETURN r, a, b LIMIT $limit + 1 } WITH r, a, b LIMIT $limit + 1 RETURN r, a, b');
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
    expect(rendered.cypher).toBe('CALL {  } WITH r, a, b LIMIT $limit + 1 RETURN r, a, b');
  });
});

function failNoTemplate(): never {
  throw new Error('the catalog has no evidence template');
}
