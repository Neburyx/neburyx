import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import type { AuditEvent } from '../seams/seams.js';
import { gateRequest, harness, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { RELATED_ENTITIES } from '../testing/search-app.js';
import { normalizedOf, onlineIndexesOf, relationshipRangeIndex } from '../testing/search-fixtures.js';
import { allowlistFromMapping } from './allowlist.js';
import { createTemplateCatalog } from './catalog.js';
import { isNormalizedEvidence } from './normalize/index.js';
import { normalizeModelOf } from './normalize/model.js';
import { EDGE_LOAD_ID, edgeLoadTemplate } from './templates/edge-load.js';

const RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', observed_at: 'seenAt', evidence: ['recordId', 'docId'] },
  { type: 'MADE_FROM', from: 'widget', to: 'part', stable_id: 'linkId' },
  { type: 'NO_ID', from: 'widget', to: 'gadget', evidence: ['recordId'] },
];
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: RELATED_ENTITIES, relationships: RELATIONSHIPS })), 'neburyx.yaml');
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const model = normalizeModelOf(source);
const allowlist = allowlistFromMapping(source);
const catalog = createTemplateCatalog({ templates: [edgeLoadTemplate] });
const ONLINE = { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) };

const widget = plainNode(['Widget'], { widgetId: 'W-1' }, '4:s:1');
const gadget = plainNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:2');
const link = (properties: Record<string, unknown>, elementId = '5:s:1') => ({ r: plainRelationship('MADE_FROM', widget, gadget, properties, elementId), a: widget, b: gadget });
const REF = { type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };

function rig(rows: readonly Record<string, unknown>[] = [link({ linkId: 'L-1', recordId: 'R-1' })]) {
  const audit: AuditEvent[] = [];
  const executor = new TestExecutor(() => Promise.resolve({ status: 'rows' as const, rows: [...rows] }));
  const parts = harness({ catalog, executor, modelFor: () => model, allowlistFor: () => allowlist, seams: { audit: { record: (event) => Promise.resolve(void audit.push(event)) } } });
  return { ...parts, audit, executor };
}

