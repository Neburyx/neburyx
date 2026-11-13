import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedLinked } from './normalize/linked-entities.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { LINKED_ENTITIES_ID } from './templates/linked-entities.js';

let server: RunningNeo4j;
let parts: SourceGate;
let small: SourceGate;

const entities = [{ type: 'maker', label: 'LMaker', stable_id: 'makerId' }];
const relationships = [{ type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt' }];
const SMALL_CAP = { heavy_op_threshold: 3 };

let edges = 0;
const link = (from: string, to: string, seenAt = ''): string => `MATCH (a:LMaker {makerId: '${from}'}), (b:LMaker {makerId: '${to}'}) CREATE (a)-[:LINKS {linkId: 'l${(edges += 1)}'${seenAt === '' ? '' : `, seenAt: ${seenAt}`}}]->(b)`;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT l_maker FOR (n:LMaker) REQUIRE n.makerId IS UNIQUE');
  const makers = ['a0', 'b1', 'b2', 'c1', 'x9', 'a1', 'hubmid', 'd1', 'e1', 'z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'w0', 'w1', 'w2', 'w3', 'lonely', 'f0', 'f1', 'f2', 'f3', 'f4', 'self'];
  await runAdmin(server, `UNWIND [${makers.map((id) => `'${id}'`).join(',')}] AS id CREATE (:LMaker {makerId: id})`);
  for (const [from, to] of [['a0', 'b1'], ['a0', 'b2'], ['b1', 'c1'], ['b2', 'c1'], ['b1', 'b2'], ['x9', 'a0'], ['a1', 'hubmid'], ['a1', 'd1'], ['d1', 'e1'], ['f0', 'f1'], ['f0', 'f2'], ['f0', 'f3'], ['f0', 'f4'], ['self', 'self']] as const) await runAdmin(server, link(from, to));
  for (const id of ['z1', 'z2', 'z3', 'z4', 'z5', 'z6']) await runAdmin(server, link('hubmid', id));
  await runAdmin(server, link('w0', 'w1', "datetime('2026-01-10T00:00:00Z')"));
  await runAdmin(server, link('w0', 'w2', "datetime('2026-03-01T00:00:00Z')"));
  await runAdmin(server, link('w0', 'w3'));
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  const open = (budgets: Record<string, number>): SourceGate => createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, budgets })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
  parts = open({});
  small = open(SMALL_CAP);
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => small?.close(), () => server?.stop()]);
});

async function run(stableId: string, extra: Record<string, unknown> = {}, limit = 25, gate: SourceGate = parts) {
  const page = await gate.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: LINKED_ENTITIES_ID, params: { entityType: 'maker', stableId, targetType: 'maker', via: ['LINKS'], direction: 'out', ...extra }, limit }));
  const [item] = page.items;
  if (!isNormalizedLinked(item)) throw new Error('the read gave no linked-entities result');
  return { page, item, ids: item.matches.map((entry) => entry.match.stableId), hopsOf: Object.fromEntries(item.matches.map((entry) => [entry.match.stableId, entry.hops])) };
}

const WINDOW = { windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' };

describe(`the linked-entities run on ${NEO4J_SERIES}`, () => {
  it('finds the entities one hop away in the stored direction, never the anchor', async () => {
    const { ids, item, hopsOf } = await run('a0');
    expect(ids).toEqual(['b1', 'b2']);
    expect(hopsOf).toEqual({ b1: 1, b2: 1 });
    expect(item.anchorFound).toBe(true);
    expect(item.bounded).toBe(false);
    expect(item.edges.filter((edge) => edge.type === 'LINKS')).toHaveLength(2);
  });

  it('finds the entities that point at the anchor for in, and both directions for both', async () => {
    expect((await run('a0', { direction: 'in' })).ids).toEqual(['x9']);
    expect((await run('a0', { direction: 'both' })).ids).toEqual(['b1', 'b2', 'x9']);
  });

  it('reads the stored direction from the anchor when the request names none', async () => {
    expect((await run('a0', { direction: undefined })).ids).toEqual(['b1', 'b2']);
  });

  it('does not return an entity that links to itself as its own match', async () => {
    expect((await run('self')).ids).toEqual([]);
  });

  it('reaches two hops, with the entity in between, an entity reachable at both once at hop 1, and one-hop matches first', async () => {
    const { ids, hopsOf, item } = await run('a0', { maxHops: 2 });
    expect(ids).toEqual(['b1', 'b2', 'c1']);
    expect(hopsOf).toEqual({ b1: 1, b2: 1, c1: 2 });
    const reached = item.matches.find((entry) => entry.match.stableId === 'c1');
    expect(['b1', 'b2']).toContain(reached?.through?.stableId);
    expect(item.matches.find((entry) => entry.match.stableId === 'b2')?.through).toBeUndefined();
  });

  it('answers a match at two hops in the reverse direction too', async () => {
    expect((await run('c1', { maxHops: 2, direction: 'in' })).ids).toEqual(['b1', 'b2', 'a0']);
  });

  it('does not traverse a supernode, names it, and says the count is bounded', async () => {
    const { ids, item } = await run('a1', { maxHops: 2 }, 25, small);
    expect(ids).toEqual(['d1', 'hubmid', 'e1']);
    expect(item.supernodes.map((ref) => ref.stableId)).toEqual(['hubmid']);
    expect(ids).not.toContain('z1');
    const open = await run('a1', { maxHops: 2 });
    expect(open.ids).toEqual(['d1', 'hubmid', 'e1', 'z1', 'z2', 'z3', 'z4', 'z5', 'z6']);
    expect(open.item.supernodes).toEqual([]);
  });

  it('says a bound was hit when the anchor has more neighbors than the count cap', async () => {
    const { item, ids } = await run('f0', {}, 25, small);
    expect(item.bounded).toBe(true);
    expect(ids.length).toBeLessThanOrEqual(3);
  });

  it('cuts the matches at the limit and says there are more', async () => {
    const { page } = await run('a0', {}, 1);
    expect(page.hasMore).toBe(true);
    expect(page.items).toHaveLength(1);
  });

  it('takes a window as instants and leaves out an edge with no time', async () => {
    expect((await run('w0', WINDOW)).ids).toEqual(['w1']);
    expect((await run('w0')).ids).toEqual(['w1', 'w2', 'w3']);
  });

  it('answers one row with no match for an entity that has none, and no row for one that does not exist', async () => {
    const lonely = await run('lonely');
    expect(lonely.ids).toEqual([]);
    expect(lonely.item.anchorFound).toBe(true);
    expect((await run('nobody')).item.anchorFound).toBe(false);
  });
});
