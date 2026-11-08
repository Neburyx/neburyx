import type { ExpandFilter, ExpandRank, FilterValue } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import type { ExpansionPage } from './normalize/expansion.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { EXPAND_COUNT_ID } from './templates/expand-count.js';
import { EXPAND_NEIGHBORS_ID } from './templates/expand-neighbors.js';

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'hub', label: 'FHub', stable_id: 'hubId' },
  { type: 'leaf', label: 'FLeaf', stable_id: 'leafId', filterable: ['band', 'size', 'born'], sortable: ['size'] },
];
const relationships = [
  { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt', filterable: ['score'], sortable: ['score'] },
  { type: 'NOTED', from: 'hub', to: 'leaf', observed_at: 'seenAt', filterable: ['score'], sortable: ['score'] },
];

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT f_hub FOR (n:FHub) REQUIRE n.hubId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX f_leaf FOR (n:FLeaf) ON (n.leafId)');
  // leaves a1..a8 differ in the kind of their `band`, `size` and `born`, so that a stored value of another kind can be seen not to match
  await runAdmin(
    server,
    `CREATE (h:FHub {hubId: 'h1'})
     CREATE (h)-[:LINKED {relId: 'r1', seenAt: datetime('2026-03-05T10:00:00Z'), score: 0.9}]->(:FLeaf {leafId: 'a1', band: 'high', size: 10, born: datetime('2020-03-01T00:00:00Z')})
     CREATE (h)-[:LINKED {relId: 'r2', seenAt: datetime('2026-03-20T10:00:00Z'), score: 0.5}]->(:FLeaf {leafId: 'a2', band: 'low', size: 20.5, born: datetime('2021-05-01T00:00:00Z')})
     CREATE (h)-[:LINKED {relId: 'r3', seenAt: datetime('2026-04-02T10:00:00Z'), score: 0.8}]->(:FLeaf {leafId: 'a3', band: 'high', size: 30, born: '2020-03-01T00:00:00Z'})
     CREATE (h)-[:LINKED {relId: 'r4', score: 'high'}]->(:FLeaf {leafId: 'a4', band: 3, size: '30', born: date('2020-03-01')})
     CREATE (h)-[:LINKED {relId: 'r5', seenAt: datetime('2026-03-31T23:59:59Z'), score: 0.95}]->(:FLeaf {leafId: 'a5', size: 40, born: datetime('2022-01-01T00:00:00Z')})
     CREATE (h)-[:NOTED {seenAt: datetime('2026-03-10T00:00:00Z'), score: 0.9}]->(l6:FLeaf {leafId: 'a6', band: 'high', size: 5})
     CREATE (h)-[:NOTED {seenAt: datetime('2026-03-11T00:00:00Z'), score: 0.1}]->(l6)
     CREATE (h)-[:NOTED {seenAt: datetime('2026-03-12T00:00:00Z'), score: 0.95}]->(l6)
     CREATE (h)-[:NOTED {score: 0.2}]->(:FLeaf {leafId: 'a7', band: 'low', size: 7})`,
  );
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

async function page(filters: readonly ExpandFilter[] | undefined, limit: number, cursor?: string, relTypes?: readonly string[], rank?: ExpandRank) {
  const result = await parts.gate.run(
    gateRequest({
      sourceId: 'graph',
      principal: LOCAL_PRINCIPAL,
      templateId: EXPAND_NEIGHBORS_ID,
      params: { entityType: 'hub', stableId: 'h1', neighborType: 'leaf', direction: 'out', sort: 'observed', ...(relTypes === undefined ? {} : { relTypes }), ...(filters === undefined ? {} : { filters }), ...(rank === undefined ? {} : { rank }) },
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const [item] = result.items;
  return { ...result, item: item as unknown as ExpansionPage };
}

/** The leaves a chain of pages reaches, in order, for a page size; every page is asked with the cursor of the one before. */
async function chain(filters: readonly ExpandFilter[] | undefined, limit: number, relTypes?: readonly string[], rank?: ExpandRank) {
  const edges: ExpansionPage['edges'] = [];
  let cursor: string | undefined;
  do {
    const next = await page(filters, limit, cursor, relTypes, rank);
    edges.push(...next.item.edges);
    cursor = next.nextCursor;
  } while (cursor !== undefined);
  return edges;
}

const leavesOf = (edges: ExpansionPage['edges']): string[] => [...new Set(edges.map((edge) => edge.to.stableId))].sort();
const text = (value: string) => ({ kind: 'text' as const, value });
const number = (value: number) => ({ kind: 'number' as const, value });
const eq = (on: 'neighbor' | 'relationship', property: string, value: FilterValue): ExpandFilter => ({ on, property, op: 'eq', value });

describe(`the filtered expansion read on ${NEO4J_SERIES}`, () => {
  it('without a filter reads every relationship, which is what the filters narrow', async () => {
    expect(leavesOf(await chain(undefined, 50))).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
  });

  it('matches a text equal only to a stored text: a number or a missing property is not a match and is not an error', async () => {
    expect(leavesOf(await chain([eq('neighbor', 'band', text('high'))], 50))).toEqual(['a1', 'a3', 'a6']);
    expect(leavesOf(await chain([eq('neighbor', 'band', text('3'))], 50))).toEqual([]);
  });

  it('matches one of a set of numbers, integer or float, and not a text that looks like a number', async () => {
    const filters: ExpandFilter[] = [{ on: 'neighbor', property: 'size', op: 'in', values: [number(10), number(20.5), number(30)] }];
    expect(leavesOf(await chain(filters, 50))).toEqual(['a1', 'a2', 'a3']);
  });

  it('matches a range inclusively, with either end left open, and only over stored numbers', async () => {
    const between = (from?: number, to?: number): ExpandFilter => ({ on: 'neighbor', property: 'size', op: 'between', ...(from === undefined ? {} : { from: number(from) }), ...(to === undefined ? {} : { to: number(to) }) });
    expect(leavesOf(await chain([between(10, 30)], 50))).toEqual(['a1', 'a2', 'a3']);
    expect(leavesOf(await chain([between(30)], 50))).toEqual(['a3', 'a5']);
    expect(leavesOf(await chain([between(undefined, 7)], 50))).toEqual(['a6', 'a7']);
  });

  it('compares times only with a stored time of the same kind: a text, a date or a local time that looks alike is left out', async () => {
    const born: ExpandFilter = { on: 'neighbor', property: 'born', op: 'between', from: { kind: 'dateTime', value: '2020-01-01T00:00:00Z' }, to: { kind: 'dateTime', value: '2021-12-31T23:59:59Z' } };
    expect(leavesOf(await chain([born], 50))).toEqual(['a1', 'a2']);
    expect(leavesOf(await chain([{ on: 'neighbor', property: 'born', op: 'eq', value: { kind: 'date', value: '2020-03-01' } }], 50))).toEqual(['a4']);
  });

  it('filters on the relationship: the window of the observed time, a score at least, and a row with no time is not in a window', async () => {
    const march: ExpandFilter = { on: 'relationship', property: 'seenAt', op: 'between', from: { kind: 'dateTime', value: '2026-03-01T00:00:00Z' }, to: { kind: 'dateTime', value: '2026-03-31T23:59:59Z' } };
    expect(leavesOf(await chain([march], 50))).toEqual(['a1', 'a2', 'a5', 'a6']);
    expect(leavesOf(await chain([{ on: 'relationship', property: 'score', op: 'between', from: number(0.8) }], 50, ['LINKED']))).toEqual(['a1', 'a3', 'a5']);
  });

  it('counts only the matching members of an aggregate, and gives the span of the matching ones', async () => {
    const edges = await chain([{ on: 'relationship', property: 'score', op: 'between', from: number(0.9) }], 50, ['NOTED']);
    const aggregate = edges.find((edge) => edge.to.stableId === 'a6' && 'aggregate' in edge.ref);
    expect(aggregate).toMatchObject({ memberCount: { value: 2, quality: 'exact' }, observedFirst: '2026-03-10T00:00:00Z', observedLast: '2026-03-12T00:00:00Z' });
  });

  it('keeps an aggregate in or out whole when the filter is on its neighbor', async () => {
    const edges = await chain([eq('neighbor', 'band', text('high'))], 50, ['NOTED']);
    const aggregate = edges.find((edge) => edge.to.stableId === 'a6' && 'aggregate' in edge.ref);
    expect(aggregate).toMatchObject({ memberCount: { value: 3, quality: 'exact' } });
  });

  it('pages inside the filter: any page size reaches the same rows once, in the same order', async () => {
    const filters: ExpandFilter[] = [{ on: 'relationship', property: 'score', op: 'between', from: number(0.5) }];
    const whole = (await chain(filters, 50)).map((edge) => JSON.stringify([edge.type, edge.ref]));
    expect(whole.length).toBeGreaterThan(4);
    for (const size of [1, 2, 3]) expect((await chain(filters, size)).map((edge) => JSON.stringify([edge.type, edge.ref]))).toEqual(whole);
  });

  it('leaves nothing, honestly, when no row matches: an empty page without a next page', async () => {
    const result = await page([eq('neighbor', 'band', text('nothing like it'))], 10);
    expect(result.item.edges).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  describe('ranked by a declared property', () => {
    const key = (edge: ExpansionPage['edges'][number]) => ('stableId' in edge.ref ? `${edge.type}:${edge.ref.stableId}` : `${edge.type}:@${edge.to.stableId}`);
    const byScore = (order: 'asc' | 'desc'): ExpandRank => ({ on: 'relationship', property: 'score', order });
    const bySize = (order: 'asc' | 'desc'): ExpandRank => ({ on: 'neighbor', property: 'size', order });
    const keys = async (rank: ExpandRank, limit = 50, filters?: readonly ExpandFilter[]) => (await chain(filters, limit, undefined, rank)).map(key);

    it('puts the largest first, numbers before text, stored rows before aggregates, and orders an aggregate by the largest of its members', async () => {
      expect(await keys(byScore('desc'))).toEqual(['LINKED:r5', 'LINKED:r1', 'LINKED:r3', 'LINKED:r2', 'LINKED:r4', 'NOTED:@a6', 'NOTED:@a7']);
    });

    it('puts the smallest first when ascending, and orders an aggregate by the smallest of its members', async () => {
      expect(await keys(byScore('asc'))).toEqual(['LINKED:r2', 'LINKED:r3', 'LINKED:r1', 'LINKED:r5', 'LINKED:r4', 'NOTED:@a6', 'NOTED:@a7']);
    });

    it('ranks by a property of the neighbor, an integer and a float together, text after them, and a neighbor with no value last', async () => {
      expect(await keys(bySize('desc'))).toEqual(['LINKED:r5', 'LINKED:r3', 'LINKED:r2', 'LINKED:r1', 'LINKED:r4', 'NOTED:@a7', 'NOTED:@a6']);
      expect(await keys(bySize('asc'))).toEqual(['LINKED:r1', 'LINKED:r2', 'LINKED:r3', 'LINKED:r5', 'LINKED:r4', 'NOTED:@a6', 'NOTED:@a7']);
    });

    it('reaches every row once, in the same order, whatever the page size, in both orders', async () => {
      for (const rank of [byScore('desc'), byScore('asc'), bySize('desc'), bySize('asc')]) {
        const whole = await keys(rank);
        for (const size of [1, 2, 3]) expect(await keys(rank, size)).toEqual(whole);
        expect(new Set(whole).size).toBe(whole.length);
      }
    });

    it('does not change the observed times an aggregate reports', async () => {
      const edges = await chain(undefined, 50, ['NOTED'], byScore('asc'));
      const aggregate = edges.find((edge) => edge.to.stableId === 'a6' && 'aggregate' in edge.ref);
      expect(aggregate).toMatchObject({ memberCount: { value: 3, quality: 'exact' }, observedFirst: '2026-03-10T00:00:00Z', observedLast: '2026-03-12T00:00:00Z' });
    });

    it('pages inside a filter, in the rank order', async () => {
      const filters: ExpandFilter[] = [{ on: 'neighbor', property: 'size', op: 'between', from: number(10) }];
      const whole = await keys(bySize('desc'), 50, filters);
      expect(whole).toEqual(['LINKED:r5', 'LINKED:r3', 'LINKED:r2', 'LINKED:r1']);
      expect(await keys(bySize('desc'), 1, filters)).toEqual(whole);
    });
  });

  describe('the count of what a filter matches', () => {
    const count = async (filters: readonly ExpandFilter[], relTypes?: readonly string[]) => {
      const result = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: EXPAND_COUNT_ID, params: { entityType: 'hub', stableId: 'h1', neighborType: 'leaf', direction: 'out', ...(relTypes === undefined ? {} : { relTypes }), filters }, limit: 1 }));
      return (result.items[0] as { total: number }).total;
    };
    /** The relationships a chain of pages stands for: one for a stored relationship, the members of an aggregate. */
    const relationshipsOf = (edges: ExpansionPage['edges']) => edges.reduce((sum, edge) => sum + (edge.memberCount?.value ?? 1), 0);

    it.each([
      ['a neighbor text', [eq('neighbor', 'band', text('high'))], undefined, 5],
      ['a score at least, over both relationship types', [{ on: 'relationship', property: 'score', op: 'between', from: number(0.8) } as ExpandFilter], undefined, 5],
      ['a score at least, over one relationship type', [{ on: 'relationship', property: 'score', op: 'between', from: number(0.8) } as ExpandFilter], ['NOTED'], 2],
      ['a number between, over the neighbors', [{ on: 'neighbor', property: 'size', op: 'between', from: number(10), to: number(30) } as ExpandFilter], ['LINKED'], 3],
    ])('is exact for %s, and the number the pages add up to', async (_name, filters, relTypes, expected) => {
      expect(await count(filters, relTypes)).toBe(expected);
      expect(relationshipsOf(await chain(filters, 2, relTypes))).toBe(expected);
    });

    it('is zero, exactly, when nothing matches', async () => {
      expect(await count([eq('neighbor', 'band', text('nothing like it'))])).toBe(0);
    });
  });
});
