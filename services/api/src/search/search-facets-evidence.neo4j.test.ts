import { writeFileSync } from 'node:fs';
import { FACET_SCOPES, SEARCH_GROUP_CAP, type SearchResult } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FacetProbe } from '../gate/templates/search-facets.js';
import { startFacetsRig, type FacetsRig } from '../testing/facets-rig.js';
import { NEO4J_SERIES } from '../testing/neo4j-server.js';

const ENTITIES = [
  { type: 'item', label: 'Item', stable_id: 'sid', search: ['sid'], reference: ['ref'] },
  { type: 'thing', label: 'Thing', stable_id: 'sid' },
];
const RELATIONSHIPS = [
  { type: 'COMMON', from: 'item', to: 'thing', stable_id: 'lid', evidence: ['rec', 'doc'] },
  { type: 'NOAGG', from: 'item', to: 'thing', evidence: ['rec'] },
];
const MANY_WRONG = 3000;

const seed = async (run: (cypher: string, parameters?: Record<string, unknown>) => Promise<void>): Promise<void> => {
  await run('CREATE INDEX item_sid FOR (n:Item) ON (n.sid)');
  await run('CREATE INDEX item_ref FOR (n:Item) ON (n.ref)');
  await run('CREATE INDEX thing_sid FOR (n:Thing) ON (n.sid)');
  await run('CREATE INDEX common_rec FOR ()-[r:COMMON]-() ON (r.rec)');
  await run('CREATE INDEX common_doc FOR ()-[r:COMMON]-() ON (r.doc)');
  await run('CREATE INDEX noagg_rec FOR ()-[r:NOAGG]-() ON (r.rec)');
  await run("CREATE (:Item {sid: 'I-1'}), (:Thing {sid: 'T-1'}), (:Foreign {sid: 'FX-1'}), (:Foreign {sid: 'FX-2'})");
  const ends = "MATCH (i:Item {sid: 'I-1'}), (t:Thing {sid: 'T-1'})";
  for (const size of [24, 25, 26, 40]) await run(`${ends} UNWIND range(1, ${size}) AS k CREATE (i)-[:COMMON {lid: 'e${size}-' + k, rec: 'ev${size}'}]->(t)`);
  await run(`${ends} UNWIND range(1, 40) AS k CREATE (i)-[:COMMON {lid: 'eb-' + k, rec: 'evboth', doc: 'evboth'}]->(t)`);
  await run(`${ends} CREATE (i)-[:COMMON {lid: 'rare', rec: 'evrare'}]->(t), (i)-[:NOAGG {rec: 'evnoagg'}]->(t)`);
  await run(`MATCH (a:Foreign {sid: 'FX-1'}), (b:Foreign {sid: 'FX-2'}) UNWIND range(1, ${MANY_WRONG}) AS k CREATE (a)-[:COMMON {lid: 'w-' + k, rec: 'wrongends'}]->(b)`);
  await run(`${ends} UNWIND range(1, 12) AS k CREATE (:Item {sid: 'ref-' + k, ref: 'refval'})`);
  await run("CREATE (:Item {sid: 'ev24', ref: 'x'})");
};

let rig: FacetsRig;
let breakable: FacetsRig;

beforeAll(async () => {
  rig = await startFacetsRig({ mapping: { entities: ENTITIES, relationships: RELATIONSHIPS }, seed });
  breakable = await startFacetsRig({ mapping: { entities: ENTITIES, relationships: RELATIONSHIPS }, seed });
}, 600_000);

afterAll(async () => {
  await Promise.allSettled([rig?.close(), breakable?.close()]);
});

