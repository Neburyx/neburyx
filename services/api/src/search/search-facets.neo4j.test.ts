import { writeFileSync } from 'node:fs';
import { FACET_SCOPES, SEARCH_GROUP_CAP, type SearchResult } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { FacetProbe } from '../gate/templates/search-facets.js';
import { startFacetsRig, type FacetsRig } from '../testing/facets-rig.js';
import { NEO4J_SERIES } from '../testing/neo4j-server.js';

const ENTITIES = [
  { type: 'item', label: 'Item', stable_id: 'sid', search: ['sid', 'tag'], reference: ['ref'] },
  { type: 'other', label: 'Other', stable_id: 'sid', search: ['sid', 'tag'] },
  { type: 'texty', label: 'Texty', stable_id: 'sid', search: ['note'] },
];
const SIZES = [24, 25, 26, 40];
/** The count cap of the main source: above the page of 25, so a facet tells how far the pages go, and below 40, so a count above it is a lower bound. */
const COUNT_CAP = 30;

let rig: FacetsRig;
let small: FacetsRig;

const seedAll = async (run: (cypher: string, parameters?: Record<string, unknown>) => Promise<void>): Promise<void> => {
  for (const label of ['Item', 'Other']) {
    await run(`CREATE INDEX ${label.toLowerCase()}_sid FOR (n:${label}) ON (n.sid)`);
    await run(`CREATE INDEX ${label.toLowerCase()}_tag FOR (n:${label}) ON (n.tag)`);
  }
  await run('CREATE INDEX item_ref FOR (n:Item) ON (n.ref)');
  await run('CREATE INDEX texty_sid FOR (n:Texty) ON (n.sid)');
  await run('CREATE TEXT INDEX texty_note FOR (n:Texty) ON (n.note)');
  for (const size of SIZES) {
    await run(`UNWIND range(1, ${size}) AS k CREATE (:Item {sid: 'tag${size}-' + k, tag: 'tag${size}'})`);
    await run(`UNWIND range(1, ${size}) AS k CREATE (:Item {sid: 'ref${size}-' + k, ref: 'ref${size}'})`);
  }
  // two types, an item matched both ways, an entity that carries both labels, and a value that two properties of the same nodes carry
  await run("UNWIND range(1, 3) AS k CREATE (:Item {sid: 'mix-i' + k, tag: 'mix'})");
  await run("CREATE (:Item {sid: 'mix-i4', tag: 'mix', ref: 'mix'}), (:Other {sid: 'mix-o1', tag: 'mix'}), (:Other {sid: 'mix-o2', tag: 'mix'}), (:Item:Other {sid: 'mix-x', tag: 'mix'})");
  await run("UNWIND range(1, 40) AS k CREATE (:Item {sid: 'both-' + k, tag: 'both', ref: 'both'})");
  await run("UNWIND range(1, 30) AS k CREATE (:Item {sid: 'page-' + k, tag: 'page'})");
  await run("CREATE (:Item {sid: 'int-s', tag: '123'}), (:Item {sid: 'int-n', tag: 123})");
  await run("CREATE (:Texty {sid: 'tx-s', note: '55'}), (:Texty {sid: 'tx-n', note: 55})");
  await run('UNWIND range(1, 4000) AS k CREATE (:Item {sid: "noise-" + k, tag: "noise-" + k})');
};

