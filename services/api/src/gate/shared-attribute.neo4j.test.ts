import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedShared } from './normalize/shared-attribute.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { SHARED_ATTRIBUTE_ID } from './templates/shared-attribute.js';

let server: RunningNeo4j;
let parts: SourceGate;
let small: SourceGate;

const entities = [
  { type: 'maker', label: 'XMaker', stable_id: 'makerId' },
  { type: 'tool', label: 'XTool', stable_id: 'toolId' },
];
const relationships = [{ type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId', observed_at: 'seenAt' }];
const derived = [{ id: 'shared-tool', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 1, stop_list_property: 'isCommon' }];
const SMALL_CAP = { heavy_op_threshold: 3 };

const link = (maker: string, tool: string, id: string, seenAt = ''): string => `MATCH (m:XMaker {makerId: '${maker}'}), (t:XTool {toolId: '${tool}'}) CREATE (m)-[:USES_TOOL {useId: '${id}'${seenAt === '' ? '' : `, seenAt: ${seenAt}`}}]->(t)`;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT x_maker FOR (n:XMaker) REQUIRE n.makerId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX x_tool FOR (n:XTool) ON (n.toolId)');
  const makers = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'h1', 'm0', 'm2', 'm3', 'p0', 'pp', 'e0', 'e9', 'h0', 'g0', 'w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'lonely'];
  await runAdmin(server, `UNWIND [${makers.map((id) => `'${id}'`).join(',')}] AS id CREATE (:XMaker {makerId: id})`);
  await runAdmin(server, `UNWIND range(1, 12) AS i CREATE (:XMaker {makerId: 'big' + toString(i)})`);
  const tools = ['dev', 'p1', 'p2', 'p3', 'ptool', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'o1', 'o2', 'o3', 'o4', 'o5', 'bigtool', 'wt'];
  await runAdmin(server, `UNWIND [${tools.map((id) => `'${id}'`).join(',')}] AS id CREATE (:XTool {toolId: id})`);
  await runAdmin(server, "CREATE (:XTool {toolId: 'hub', isCommon: true})");
  for (const maker of ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']) await runAdmin(server, link(maker, 'dev', `${maker}-dev`));
  await runAdmin(server, link('r0', 'hub', 'r0-hub'));
  await runAdmin(server, link('h1', 'hub', 'h1-hub'));
  for (const tool of ['p1', 'p2', 'p3']) await runAdmin(server, link('m0', tool, `m0-${tool}`));
  for (const tool of ['p1', 'p2']) await runAdmin(server, link('m2', tool, `m2-${tool}`));
  for (const tool of ['p1', 'p2', 'p3']) await runAdmin(server, link('m3', tool, `m3-${tool}`));
  await runAdmin(server, link('p0', 'ptool', 'p0-ptool'));
  await runAdmin(server, link('pp', 'ptool', 'pp-ptool-1'));
  await runAdmin(server, link('pp', 'ptool', 'pp-ptool-2'));
  for (const tool of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']) {
    await runAdmin(server, link('e0', tool, `e0-${tool}`));
    await runAdmin(server, link('e9', tool, `e9-${tool}`));
  }
  for (const tool of ['o1', 'o2', 'o3', 'o4', 'o5']) await runAdmin(server, link('h0', tool, `h0-${tool}`));
  await runAdmin(server, link('g0', 'bigtool', 'g0-bigtool'));
  await runAdmin(server, `UNWIND range(1, 12) AS i MATCH (m:XMaker {makerId: 'big' + toString(i)}), (t:XTool {toolId: 'bigtool'}) CREATE (m)-[:USES_TOOL {useId: 'big' + toString(i)}]->(t)`);
  await runAdmin(server, link('w0', 'wt', 'w0-wt', "datetime('2026-01-10T00:00:00Z')"));
  await runAdmin(server, link('w1', 'wt', 'w1-wt', "datetime('2026-01-15T10:00:00Z')"));
  await runAdmin(server, link('w2', 'wt', 'w2-wt', "localdatetime('2026-01-20T00:00:00')"));
  await runAdmin(server, link('w3', 'wt', 'w3-wt', "date('2026-01-31')"));
  await runAdmin(server, link('w4', 'wt', 'w4-wt', "'2026-01-15'"));
  await runAdmin(server, link('w5', 'wt', 'w5-wt'));
  await runAdmin(server, link('w6', 'wt', 'w6-wt', "datetime('2025-12-31T23:59:59Z')"));
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  const open = (budgets: Record<string, number>): SourceGate => createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, derived, budgets })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
  parts = open({});
  small = open(SMALL_CAP);
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => small?.close(), () => server?.stop()]);
});