const facets = (answer: SearchResult) => {
  if (answer.facets === undefined || !answer.facets.searchable) throw new Error('the answer has no facets');
  return answer.facets;
};
const evidenceCount = (answer: SearchResult) => facets(answer).matchMode.find((entry) => entry.mode === 'evidence')?.count;
const evidenceProbe = (...properties: string[]): FacetProbe => ({ targets: properties.map((property) => ({ kind: 'evidence' as const, relationshipType: 'COMMON', from: 'item', to: 'thing', property, match: 'value' as const })) });
const independent = (rec: string) => rig.independent('MATCH (:Item)-[r:COMMON]->(:Thing) WHERE r.rec = $t OR r.doc = $t RETURN count(DISTINCT r) AS c', { t: rec });

describe(`the evidence count of the facets against an independent count, on ${NEO4J_SERIES}`, () => {
  it.each([24, 25, 26])('counts %i supporting relationships as the capped independent count and as the evidence group does', async (size) => {
    const found = await independent(`ev${size}`);
    expect(found).toBe(size);
    const answer = await rig.search(`ev${size}`);
    const expected = found > SEARCH_GROUP_CAP ? { value: SEARCH_GROUP_CAP, quality: 'lowerBound' } : { value: found, quality: 'exact' };
    expect(evidenceCount(answer)).toEqual({ ...expected, scope: FACET_SCOPES.matchMode });
    expect(answer.evidence.count).toMatchObject(expected);
  });

  it('counts a relationship that two evidence properties carry the text in once', async () => {
    const answer = await rig.search('evboth');
    expect(await independent('evboth')).toBe(40);
    expect(evidenceCount(answer)).toMatchObject({ value: 25, quality: 'lowerBound' });
  });

  it('does not count a relationship of the type between other entity types, whatever their number', async () => {
    const answer = await rig.search('wrongends');
    expect(evidenceCount(answer)).toEqual({ value: 0, quality: 'exact', scope: FACET_SCOPES.matchMode });
    expect(answer.evidence.hits).toEqual([]);
    expect(answer.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
  });

  it('has no probe for a relationship row without a stable ID, and the group names it', async () => {
    const from = rig.statements.length;
    const answer = await rig.search('evnoagg');
    expect(answer.evidence.disabledRelationshipTypes).toEqual([{ relationshipType: 'NOAGG', from: 'item', to: 'thing', reason: 'no-stable-id' }]);
    const facetStatement = rig.statements.slice(from).find((call) => call.templateId === 'search-facets');
    expect(facetStatement?.cypher).not.toContain('NOAGG');
    expect(evidenceCount(answer)).toMatchObject({ value: 0 });
  });

  it('counts an entity and a relationship that carry the same text apart, the entity in the total and its type and the relationship in the evidence mode only', async () => {
    const answer = await rig.search('ev24');
    expect(facets(answer).total).toMatchObject({ value: 1, quality: 'exact' });
    expect(facets(answer).entityType.find((entry) => entry.entityType === 'item')?.count).toMatchObject({ value: 1 });
    expect(evidenceCount(answer)).toMatchObject({ value: 24 });
  });
});

describe(`the plan of the evidence probe, on ${NEO4J_SERIES}`, () => {
  it.each([
    ['a rare value', 'evrare', [evidenceProbe('rec')]],
    ['a common value that more than the cap matches on two properties', 'evboth', [evidenceProbe('rec', 'doc')]],
    ['overlapping targets of several probes', 'evboth', [evidenceProbe('rec', 'doc'), evidenceProbe('rec'), evidenceProbe('doc')]],
    ['a value carried by many relationships between other end types', 'wrongends', [evidenceProbe('rec')]],
  ])('seeks the relationship index of every branch and emits at most the cap plus one rows from each, for %s', async (name, text, probes) => {
    const { operators, row } = await rig.profile(text, probes);
    const names = operators.map((operator) => operator.name);
    const branches = probes.reduce((total, probe) => total + probe.targets.length, 0);
    expect(names.filter((operatorName) => /RelationshipIndexSeek/.test(operatorName)), names.join(' > ')).toHaveLength(branches);
    expect(names.some((operatorName) => /RelationshipTypeScan|NodeByLabelScan|AllNodesScan|IndexScan/.test(operatorName)), names.join(' > ')).toBe(false);
    expect(operators.filter((operator) => operator.name.startsWith('Limit')).every((operator) => operator.rows <= SEARCH_GROUP_CAP + 1)).toBe(true);
    expect(Object.values(row).every((count) => count <= SEARCH_GROUP_CAP + 1)).toBe(true);
    if (process.env['FACET_PROFILE_OUT'] !== undefined) {
      writeFileSync(`${process.env['FACET_PROFILE_OUT']}-evidence-${name.replaceAll(' ', '-')}.json`, JSON.stringify({ text, row, seeks: operators.filter((operator) => /Seek/.test(operator.name)), filters: operators.filter((operator) => /Filter/.test(operator.name)), limits: operators.filter((operator) => operator.name.startsWith('Limit')).map((operator) => operator.rows) }, null, 2));
    }
    if (text === 'wrongends') {
      // the work is bounded by the relationships that carry the value, not by the cap: they are read through the seek and rejected by the end labels; no bound is claimed for it
      const seek = operators.find((operator) => /RelationshipIndexSeek/.test(operator.name));
      expect(seek?.rows).toBe(MANY_WRONG);
      expect(row['c0']).toBe(0);
    }
  });
});

describe(`the guard under the facets, on ${NEO4J_SERIES}`, () => {
  it('leaves a relationship row whose index was dropped after the API started out whole: no evidence entry, the group names the row, no statement names the row', async () => {
    await breakable.search('ev24');
    await breakable.admin('DROP INDEX common_doc');
    const from = breakable.statements.length;
    const answer = await breakable.search('ev24');
    expect(answer.evidence.disabledRelationshipTypes).toEqual([
      { relationshipType: 'COMMON', from: 'item', to: 'thing', reason: 'index-unavailable' },
      { relationshipType: 'NOAGG', from: 'item', to: 'thing', reason: 'no-stable-id' },
    ]);
    expect(evidenceCount(answer)).toBeUndefined();
    expect(breakable.statements.slice(from).filter((call) => /COMMON/.test(call.cypher))).toEqual([]);
    expect(breakable.statements.slice(from).filter((call) => call.templateId === 'schema-indexes')).toHaveLength(1);
  });

  it('counts an entity type by the matches of the group that kept its index when the other group lost it, and the group that lost it names the type', async () => {
    await breakable.admin('DROP INDEX item_ref');
    const answer = await breakable.search('ev24');
    expect(answer.related.disabledTypes).toEqual([{ entityType: 'item', reason: 'index-unavailable' }]);
    expect(facets(answer).entityType.find((entry) => entry.entityType === 'item')?.count).toMatchObject({ value: 1, quality: 'exact' });
    expect(facets(answer).matchMode.find((entry) => entry.mode === 'related')).toBeUndefined();
  });
});

describe(`a schema read that fails before the facets, on ${NEO4J_SERIES}`, () => {
  it.each([
    ['QUERY_TIMEOUT', () => rig.onStatement((call) => (call.templateId === 'schema-indexes' ? { status: 'timeout' } : undefined))],
    ['SOURCE_UNAVAILABLE', () => rig.onStatement((call) => (call.templateId === 'schema-indexes' ? { status: 'unavailable', reason: 'unreachable' } : undefined))],
    ['INTERNAL_ERROR', () => rig.onStatement((call) => (call.templateId === 'schema-indexes' ? { status: 'rows', rows: [{ name: 'broken' }] } : undefined))],
    ['SOURCE_BUSY', () => rig.setBusy(true)],
  ])('fails the search with %s, the code of the schema read, and runs no data read', async (code, inject) => {
    const from = rig.statements.length;
    inject();
    try {
      await expect(rig.search('ev24')).rejects.toMatchObject({ code });
      expect(rig.statements.slice(from).filter((call) => call.templateId !== 'schema-indexes')).toEqual([]);
    } finally {
      rig.onStatement(undefined);
      rig.setBusy(false);
    }
  });
});
