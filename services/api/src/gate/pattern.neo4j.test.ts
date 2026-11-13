import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedPattern } from './normalize/pattern.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { PATTERN_ID } from './templates/pattern.js';

let server: RunningNeo4j;
let parts: SourceGate;
let small: SourceGate;

const entities = [
  { type: 'maker', label: 'PMaker', stable_id: 'makerId', filterable: ['region'] },
  { type: 'tool', label: 'PTool', stable_id: 'toolId' },
  { type: 'dup', label: 'PDup', stable_id: 'dupId' },
];
const relationships = [
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt', filterable: ['lane'] },
  { type: 'USES', from: 'maker', to: 'tool', stable_id: 'useId' },
  { type: 'HAS', from: 'maker', to: 'dup', stable_id: 'hasId' },
  { type: 'ALSO', from: 'maker', to: 'maker' },
];
const derived = [{ id: 'shared-tool', from: 'maker', to: 'maker', via: ['USES', 'tool', 'USES'], rule_version: 1, stop_list_property: 'isCommon' }];
const SMALL_CAP = { heavy_op_threshold: 3 };

let edges = 0;
const link = (from: string, to: string, props = ''): string => `MATCH (a:PMaker {makerId: '${from}'}), (b:PMaker {makerId: '${to}'}) CREATE (a)-[:LINKS {linkId: 'l${(edges += 1)}'${props === '' ? '' : `, ${props}`}}]->(b)`;
const uses = (maker: string, tool: string): string => `MATCH (a:PMaker {makerId: '${maker}'}), (t:PTool {toolId: '${tool}'}) CREATE (a)-[:USES {useId: 'u${(edges += 1)}'}]->(t)`;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT p_maker FOR (n:PMaker) REQUIRE n.makerId IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT p_tool FOR (n:PTool) REQUIRE n.toolId IS UNIQUE');
  const makers = ['a0', 'b1', 'b2', 'c1', 'x9', 'a1', 'hubmid', 'd1', 'e1', 'z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'w0', 'w1', 'w2', 'w3', 'f0', 'f1', 'f2', 'f3', 'f4', 'm1', 'm2', 'm3', 'm4', 'm5'];
  await runAdmin(server, `UNWIND [${makers.map((id) => `'${id}'`).join(',')}] AS id CREATE (:PMaker {makerId: id})`);
  await runAdmin(server, "MATCH (m:PMaker) WHERE m.makerId IN ['b1', 'w1'] SET m.region = 'north'");
  await runAdmin(server, "MATCH (m:PMaker) WHERE m.makerId IN ['b2', 'w2'] SET m.region = 'south'");
  await runAdmin(server, "UNWIND ['t1', 't2'] AS id CREATE (:PTool {toolId: id, isCommon: id = 't2'})");
  await runAdmin(server, link('a0', 'b1', "lane: 'web'"));
  await runAdmin(server, link('a0', 'b2', "lane: 'mail'"));
  for (const [from, to] of [['b1', 'c1'], ['b2', 'c1'], ['b1', 'b2'], ['x9', 'a0'], ['a1', 'hubmid'], ['a1', 'd1'], ['d1', 'e1'], ['f0', 'f1'], ['f0', 'f2'], ['f0', 'f3'], ['f0', 'f4']] as const) await runAdmin(server, link(from, to));
  for (const id of ['z1', 'z2', 'z3', 'z4', 'z5', 'z6']) await runAdmin(server, link('hubmid', id));
  await runAdmin(server, link('w0', 'w1', "seenAt: datetime('2026-01-10T00:00:00Z')"));
  await runAdmin(server, link('w0', 'w2', "seenAt: datetime('2026-03-01T00:00:00Z')"));
  await runAdmin(server, link('w0', 'w3'));
  for (const [maker, tool] of [['m1', 't1'], ['m2', 't1'], ['m3', 't1'], ['m4', 't2'], ['m5', 't2']] as const) await runAdmin(server, uses(maker, tool));
  const pages = ['pg', 'pg-01', 'pg-02', 'pg-03', 'pg-04', 'pg-05', 'pg-06', 'pg-07', 'pgt', 'pgd'];
  await runAdmin(server, `UNWIND [${pages.map((id) => `'${id}'`).join(',')}] AS id CREATE (:PMaker {makerId: id})`);
  for (const id of ['pg-04', 'pg-01', 'pg-07', 'pg-03', 'pg-06', 'pg-02', 'pg-05']) await runAdmin(server, link('pg', id));
  await runAdmin(server, "UNWIND ['pga'] AS id CREATE (:PMaker {makerId: id})");
  for (const id of ['pg-05', 'pg-02', 'pg-04', 'pg-01', 'pg-03']) await runAdmin(server, `MATCH (a:PMaker {makerId: 'pga'}), (b:PMaker {makerId: '${id}'}) CREATE (a)-[:ALSO]->(b), (a)-[:ALSO]->(b)`);
  await runAdmin(server, 'UNWIND [10, 2, 33, 9] AS id CREATE (:PTool {toolId: id})');
  await runAdmin(server, "MATCH (m:PMaker {makerId: 'pgt'}), (t:PTool) WHERE t.toolId IN [10, 2, 33, 9] CREATE (m)-[:USES {useId: 'pgu' + toString(t.toolId)}]->(t)");
  await runAdmin(server, "MATCH (m:PMaker {makerId: 'pgd'}) UNWIND ['x', 'y'] AS tag CREATE (m)-[:HAS {hasId: 'h' + tag}]->(:PDup {dupId: 'same'})");
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  const open = (budgets: Record<string, number>): SourceGate => createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, derived, budgets })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
  parts = open({});
  small = open(SMALL_CAP);
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => small?.close(), () => server?.stop()]);
});