beforeAll(async () => {
  rig = await startFacetsRig({ mapping: { entities: ENTITIES, relationships: [], budgets: { heavy_op_threshold: COUNT_CAP } }, seed: seedAll });
  small = await startFacetsRig({
    mapping: { entities: ENTITIES, relationships: [], budgets: { max_page: 10, default_page: 10 } },
    seed: async (run) => {
      await run('CREATE INDEX item_sid FOR (n:Item) ON (n.sid)');
      await run('CREATE INDEX item_tag FOR (n:Item) ON (n.tag)');
      await run('CREATE INDEX item_ref FOR (n:Item) ON (n.ref)');
      await run('CREATE INDEX other_sid FOR (n:Other) ON (n.sid)');
      await run('CREATE INDEX other_tag FOR (n:Other) ON (n.tag)');
      await run('CREATE INDEX texty_sid FOR (n:Texty) ON (n.sid)');
      await run('CREATE TEXT INDEX texty_note FOR (n:Texty) ON (n.note)');
      await run("UNWIND range(1, 10) AS k CREATE (:Item {sid: 'ten-' + k, tag: 'ten'})");
      await run("UNWIND range(1, 11) AS k CREATE (:Item {sid: 'eleven-' + k, tag: 'eleven'})");
    },
  });
}, 600_000);

afterAll(async () => {
  await Promise.allSettled([rig?.close(), small?.close()]);
});

const facets = (answer: SearchResult) => {
  if (answer.facets === undefined || !answer.facets.searchable) throw new Error('the answer has no facets');
  return answer.facets;
};
const countOf = (found: number, cap = COUNT_CAP) => (found > cap ? { value: cap, quality: 'lowerBound' } : { value: found, quality: 'exact' });
const groupCountOf = (found: number) => countOf(found, SEARCH_GROUP_CAP);
const typeCount = (answer: SearchResult, type: string) => facets(answer).entityType.find((entry) => entry.entityType === type)?.count;
const modeCount = (answer: SearchResult, mode: string) => facets(answer).matchMode.find((entry) => entry.mode === mode)?.count;