async function run(stableId: string, extra: Record<string, unknown> = {}, limit = 25, gate: SourceGate = parts) {
  const page = await gate.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: SHARED_ATTRIBUTE_ID, params: { entityType: 'maker', stableId, attributeType: 'tool', via: 'USES_TOOL', ...extra }, limit }));
  const [item] = page.items;
  if (!isNormalizedShared(item)) throw new Error('the read gave no shared-attribute result');
  return { page, item, matches: item.matches.map((ref) => ref.stableId).sort() };
}

const WINDOW = { windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' };

describe(`the shared-attribute run on ${NEO4J_SERIES}`, () => {
  it('finds the other accounts of a ring, never the anchor, and not through a stop-listed attribute node', async () => {
    const { matches, item } = await run('r0');
    expect(matches).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(item.skipped).toBe(true);
    expect(item.bounded).toBe(false);
    expect(item.anchorFound).toBe(true);
  });

  it('finds nothing through a stop-listed attribute node alone, and says it skipped one', async () => {
    const { matches, item } = await run('h1');
    expect(matches).toEqual([]);
    expect(item.skipped).toBe(true);
    expect(item.anchorFound).toBe(true);
  });

  it('answers one row with no match for an account that shares nothing, and no row for an account that does not exist', async () => {
    const lonely = await run('lonely');
    expect(lonely.matches).toEqual([]);
    expect(lonely.item.anchorFound).toBe(true);
    expect((await run('nobody')).item.anchorFound).toBe(false);
  });

  it('requires the minimum of shared attribute nodes', async () => {
    expect((await run('m0')).matches).toEqual(['m2', 'm3']);
    expect((await run('m0', { minShared: 2 })).matches).toEqual(['m2', 'm3']);
    expect((await run('m0', { minShared: 3 })).matches).toEqual(['m3']);
  });

  it('answers one relationship for a pair that has several, and a match once', async () => {
    const { matches, item } = await run('p0');
    expect(matches).toEqual(['pp']);
    expect(item.edges.filter((edge) => edge.type === 'USES_TOOL')).toHaveLength(2);
  });

  it('shows five of six shared attribute nodes and says evidence was cut', async () => {
    const { matches, item } = await run('e0');
    expect(matches).toEqual(['e9']);
    expect(item.evidenceCut).toBe(true);
    expect(item.nodes.filter((node) => node.ref.entityType === 'tool')).toHaveLength(5);
  });

  it('says a bound was hit when the anchor has more attribute nodes than the count cap', async () => {
    const { item } = await run('h0', {}, 25, small);
    expect(item.bounded).toBe(true);
  });

  it('says a bound was hit when an attribute node has more holders than the count cap, and cuts the matches at the limit', async () => {
    const { item, matches } = await run('g0', {}, 25, small);
    expect(item.bounded).toBe(true);
    expect(matches.length).toBeLessThanOrEqual(3);
    const cut = await run('g0', {}, 2, small);
    expect(cut.page.hasMore || cut.item.bounded).toBe(true);
  });

  it('takes a window as instants: a zoned date time, a local date time and a date count; a string, a missing value and an earlier time do not', async () => {
    const { matches } = await run('w0', WINDOW);
    expect(matches).toEqual(['w1', 'w2', 'w3']);
    expect((await run('w0')).matches).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6']);
  });
});