const load = (params: unknown, overrides: { readonly mask?: boolean; readonly indexes?: typeof ONLINE | 'unverified' } = {}) =>
  gateRequest({ sourceId: source.id, templateId: EDGE_LOAD_ID, params, limit: 1, indexes: overrides.indexes ?? ONLINE, ...(overrides.mask === undefined ? {} : { mask: overrides.mask }) });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('an edge read the gate refuses before any statement', () => {
  const REFUSED: readonly (readonly [string, unknown])[] = [
    ['an edge type the mapping does not name', { ...REF, type: 'NOTHING' }],
    ['an entity type used as an edge type', { ...REF, type: 'widget' }],
    ['ends the row does not map', { ...REF, to: 'widget' }],
    ['ends in the other direction', { ...REF, from: 'gadget', to: 'widget' }],
    ['a row with no stable ID', { type: 'NO_ID', from: 'widget', to: 'gadget', stableId: 'L-1' }],
    ['a type with a backtick', { ...REF, type: 'MADE_FROM` OR 1=1 //' }],
    ['a field the template does not name', { ...REF, property: 'linkId' }],
    ['no stable ID', { type: 'MADE_FROM', from: 'widget', to: 'gadget' }],
  ];

  it.each(REFUSED)('refuses %s with INVALID_REQUEST and runs no statement', async (_name, params) => {
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(load(params)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });
});

describe('an edge read the gate runs', () => {
  it('writes the quoted names of the mapping row and the stable ID as a parameter, asks for two rows and audits one event', async () => {
    const { gate, executor, audit } = rig();
    await gate.run(load(REF));
    expect(executor.calls).toHaveLength(1);
    const [call] = executor.calls;
    expect(call?.cypher).toBe('MATCH (a:`Widget`)-[r:`MADE_FROM`]->(b:`Gadget`) WHERE r.`linkId` IN [$stableId, $stableInteger] RETURN r, a, b ORDER BY elementId(r) LIMIT $limit + 1');
    expect(call?.cypher).not.toContain('L-1');
    expect(call?.parameters['stableId']).toBe('L-1');
    expect(call?.parameters['stableInteger']).toBeNull();
    expect(call?.parameters).not.toHaveProperty('type');
    expect(call?.rowLimit).toBe(2);
    expect(audit.map((event) => `${event.action} ${event.result}`)).toEqual(['edge.load success']);
  });

  it('matches a canonical 64-bit integer as the integer too', async () => {
    const { gate, executor } = rig();
    await gate.run(load({ ...REF, stableId: '9007199254740993' }));
    expect(executor.calls[0]?.parameters['stableInteger']).toEqual({ $type: 'integer', value: '9007199254740993' });
  });

  it('keeps the same statement whether masking is asked or not', async () => {
    const plain = rig();
    await plain.gate.run(load(REF));
    const masked = rig();
    await masked.gate.run(load(REF, { mask: true }));
    expect(masked.executor.calls[0]?.cypher).toBe(plain.executor.calls[0]?.cypher);
  });

  it('returns the stored edge with its ends and the records of its evidence properties', async () => {
    const { gate } = rig();
    const page = await gate.run(load(REF));
    const item = normalizedOf(page);
    expect(item.edges).toHaveLength(1);
    expect(item.edges[0]?.ref).toEqual({ sourceId: 'demo', ...REF });
    expect(item.nodes.map((node) => node.ref.stableId).sort()).toEqual(['GT-1', 'W-1']);
    expect(isNormalizedEvidence(item) && item.evidence[0]?.records).toEqual([{ sourceRecordId: 'R-1' }]);
    expect(item.edges[0]?.qualityFlags).toEqual([]);
  });

  it('flags the edge when another relationship has the same type, ends and stable ID', async () => {
    const { gate } = rig([link({ linkId: 'L-1', recordId: 'R-1' }, '5:s:1'), link({ linkId: 'L-1', recordId: 'R-2' }, '5:s:2')]);
    const page = await gate.run(load(REF));
    const item = normalizedOf(page);
    expect(item.edges).toHaveLength(1);
    expect(item.edges[0]?.qualityFlags).toContain('conflicting-duplicate');
  });

  it('answers a page with no item edge as unreadable when a row was read and its stable ID cannot be used', async () => {
    const { gate } = rig([link({ linkId: null })]);
    expect(await codeOf(gate.run(load(REF)))).toBe('INTERNAL_ERROR');
  });

  it('returns an empty answer when the source has no such edge', async () => {
    const { gate } = rig([]);
    const page = await gate.run(load(REF));
    expect(normalizedOf(page).edges).toEqual([]);
  });
});

describe('the index the edge read needs', () => {
  it('names the relationship stable ID property, by type and ends', () => {
    expect(edgeLoadTemplate.indexNeeds?.(REF, allowlist)).toEqual([{ relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'linkId', accepts: 'value' }]);
    expect(edgeLoadTemplate.usedProperties?.(REF, allowlist)).toEqual([{ relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'linkId' }]);
  });

  it.each(['POPULATING', 'FAILED'])('refuses the read before any statement when the index is %s', async (state) => {
    const entries = [...ONLINE.entries.filter((entry) => !(entry.entityType === 'RELATIONSHIP' && entry.name === 'MADE_FROM' && entry.property === 'linkId')), relationshipRangeIndex('MADE_FROM', 'linkId', state)];
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(load(REF, { indexes: { sourceId: source.id, entries } })))).toBe('SOURCE_UNAVAILABLE');
    expect(executor.calls).toEqual([]);
  });

  it('refuses the read before any statement when there is no such index', async () => {
    const entries = ONLINE.entries.filter((entry) => !(entry.entityType === 'RELATIONSHIP' && entry.name === 'MADE_FROM' && entry.property === 'linkId'));
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(load(REF, { indexes: { sourceId: source.id, entries } })))).toBe('SOURCE_UNAVAILABLE');
    expect(executor.calls).toEqual([]);
  });

  it('goes ahead unverified when the login may not list indexes', async () => {
    const { gate, executor } = rig();
    expect(await codeOf(gate.run(load(REF, { indexes: 'unverified' })))).toBe('ok');
    expect(executor.calls).toHaveLength(1);
  });
});