describe(`the facet counts against an independent count, on ${NEO4J_SERIES}`, () => {
  it.each(SIZES)('counts %i matches of a search property: the entity type, Exact ID and the total equal the independent count capped at the count cap, past the page', async (size) => {
    const independent = await rig.independent('MATCH (n:Item) WHERE n.tag = $t RETURN count(n) AS c', { t: `tag${size}` });
    expect(independent).toBe(size);
    const answer = await rig.search(`tag${size}`);
    const expected = countOf(independent);
    expect(typeCount(answer, 'item')).toEqual({ ...expected, scope: FACET_SCOPES.entityType });
    expect(modeCount(answer, 'exact')).toEqual({ ...expected, scope: FACET_SCOPES.matchMode });
    expect(facets(answer).total).toEqual({ ...expected, scope: FACET_SCOPES.total });
    expect(answer.counts.exact).toMatchObject(groupCountOf(independent));
  });

  it.each(SIZES)('counts %i matches of a reference property: Referenced ID equals the independent count capped at the count cap, and the related group holds a page', async (size) => {
    const independent = await rig.independent('MATCH (n:Item) WHERE n.ref = $t RETURN count(n) AS c', { t: `ref${size}` });
    const answer = await rig.search(`ref${size}`);
    expect(modeCount(answer, 'related')).toEqual({ ...countOf(independent), scope: FACET_SCOPES.matchMode });
    expect(answer.related.count).toMatchObject(groupCountOf(independent));
    expect(modeCount(answer, 'exact')).toEqual({ value: 0, quality: 'exact', scope: FACET_SCOPES.matchMode });
  });

  it('counts past the page up to the count cap: exact when the match set fits the cap, a lower bound of the cap above it, never lower than the hits held', async () => {
    const larger = await rig.search('tag40');
    expect(larger.exact).toHaveLength(25);
    expect(typeCount(larger, 'item')).toMatchObject({ value: COUNT_CAP, quality: 'lowerBound' });
    const equal = await rig.search('tag25');
    expect(equal.exact).toHaveLength(25);
    expect(typeCount(equal, 'item')).toMatchObject({ value: equal.exact.length, quality: 'exact' });
    const beyond = await rig.search('page');
    expect(beyond.exact).toHaveLength(25);
    expect(beyond.counts.exact).toMatchObject({ value: 25, quality: 'lowerBound' });
    expect(beyond.exactNextCursor).toEqual(expect.any(String));
    expect(modeCount(beyond, 'exact')).toMatchObject({ value: 30, quality: 'exact' });
  });

  it('counts two entity types, an item matched both ways and an entity of two mapped labels as their independent counts', async () => {
    const answer = await rig.search('mix');
    const item = await rig.independent('MATCH (n:Item) WHERE n.tag = $t OR n.ref = $t RETURN count(DISTINCT n) AS c', { t: 'mix' });
    const other = await rig.independent('MATCH (n:Other) WHERE n.tag = $t RETURN count(DISTINCT n) AS c', { t: 'mix' });
    const exact = await rig.independent('MATCH (n) WHERE n.tag = $t RETURN count(DISTINCT n) AS c', { t: 'mix' });
    const related = await rig.independent('MATCH (n) WHERE n.ref = $t RETURN count(DISTINCT n) AS c', { t: 'mix' });
    const total = await rig.independent('MATCH (n) WHERE n.tag = $t OR n.ref = $t RETURN count(DISTINCT n) AS c', { t: 'mix' });
    expect([item, other, exact, related, total]).toEqual([5, 3, 7, 1, 7]);
    expect(typeCount(answer, 'item')).toMatchObject({ value: item, quality: 'exact' });
    expect(typeCount(answer, 'other')).toMatchObject({ value: other, quality: 'exact' });
    // the entity of two mapped labels is a hit of each of its types, so the group holds one hit more than the nodes the read counts, and a count is never shown below the hits held
    expect(answer.exact).toHaveLength(exact + 1);
    expect(modeCount(answer, 'exact')).toEqual({ value: exact + 1, quality: 'lowerBound', scope: FACET_SCOPES.matchMode });
    expect(modeCount(answer, 'related')).toMatchObject({ value: related });
    expect(facets(answer).total).toEqual({ value: total + 1, quality: 'lowerBound', scope: FACET_SCOPES.total });
  });

  it('counts a node that two properties carry the text in once, in every entry', async () => {
    const answer = await rig.search('both');
    expect(typeCount(answer, 'item')).toMatchObject({ value: COUNT_CAP, quality: 'lowerBound' });
    const independent = await rig.independent('MATCH (n:Item) WHERE n.tag = $t OR n.ref = $t RETURN count(DISTINCT n) AS c', { t: 'both' });
    expect(independent).toBe(40);
  });

  it('counts 10 and 11 as exact for a source whose max_page is 10, by the default count cap of 500 and not the page, which holds 10', async () => {
    const exact = await small.search('ten');
    const beyond = await small.search('eleven');
    expect(exact.cap).toBe(10);
    expect(typeCount(exact, 'item')).toEqual({ value: 10, quality: 'exact', scope: FACET_SCOPES.entityType });
    expect(typeCount(beyond, 'item')).toEqual({ value: 11, quality: 'exact', scope: FACET_SCOPES.entityType });
    expect(beyond.counts.exact).toMatchObject({ value: 10, quality: 'lowerBound' });
    expect(small.statements.filter((statement) => statement.templateId === 'search-facets').every((statement) => statement.parameters['countCap'] === 500)).toBe(true);
  });

  it('counts nothing as 0 exact in every entry', async () => {
    const answer = await rig.search('no-such-text');
    expect(facets(answer).entityType.every((entry) => entry.count.quality === 'exact' && 'value' in entry.count && entry.count.value === 0)).toBe(true);
    expect(facets(answer).total).toMatchObject({ value: 0, quality: 'exact' });
  });

  it('matches the integer a canonical integer text names as well as the text for a RANGE index, and the text only for a TEXT index', async () => {
    const range = await rig.search('123');
    expect(typeCount(range, 'item')).toMatchObject({ value: 2, quality: 'exact' });
    const text = await rig.search('55');
    expect(typeCount(text, 'texty')).toMatchObject({ value: 1, quality: 'exact' });
  });
});

