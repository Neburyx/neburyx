import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedPaths } from './normalize/shortest-paths.js';
import { isNormalizedPathsCount } from './normalize/shortest-paths-count.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { SHORTEST_PATHS_ID } from './templates/shortest-paths.js';
import { SHORTEST_PATHS_COUNT_ID } from './templates/shortest-paths-count.js';

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'maker', label: 'PMaker', stable_id: 'makerId' },
  { type: 'tool', label: 'PTool', stable_id: 'toolId' },
];
const relationships = [
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId' },
  { type: 'USES', from: 'maker', to: 'tool', stable_id: 'useId' },
];

let edges = 0;
const link = (from: string, to: string, type = 'LINKS', key = 'linkId'): string => `MATCH (a {${from.startsWith('t') ? 'toolId' : 'makerId'}: '${from}'}), (b {${to.startsWith('t') ? 'toolId' : 'makerId'}: '${to}'}) CREATE (a)-[:${type} {${key}: 'r${(edges += 1)}'}]->(b)`;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT p_maker FOR (n:PMaker) REQUIRE n.makerId IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT p_tool FOR (n:PTool) REQUIRE n.toolId IS UNIQUE');
  await runAdmin(server, "UNWIND ['a0', 'b1', 'b2', 'c1', 'd1', 'x9', 'lonely'] AS id CREATE (:PMaker {makerId: id})");
  await runAdmin(server, "CREATE (:PTool {toolId: 't1'})");
  for (const [from, to] of [['a0', 'b1'], ['a0', 'b2'], ['b1', 'c1'], ['b2', 'c1'], ['c1', 'd1'], ['x9', 'a0']] as const) await runAdmin(server, link(from, to));
  await runAdmin(server, link('a0', 't1', 'USES', 'useId'));
  await runAdmin(server, link('c1', 't1', 'USES', 'useId'));
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

const ends = (from: string, to: string) => [from, to].map((stableId) => ({ sourceId: 'graph', entityType: 'maker', stableId }));

async function paths(from: string, to: string, extra: Record<string, unknown> = {}, limit = 25) {
  const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: SHORTEST_PATHS_ID, params: { ends: ends(from, to), via: ['LINKS'], maxHops: 3, ...extra }, limit }));
  const [item] = page.items;
  if (!isNormalizedPaths(item)) throw new Error('the read gave no paths result');
  return { page, item, walked: item.paths.map((steps) => steps.map((step) => step.to.stableId)) };
}

async function count(from: string, to: string, extra: Record<string, unknown> = {}) {
  const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: SHORTEST_PATHS_COUNT_ID, params: { ends: ends(from, to), via: ['LINKS'], maxHops: 3, ...extra }, limit: 1 }));
  const [item] = page.items;
  if (!isNormalizedPathsCount(item)) throw new Error('the read gave no count');
  return item;
}

describe(`the shortest-paths run on ${NEO4J_SERIES}`, () => {
  it('finds every shortest path between two entities, in either direction of the stored relationships, each with its steps and edges', async () => {
    const { walked, item } = await paths('a0', 'c1');
    expect(walked).toEqual([['b1', 'c1'], ['b2', 'c1']]);
    expect(item.fromFound && item.toFound).toBe(true);
    expect(item.edges.filter((edge) => edge.type === 'LINKS')).toHaveLength(4);
    expect((await paths('c1', 'a0')).walked).toEqual([['b1', 'a0'], ['b2', 'a0']]);
  });

  it('walks only along the stored direction for out, only against it for in, and finds nothing the other way round', async () => {
    expect((await paths('x9', 'c1', { direction: 'out' })).walked).toEqual([['a0', 'b1', 'c1'], ['a0', 'b2', 'c1']]);
    expect((await paths('c1', 'x9', { direction: 'in' })).walked).toEqual([['b1', 'a0', 'x9'], ['b2', 'a0', 'x9']]);
    expect((await paths('x9', 'c1', { direction: 'in' })).walked).toEqual([]);
    expect((await paths('c1', 'x9', { direction: 'out' })).walked).toEqual([]);
  });

  it('stops at the hop count and takes only the listed relationship types', async () => {
    expect((await paths('a0', 'c1', { maxHops: 1 })).walked).toEqual([]);
    expect((await paths('a0', 'd1', { maxHops: 3 })).walked).toEqual([['b1', 'c1', 'd1'], ['b2', 'c1', 'd1']]);
    const withTool = await paths('a0', 'c1', { via: ['LINKS', 'USES'] });
    expect(withTool.walked).toHaveLength(3);
    expect(withTool.walked.flat()).toContain('t1');
  });

  it('answers the first rows it has read and one more than the limit, so that a cut is told from a complete read', async () => {
    const cut = await paths('a0', 'c1', {}, 1);
    expect(cut.walked).toHaveLength(1);
    expect(cut.page.hasMore).toBe(true);
    const whole = await paths('a0', 'c1', {}, 2);
    expect(whole.walked).toHaveLength(2);
    expect(whole.page.hasMore).toBe(false);
  });

  it('tells two ends that are not connected from an end that is not in the source', async () => {
    const apart = await paths('a0', 'lonely');
    expect({ from: apart.item.fromFound, to: apart.item.toFound, walked: apart.walked }).toEqual({ from: true, to: true, walked: [] });
    const missingTo = await paths('a0', 'nobody');
    expect({ from: missingTo.item.fromFound, to: missingTo.item.toFound }).toEqual({ from: true, to: false });
    expect((await paths('nobody', 'a0')).item.fromFound).toBe(false);
  });

  it('counts the relationships at each end that the search would have to expand, in the direction it expands them', async () => {
    expect(await count('a0', 'c1')).toMatchObject({ anchorFound: true, usable: true, matches: 6 });
    expect(await count('a0', 'c1', { direction: 'out' })).toMatchObject({ matches: 4 });
    expect(await count('a0', 'c1', { direction: 'in' })).toMatchObject({ matches: 2 });
    expect((await count('a0', 'nobody')).anchorFound).toBe(false);
  });
});
