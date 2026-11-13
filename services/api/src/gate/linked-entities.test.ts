import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { LINKED_RELATIONSHIPS, linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { z } from 'zod';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import { LINKED_ENTITIES_ID, linkedEntitiesTemplate } from './templates/linked-entities.js';

function rig(mapping = linkedMappingOf(), answer: (call: ExecuteCall) => ExecuteOutcome = () => ({ status: 'rows', rows: [] })) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor });
  const read = (params: unknown, limit = 25) => parts.gate.run(gateRequest({ sourceId: 'demo', templateId: LINKED_ENTITIES_ID, params, limit, indexes: { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) } }));
  return { ...parts, read, executor };
}

const params = { entityType: 'maker', stableId: 'A-1', targetType: 'maker', via: ['LINKS'], direction: 'out' };
const dataCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === LINKED_ENTITIES_ID);
const cypherOf = async (request: unknown, mapping = linkedMappingOf()): Promise<string> => {
  const { read, executor } = rig(mapping);
  await read(request);
  return dataCalls(executor)[0]?.cypher ?? '';
};

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await failureOf(promise);
  return error === undefined ? 'ok' : error instanceof AppError ? error.code : 'not an AppError';
};

describe('the statement of a one-hop linked-entities run', () => {
  it('is written from the mapping with quoted names and the bounds, and holds only the values as parameters', async () => {
    const { read, executor } = rig();
    await read(params, 10);
    const [call] = dataCalls(executor);
    expect(call?.cypher).toBe(
      [
        'MATCH (a:`Maker`) WHERE a.`makerId` IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1',
        'CALL { WITH a CALL { WITH a MATCH (a)-[r:`LINKS`]->(n:`Maker`) WHERE n <> a RETURN n, r, true AS isTarget } WITH n, r, isTarget LIMIT $countCap + 1 WITH collect({n: n, r: r, isTarget: isTarget}) AS found RETURN size(found) > $countCap AS cutFirst, found[..$countCap] AS nbs }',
        'WITH a, nbs, cutFirst, [] AS heavy, false AS stopListed, false AS cutSecond, [] AS second',
        'WITH a, cutFirst OR cutSecond AS bounded, heavy, stopListed, [e IN nbs WHERE e.isTarget | {x: e.n, hops: 1, m: null, r1: e.r, r2: null}] + [h IN second | {x: h.x, hops: 2, m: h.m, r1: [e IN nbs WHERE e.n = h.m][0].r, r2: h.r2}] AS entries',
        'CALL { WITH entries UNWIND entries AS entry WITH entry ORDER BY entry.hops WITH entry.x AS x, collect(entry)[0] AS best ORDER BY best.hops, x.`makerId` LIMIT $limit + 1 RETURN collect(best) AS ms }',
        'UNWIND CASE WHEN size(ms) = 0 THEN [null] ELSE ms END AS m',
        'RETURN a, bounded, heavy[..$limit] AS heavy, stopListed, m.x AS x, m.m AS mid, m.r1 AS r1, m.r2 AS r2, m.hops AS hops',
      ].join('\n'),
    );
    expect(call?.cypher).not.toContain('A-1');
    expect(call?.cypher).not.toMatch(/\[[^\]]*\*/);
    expect(call?.cypher).not.toMatch(/CREATE|MERGE|DELETE|SET |REMOVE/);
    expect(call?.parameters).toMatchObject({ stableId: 'A-1', limit: 10 });
    expect(call?.parameters).toHaveProperty('countCap');
    for (const name of ['entityType', 'targetType', 'via']) expect(call?.parameters).not.toHaveProperty(name);
    expect(call?.accessMode).toBe('READ');
  });

  it('pins each direction: out and in with the arrow, both without one', async () => {
    expect(await cypherOf({ ...params, direction: 'in', stableId: 'A-1' })).toContain('MATCH (a)<-[r:`LINKS`]-(n:`Maker`)');
    expect(await cypherOf({ ...params, direction: 'both' })).toContain('MATCH (a)-[r:`LINKS`]-(n:`Maker`)');
    expect(await cypherOf({ ...params, direction: 'out' })).toContain('MATCH (a)-[r:`LINKS`]->(n:`Maker`)');
  });

  it('reads the direction from the anchor when the request gives none: out for a from end, in for a to end', async () => {
    const withoutDirection = { ...params, direction: undefined };
    expect(await cypherOf(withoutDirection)).toContain('MATCH (a)-[r:`LINKS`]->(n:`Maker`)');
    const toEnd = { entityType: 'shop', stableId: 'S-1', targetType: 'tool', via: ['STOCKED_AT'] };
    expect(await cypherOf(toEnd)).toContain('MATCH (a)<-[r:`STOCKED_AT`]-(n:`Tool`)');
  });

  it('compares the mapped time property as an instant, to the hops whose type has one, only when a window is given', async () => {
    const cypher = await cypherOf({ ...params, windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' });
    expect(cypher).toContain('`seenAt` IS :: ZONED DATETIME');
    expect(cypher).toContain('>= datetime($windowFrom)');
    expect(cypher).toContain('< datetime($windowTo)');
    expect(cypher).not.toContain('2026');
    expect(await cypherOf(params)).not.toContain('datetime');
  });

  it('reads the aggregate members of a relationship type with no stable ID like any other relationship, as the normalizer treats them', async () => {
    const cypher = await cypherOf({ entityType: 'tool', stableId: 'T-1', targetType: 'shop', via: ['STOCKED_AT'], direction: 'out' });
    expect(cypher).toContain('MATCH (a)-[r:`STOCKED_AT`]->(n:`Shop`)');
  });
});

describe('a request value that looks like query text', () => {
  it('reaches the executor only as a parameter value, beside the statement the gate wrote, which is a READ', async () => {
    const text = 'x"}) MATCH (n) DETACH DELETE n //';
    const { read, executor } = rig();
    await read({ ...params, stableId: text });
    const call = dataCalls(executor)[0];
    expect(call?.cypher).not.toContain(text);
    expect(call?.cypher).not.toContain('DETACH');
    expect(call?.parameters).toMatchObject({ stableId: text });
    expect(call?.accessMode).toBe('READ');
  });
});

describe('a source that times out or a run that is cancelled', () => {
  it('fails with QUERY_TIMEOUT, answers no items and audits the run as failed', async () => {
    const mapping = linkedMappingOf();
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('the mapping has no source');
    const events: { action: string; result: string }[] = [];
    const executor = new TestExecutor(withOnlineIndexes(source, () => Promise.resolve<ExecuteOutcome>({ status: 'timeout' })));
    const seams = { ...communitySeams(), audit: { record: (event: { action: string; result: string }) => (events.push(event), Promise.resolve()) } };
    const parts = testSourceGate(mapping, { executor, seams });
    const failure = await failureOf(parts.gate.run(gateRequest({ sourceId: 'demo', templateId: LINKED_ENTITIES_ID, params, limit: 5, indexes: { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) } })));
    expect(failure).toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(events.filter((event) => event.action === 'entity.linked_entities_run').map((event) => event.result)).toEqual(['failed']);
  });
});

describe('the statement of a run whose neighbors no second step starts from', () => {
  it('reads no degrees and names no supernode, for two hops as for one', async () => {
    const cypher = await cypherOf({ entityType: 'maker', stableId: 'A-1', targetType: 'tool', via: ['USES_TOOL'], direction: 'out', maxHops: 2 });
    expect(cypher).toContain('WITH a, nbs, cutFirst, [] AS heavy, false AS stopListed, false AS cutSecond, [] AS second');
    expect(cypher).not.toContain('degree');
  });

  it('reads the degrees of the neighbors of the type a second step starts from, and of no other type', async () => {
    const cypher = await cypherOf({ entityType: 'maker', stableId: 'A-1', targetType: 'shop', via: ['USES_TOOL', 'STOCKED_AT'], direction: 'out', maxHops: 2 });
    expect(cypher).toContain('WITH DISTINCT e.n AS n WHERE n:`Tool` CALL');
  });
});

describe('the statement of a two-hop run', () => {
  const two = { ...params, maxHops: 2 };

  it('reads every neighbor, counts the relationships of each at the cap, expands the others and keeps each match at its lowest hop', async () => {
    const cypher = await cypherOf(two);
    expect(cypher).toContain('WITH a MATCH (a)-[r:`LINKS`]->(n:`Maker`) WHERE n <> a RETURN n, r, true AS isTarget');
    expect(cypher).toContain('CALL { WITH n MATCH (n)-[:`LINKS`]->() WITH 1 AS hit LIMIT $countCap + 1 RETURN count(*) AS c0 }');
    expect(cypher).toContain('collect(CASE WHEN degree > $countCap THEN n END) AS heavy, collect(CASE WHEN degree <= $countCap AND NOT stopped THEN n END) AS mids');
    expect(cypher).toContain('WITH a, n MATCH (n:`Maker`)-[r2:`LINKS`]->(x:`Maker`) WHERE x <> a RETURN x, r2');
    expect(cypher).toContain('WITH n, x, r2 LIMIT $countCap + 1');
    expect(cypher).toContain('ORDER BY best.hops, x.`makerId` LIMIT $limit + 1');
    expect(cypher).not.toMatch(/\[[^\]]*\*/);
  });

  it('chains two relationship types through an entity that is not the target, and pins both and either direction', async () => {
    const chained = { entityType: 'maker', stableId: 'A-1', targetType: 'shop', via: ['USES_TOOL', 'STOCKED_AT'], direction: 'out', maxHops: 2 };
    const cypher = await cypherOf(chained);
    expect(cypher).toContain('WITH a MATCH (a)-[r:`USES_TOOL`]->(n:`Tool`) WHERE n <> a RETURN n, r, false AS isTarget');
    expect(cypher).toContain('MATCH (n:`Tool`)-[r2:`STOCKED_AT`]->(x:`Shop`)');
    expect(cypher).toContain('c0 + c1 AS degree');
    const reversed = await cypherOf({ ...two, direction: 'in' });
    expect(reversed).toContain('MATCH (a)<-[r:`LINKS`]-(n:`Maker`)');
    expect(reversed).toContain('MATCH (n:`Maker`)<-[r2:`LINKS`]-(x:`Maker`)');
    const both = await cypherOf({ ...two, direction: 'both' });
    expect(both).toContain('MATCH (a)-[r:`LINKS`]-(n:`Maker`)');
    expect(both).toContain('MATCH (n:`Maker`)-[r2:`LINKS`]-(x:`Maker`)');
  });

  it('keeps a stop-listed entity from being traversed when a derived rule over the listed types names its type', async () => {
    const cypher = await cypherOf({ entityType: 'maker', stableId: 'A-1', targetType: 'maker', via: ['USES_TOOL'], direction: 'out', maxHops: 2 }).catch(() => '');
    expect(cypher).toBe('');
    const through = await cypherOf({ entityType: 'maker', stableId: 'A-1', targetType: 'shop', via: ['USES_TOOL', 'STOCKED_AT'], direction: 'out', maxHops: 2 });
    expect(through).toContain("(n:`Tool` AND coalesce(n.`isCommon`, false) = true) AS stopped");
    const plain = await cypherOf({ entityType: 'maker', stableId: 'A-1', targetType: 'shop', via: ['USES_TOOL', 'STOCKED_AT'], direction: 'out', maxHops: 2 }, linkedMappingOf({ derived: [] }));
    expect(plain).toContain('false AS stopped');
  });
});

describe('a request for a linked-entities run', () => {
  it.each([
    ['a target type the mapping does not have', { ...params, targetType: 'nothing' }],
    ['a relationship type the mapping does not have', { ...params, via: ['NOTHING'] }],
    ['an empty list of relationship types', { ...params, via: [] }],
    ['a relationship type given twice', { ...params, via: ['LINKS', 'LINKS'] }],
    ['a single name in place of the list', { ...params, via: 'LINKS' }],
    ['a target type that no listed relationship leads to from the anchor', { ...params, targetType: 'shop' }],
    ['an anchor type that is an end of no listed relationship type', { ...params, entityType: 'tool', via: ['LINKS'], direction: undefined }],
    ['listed relationship types whose stored directions at the anchor disagree and no direction', { ...params, targetType: 'shop', via: ['USES_TOOL', 'ENDORSES'], direction: undefined }],
    ['a direction that is not out, in or both', { ...params, direction: 'up' }],
    ['a value the schema does not name', { ...params, cypher: 'MATCH (n) RETURN n' }],
    ['a window with one instant', { ...params, windowFrom: '2026-01-01T00:00:00.000Z' }],
    ['a hop count of zero', { ...params, maxHops: 0 }],
    ['a hop count above what the mapping allows at all', { ...params, maxHops: 5 }],
    ['a hop count that is not a whole number', { ...params, maxHops: 1.5 }],
  ])('is refused with INVALID_REQUEST for %s, and nothing reaches the executor', async (_name, request) => {
    const { read, executor } = rig();
    expect(await codeOf(read(request))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toHaveLength(0);
  });

  it('is refused for a window when none of the relationship types of the run has a mapped time property', async () => {
    const { read, executor } = rig(linkedMappingOf({ relationships: [{ type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId' }, ...LINKED_RELATIONSHIPS.slice(1)] }));
    expect(await codeOf(read({ ...params, windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' }))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toHaveLength(0);
  });

  it('is refused for a limit above the max_page of the source', async () => {
    const { read } = rig();
    expect(await codeOf(read(params, 51))).toBe('QUERY_BUDGET_EXCEEDED');
  });

  it('is refused by the gate for three hops, carrying the cap of 2, and for two hops on a source whose max_hops is 1, carrying 1', async () => {
    const three = rig();
    expect(await failureOf(three.read({ ...params, maxHops: 3 }))).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 2 } });
    expect(dataCalls(three.executor)).toHaveLength(0);
    const one = rig(linkedMappingOf({ budgets: { max_hops: 1 } }));
    expect(await failureOf(one.read({ ...params, maxHops: 2 }))).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 1 } });
    expect(dataCalls(one.executor)).toHaveLength(0);
    expect(await codeOf(rig(linkedMappingOf({ budgets: { max_hops: 4 } })).read({ ...params, maxHops: 2 }))).toBe('ok');
  });

  it('takes one hop when the request names none', async () => {
    const { read, executor } = rig();
    await read({ ...params, maxHops: undefined });
    expect(dataCalls(executor)[0]?.cypher).toContain('WITH a, nbs, cutFirst, [] AS heavy');
  });
});

describe('the catalog entry of the linked-entities template', () => {
  it('is a version 1 read cut to a lower bound, with the audit action of the template and a hop declaration of 2', () => {
    expect(linkedEntitiesTemplate).toMatchObject({ id: 'linked-entities', version: '1', auditAction: 'entity.linked_entities_run', paged: false, cutMeans: 'lowerBound', hops: { param: 'maxHops', max: 2 } });
  });

  it('describes what it finds as reached from the anchor over the listed relationship types, not through shared attributes', () => {
    expect(linkedEntitiesTemplate.description).toContain('reached from the anchor over the listed relationship types');
    expect(linkedEntitiesTemplate.description).not.toContain('through shared attributes');
  });
});

describe('the catalog and the declaration of a linked-entities read', () => {
  const problem = (overrides: Partial<TemplateDefinition>): string | undefined => {
    try {
      createTemplateCatalog({ templates: [{ ...linkedEntitiesTemplate, ...overrides }] });
      return undefined;
    } catch (error) {
      return error instanceof CatalogError ? error.message : 'not a CatalogError';
    }
  };
  const schemaWith = (shape: Record<string, z.ZodType>) => z.strictObject({ entityType: z.string(), stableId: z.string(), targetType: z.string(), via: z.array(z.string()), ...shape });

  it('accepts the shipped declaration', () => {
    expect(problem({})).toBeUndefined();
  });

  it('refuses a statement that is not its one marker, and a marker without the declaration', () => {
    expect(problem({ cypher: 'MATCH (n) RETURN n' })).toContain('the template linked-entities');
    expect(problem({ linkedEntities: undefined })).toBe('the template linked-entities declares an entity marker its Cypher never uses');
  });

  it('refuses a declaration of parameters its schema does not have as text and as a list, or that are not declared as entity and relationship parameters', () => {
    expect(problem({ paramsSchema: schemaWith({}).extend({ via: z.string() }) })).toBe('the template linked-entities declares a linked entities read for parameters its schema does not have as text and as a list or its entity and relationship parameters do not declare');
    expect(problem({ entityParams: ['entityType'] })).toBe('the template linked-entities has an entity marker it does not declare');
    expect(problem({ relationshipParams: [] })).toBe('the template linked-entities has a relationship marker it does not declare');
  });

  it('refuses a schema that holds a limit, a paged or profiled template and a cut that is not a lower bound', () => {
    expect(problem({ paramsSchema: schemaWith({ limit: z.number() }) })).toBe('the template linked-entities declares the reserved parameter limit');
    expect(problem({ paged: true })).toBe('the template linked-entities is paged and declares rows or cutMeans');
    expect(problem({ profile: true })).toBe('the template linked-entities is profiled and its Cypher does not start with PROFILE');
    expect(problem({ cutMeans: 'duplicate' })).toContain("declares a linked entities read and is also another kind of template");
  });

  it('refuses a read that names no indexes, no used properties or no reference for its anchor', () => {
    expect(problem({ indexNeeds: undefined })).toContain('does not name its indexes');
    expect(problem({ usedProperties: undefined })).toContain('does not name its indexes');
    expect(problem({ referenceParams: undefined })).toContain('does not name its indexes');
  });
});