describe(`the one statement of the facets, on ${NEO4J_SERIES}`, () => {
  it('is one statement, in one transaction, for all the facets of a search', async () => {
    const from = rig.statements.length;
    await rig.search('mix');
    const sent = rig.statements.slice(from).filter((statement) => statement.templateId === 'search-facets');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.cypher.split('\n').filter((line) => line.startsWith('CALL')).length).toBeGreaterThan(3);
  });

  const probes = (property: string[]): FacetProbe[] => [{ targets: property.map((name) => ({ kind: name === 'ref' ? ('reference' as const) : ('search' as const), entityType: 'item', property: name, match: 'value' as const })) }];

  it.each([
    ['a rare value', 'tag24', ['sid', 'tag']],
    ['a common value that more than the cap matches on two properties', 'both', ['tag', 'ref']],
    ['the same two properties for a value only one of them carries', 'tag40', ['tag', 'ref']],
  ])('seeks an index for every branch and emits at most the count cap plus one rows from each, for %s', async (_name, text, properties) => {
    const targets = properties.map((name) => ({ kind: name === 'ref' ? ('reference' as const) : ('search' as const), entityType: 'item', property: name, match: 'value' as const }));
    const { operators, row } = await rig.profile(text, [{ targets }], COUNT_CAP);
    const names = operators.map((operator) => operator.name);
    expect(names.filter((name) => /NodeIndexSeek/.test(name)), names.join(' > ')).toHaveLength(properties.length);
    expect(names.some((name) => /NodeByLabelScan|AllNodesScan|NodeIndexScan/.test(name)), names.join(' > ')).toBe(false);
    expect(operators.filter((operator) => operator.name.startsWith('Limit')).every((operator) => operator.rows <= COUNT_CAP + 1)).toBe(true);
    expect(Object.values(row).every((count) => count <= COUNT_CAP + 1)).toBe(true);
    if (process.env['FACET_PROFILE_OUT'] !== undefined) writeFileSync(`${process.env['FACET_PROFILE_OUT']}-${text}-${properties.join('+')}.json`, JSON.stringify({ text, properties, row, seeks: operators.filter((operator) => /Seek/.test(operator.name)), limits: operators.filter((operator) => operator.name.startsWith('Limit')).map((operator) => operator.rows) }, null, 2));
  });

  it('seeks one index for each of the overlapping targets of the probes of one statement', async () => {
    const { operators } = await rig.profile('both', [...probes(['tag', 'ref']), ...probes(['tag']), ...probes(['ref'])], COUNT_CAP);
    expect(operators.filter((operator) => /NodeIndexSeek/.test(operator.name))).toHaveLength(4);
    expect(operators.filter((operator) => operator.name.startsWith('Limit')).every((operator) => operator.rows <= COUNT_CAP + 1)).toBe(true);
  });
});

describe(`a search whose reads fail, on ${NEO4J_SERIES}`, () => {
  it('fails with the exact group error when the schema read succeeds and every data read times out, and returns no group or facet', async () => {
    rig.onStatement((call) => (call.templateId === 'schema-indexes' ? undefined : { status: 'timeout' }));
    try {
      await expect(rig.search('tag24')).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    } finally {
      rig.onStatement(undefined);
    }
  });

  it('fails with the schema read timeout, and reads no data, when the schema read itself times out', async () => {
    const from = rig.statements.length;
    rig.onStatement((call) => (call.templateId === 'schema-indexes' ? { status: 'timeout' } : undefined));
    try {
      await expect(rig.search('tag24')).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
      expect(rig.statements.slice(from).filter((call) => call.templateId !== 'schema-indexes')).toEqual([]);
    } finally {
      rig.onStatement(undefined);
    }
  });

  it('refuses a text of 201 characters with INVALID_REQUEST and reads no data', async () => {
    const from = rig.statements.length;
    const error: unknown = await rig.search('x'.repeat(201)).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(rig.statements.slice(from).filter((call) => call.templateId !== 'schema-indexes')).toEqual([]);
  });
});