const hop = (over: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...over });
const TOOL = hop({ relationshipTypes: ['USES'], arrivesAt: 'tool' });
const BACK = hop({ relationshipTypes: ['USES'], direction: 'in' });

async function run(stableId: string, steps: Record<string, unknown>[], limit = 25, gate: SourceGate = parts, cursor?: string) {
  const page = await gate.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_ID, params: { anchorType: 'maker', stableId, steps }, limit, ...(cursor === undefined ? {} : { cursor }) }));
  const [item] = page.items;
  if (!isNormalizedPattern(item)) throw new Error('the read gave no pattern result');
  return { page, item, ids: item.matches.map((entry) => entry.match.stableId) };
}

const WINDOW = { windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' };

describe(`the pattern run on ${NEO4J_SERIES}`, () => {
  it('finds the entities one step reaches over the listed types in the stated direction, never the anchor', async () => {
    expect((await run('a0', [hop()])).ids).toEqual(['b1', 'b2']);
    expect((await run('a0', [hop({ direction: 'in' })])).ids).toEqual(['x9']);
    expect((await run('a0', [hop({ direction: 'both' })])).ids).toEqual(['b1', 'b2', 'x9']);
  });

  it('finds, in two steps, the entities of the second step with the entity between, and never the anchor or the entity between', async () => {
    const { item, ids } = await run('m1', [TOOL, BACK]);
    expect(ids).toEqual(['m2', 'm3']);
    expect(item.matches.map((entry) => entry.through.map((ref) => ref?.stableId))).toEqual([['t1'], ['t1']]);
    expect(item.matches.every((entry) => entry.hops === 2)).toBe(true);
  });

  it('shows one path to a match reached by two: the one that orders first by the stable IDs between', async () => {
    const { item, ids } = await run('a0', [hop(), hop()]);
    expect(ids).toEqual(['b2', 'c1']);
    expect(item.matches.find((entry) => entry.match.stableId === 'c1')?.through.map((ref) => ref?.stableId)).toEqual(['b1']);
  });

  it('keeps the entities that meet a condition on the node and on the relationship', async () => {
    expect((await run('a0', [hop({ conditions: [{ on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'north' } }] })])).ids).toEqual(['b1']);
    expect((await run('a0', [hop({ conditions: [{ on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'web' } }] })])).ids).toEqual(['b1']);
    expect((await run('a0', [hop({ conditions: [{ on: 'neighbor', property: 'region', op: 'in', values: [{ kind: 'text', value: 'north' }, { kind: 'text', value: 'south' }] }] })])).ids).toEqual(['b1', 'b2']);
  });

  it('keeps the relationships in a window, leaves out those with no time, and reads a type with no time property unwindowed', async () => {
    expect((await run('w0', [hop({ ...WINDOW })])).ids).toEqual(['w1']);
    expect((await run('w0', [hop()])).ids).toEqual(['w1', 'w2', 'w3']);
    expect((await run('m1', [hop({ relationshipTypes: ['USES'], arrivesAt: 'tool', ...WINDOW })])).ids).toEqual(['t1']);
  });

  it('answers the anchor with no match when nothing matches, and finds no anchor for a stable ID that is not there', async () => {
    const none = await run('e1', [hop()]);
    expect(none.ids).toEqual([]);
    expect(none.item.anchorFound).toBe(true);
    expect((await run('nobody', [hop()])).item.anchorFound).toBe(false);
  });

  it('reads at most the count cap plus one at a step: a step with more neighbors is a lower bound', async () => {
    const { item, ids } = await run('f0', [hop()], 25, small);
    expect(item.bounded).toBe(true);
    expect(ids).toHaveLength(3);
  });

  it('does not traverse an entity with more relationships than the count cap, and says so', async () => {
    const { item, ids } = await run('a1', [hop(), hop()], 25, small);
    expect(ids).toEqual(['e1']);
    expect(item.supernodes.map((ref) => ref.stableId)).toEqual(['hubmid']);
    expect(item.bounded).toBe(false);
  });

  it('does not traverse an entity on a stop-list, and says so', async () => {
    const { item, ids } = await run('m4', [TOOL, BACK]);
    expect(ids).toEqual([]);
    expect(item.stopListed).toBe(true);
  });

  it('cuts the matches at the limit plus one', async () => {
    const { page, ids } = await run('hubmid', [hop()], 2);
    expect(ids).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  const HAS = hop({ relationshipTypes: ['HAS'], arrivesAt: 'dup' });

  async function pagesOf(stableId: string, steps: Record<string, unknown>[], limit: number, gate: SourceGate = parts): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 10; round += 1) {
      const { page, ids } = await run(stableId, steps, limit, gate, cursor);
      pages.push(ids.map(String));
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    return pages;
  }

  it('reads the matches in pages by the end entity: no repeat and no skip, the last page without a cursor', async () => {
    const pages = await pagesOf('pg', [hop()], 3);
    expect(pages).toEqual([['pg-01', 'pg-02', 'pg-03'], ['pg-04', 'pg-05', 'pg-06'], ['pg-07']]);
    expect((await run('pg', [hop()], 7)).page.nextCursor).toBeUndefined();
  });

  it('pages the matches of a step whose relationships have no stable ID of their own, whose members are read after the order is set', async () => {
    const ALSO = hop({ relationshipTypes: ['ALSO'] });
    expect(await pagesOf('pga', [ALSO], 2)).toEqual([['pg-01', 'pg-02'], ['pg-03', 'pg-04'], ['pg-05']]);
  });

  it('orders the end IDs as text whatever their type, so an integer ID and a string ID page in one order', async () => {
    expect(await pagesOf('pgt', [TOOL], 2)).toEqual([['10', '2'], ['33', '9']]);
  });

  it('pages entities that share a stable ID by their element IDs, so none is repeated or skipped', async () => {
    expect(await pagesOf('pgd', [HAS], 1)).toEqual([['same'], ['same']]);
  });

  it('pages inside a run that was cut: the pages are the cut set and never more', async () => {
    const pages = await pagesOf('f0', [hop()], 2, small);
    expect(pages.flat()).toHaveLength(3);
    expect(new Set(pages.flat()).size).toBe(3);
  });
});
