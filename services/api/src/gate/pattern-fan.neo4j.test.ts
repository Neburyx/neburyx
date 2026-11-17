import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedPattern } from './normalize/pattern.js';
import { isNormalizedPatternCount } from './normalize/pattern-count.js';
import { patternCountQualityOf } from './templates/pattern-notices.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { EXPAND_NEIGHBORS_ID } from './templates/expand-neighbors.js';
import { PATTERN_ID } from './templates/pattern.js';
import { PATTERN_COUNT_ID } from './templates/pattern-count.js';

let server: RunningNeo4j;
let parts: SourceGate;
let small: SourceGate;

const entities = [{ type: 'maker', label: 'FMaker', stable_id: 'makerId' }];
const relationships = [
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt', filterable: ['lane'] },
  { type: 'ALSO', from: 'maker', to: 'maker', stable_id: 'alsoId', observed_at: 'seenAt' },
];
const SMALL_CAP = { heavy_op_threshold: 4 };
let edges = 0;
const rel = (type: string, from: string, to: string, at?: string): string => `MATCH (a:FMaker {makerId: '${from}'}), (b:FMaker {makerId: '${to}'}) CREATE (a)-[:${type} {${type === 'LINKS' ? 'linkId' : 'alsoId'}: 'r${(edges += 1)}'${at === undefined ? '' : `, seenAt: datetime('${at}')`}}]->(b)`;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT f_maker FOR (n:FMaker) REQUIRE n.makerId IS UNIQUE');
  const ids = ['b3', 'b3a', 'b3b', 'b3c', 'b2', 'b2a', 'b2b', 'p', 'pa', 'pb', 'o', 'oa', 'ob', 'i', 'ia', 'ib', 'ic', 'sup', 's0', 's1', 's2', 's3', 's4', 's5', 'w0', 'w1', 'u1', 'u2', 'u3', 'fc', 'fc1', 'fc2', 'fc3', 'hp', 'hp1', 'hp2', 'hp3', 'hp4'];
  await runAdmin(server, `UNWIND [${ids.map((id) => `'${id}'`).join(',')}] AS id CREATE (:FMaker {makerId: id})`);
  // b3 has three neighbours and b2 two: the boundary
  for (const to of ['b3a', 'b3b', 'b3c']) await runAdmin(server, rel('LINKS', 'b3', to, '2026-01-01T00:00:00Z'));
  for (const to of ['b2a', 'b2b']) await runAdmin(server, rel('LINKS', 'b2', to, '2026-01-01T00:00:00Z'));
  // p has two neighbours, each by two parallel relationships (four relationships, two nodes)
  for (const to of ['pa', 'pb']) for (const _twice of [1, 2]) await runAdmin(server, rel('LINKS', 'p', to, '2026-01-01T00:00:00Z'));
  // o has two neighbours, each by a LINKS and an ALSO relationship (overlapping types)
  for (const to of ['oa', 'ob']) {
    await runAdmin(server, rel('LINKS', 'o', to, '2026-01-01T00:00:00Z'));
    await runAdmin(server, rel('ALSO', 'o', to, '2026-01-01T00:00:00Z'));
  }
  // i is reached by ia and ib in, and left to ia and ic out: ia is one neighbour for both directions
  for (const from of ['ia', 'ib']) await runAdmin(server, rel('LINKS', from, 'i', '2026-01-01T00:00:00Z'));
  for (const to of ['ia', 'ic']) await runAdmin(server, rel('LINKS', 'i', to, '2026-01-01T00:00:00Z'));
  // sup has six relationships, one neighbour of which qualifies; the cap is 4
  for (const to of ['s0', 's1', 's2', 's3', 's4', 's5']) await runAdmin(server, rel('LINKS', 'sup', to, '2026-01-01T00:00:00Z'));
  // w0 -> w1 in January, and w1's neighbours: u1 in February (after), u2 on the 5th of January (before, counted), u3 in March (after)
  await runAdmin(server, rel('LINKS', 'w0', 'w1', '2026-01-10T00:00:00Z'));
  await runAdmin(server, rel('LINKS', 'w1', 'u1', '2026-02-01T00:00:00Z'));
  await runAdmin(server, rel('LINKS', 'w1', 'u2', '2026-01-05T00:00:00Z'));
  await runAdmin(server, rel('LINKS', 'w1', 'u3', '2026-03-01T00:00:00Z'));
  // fc has three neighbours: two on lane web (one of them in January, one in March) and one on lane mail in January
  await runAdmin(server, "MATCH (x:FMaker {makerId: 'fc'}), (y:FMaker {makerId: 'fc1'}) CREATE (x)-[:LINKS {linkId: 'fc-1', lane: 'web', seenAt: datetime('2026-01-10T00:00:00Z')}]->(y)");
  await runAdmin(server, "MATCH (x:FMaker {makerId: 'fc'}), (y:FMaker {makerId: 'fc2'}) CREATE (x)-[:LINKS {linkId: 'fc-2', lane: 'web', seenAt: datetime('2026-03-10T00:00:00Z')}]->(y)");
  await runAdmin(server, "MATCH (x:FMaker {makerId: 'fc'}), (y:FMaker {makerId: 'fc3'}) CREATE (x)-[:LINKS {linkId: 'fc-3', lane: 'mail', seenAt: datetime('2026-01-12T00:00:00Z')}]->(y)");
  // hp has four neighbours, each by two parallel relationships on lane mail but one: eight relationships, over the cap of 4, and one qualifying neighbour on lane web
  for (const to of ['hp1', 'hp2', 'hp3', 'hp4']) for (const twice of [1, 2]) await runAdmin(server, `MATCH (x:FMaker {makerId: 'hp'}), (y:FMaker {makerId: '${to}'}) CREATE (x)-[:LINKS {linkId: 'hp-${to}-${twice}', lane: '${to === 'hp1' ? 'web' : 'mail'}', seenAt: datetime('2026-01-10T00:00:00Z')}]->(y)`);
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  const open = (budgets: Record<string, number>): SourceGate => createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, derived: [], budgets })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
  parts = open({});
  small = open(SMALL_CAP);
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => small?.close(), () => server?.stop()]);
});

const lane = (value: string) => ({ op: 'eq', on: 'relationship', property: 'lane', value: { kind: 'text', value } });
const WINDOW = { windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' };
const hop = (over: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...over });
const fan = (atLeast: number, over: Record<string, unknown> = {}) => hop({ fan: { atLeast }, ...over });

async function run(stableId: string, steps: Record<string, unknown>[], gate: SourceGate = parts) {
  const page = await gate.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_ID, params: { anchorType: 'maker', stableId, steps }, limit: 25 }));
  const [item] = page.items;
  if (!isNormalizedPattern(item)) throw new Error('the read gave no pattern result');
  const probe = await gate.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_COUNT_ID, params: { anchorType: 'maker', stableId, steps }, limit: 1 }));
  const [counted] = probe.items;
  if (!isNormalizedPatternCount(counted)) throw new Error('the read gave no pattern count');
  const ids = item.matches.map((entry) => entry.match.stableId).sort();
  return { item, counted, ids, page };
}

/** The run and the probe it is estimated with read the same fan: the same matches, the same flags. */
function agree(result: Awaited<ReturnType<typeof run>>): void {
  expect(result.counted.matches).toBe(result.ids.length);
  expect(result.counted.supernodes).toBe(result.item.supernodes.length);
  expect(result.counted.bounded).toBe(result.item.bounded);
  expect(result.counted.stopListed).toBe(result.item.stopListed);
}

describe(`the fan of a pattern on ${NEO4J_SERIES}`, () => {
  it('passes an origin at the threshold and not one above it: n - 1, n and n + 1 neighbours', async () => {
    for (const [anchor, atLeast, expected] of [['b3', 2, 3], ['b3', 3, 3], ['b3', 4, 0], ['b2', 2, 2], ['b2', 3, 0]] as const) {
      const result = await run(anchor, [fan(atLeast)]);
      expect(result.ids, `${anchor} ${atLeast}`).toHaveLength(expected);
      expect(result.item.anchorFound).toBe(true);
      agree(result);
    }
  });

  it('counts a neighbour once however many relationships reach it: parallel relationships and overlapping types', async () => {
    expect((await run('p', [fan(2)])).ids).toEqual(['pa', 'pb']);
    expect((await run('p', [fan(3)])).ids).toEqual([]);
    const both = hop({ relationshipTypes: ['LINKS', 'ALSO'] });
    expect((await run('o', [{ ...both, fan: { atLeast: 2 } }])).ids).toEqual(['oa', 'ob']);
    expect((await run('o', [{ ...both, fan: { atLeast: 3 } }])).ids).toEqual([]);
    agree(await run('p', [fan(2)]));
    agree(await run('o', [{ ...both, fan: { atLeast: 2 } }]));
  });

  it('counts a neighbour once for both directions, and fan-in counts the relationships that arrive', async () => {
    const both = hop({ direction: 'both' });
    // i touches ia (in and out), ib (in) and ic (out): three neighbours
    expect((await run('i', [{ ...both, fan: { atLeast: 3 } }])).ids).toEqual(['ia', 'ib', 'ic']);
    expect((await run('i', [{ ...both, fan: { atLeast: 4 } }])).ids).toEqual([]);
    expect((await run('i', [hop({ direction: 'in', fan: { atLeast: 2 } })])).ids).toEqual(['ia', 'ib']);
    expect((await run('i', [hop({ direction: 'in', fan: { atLeast: 3 } })])).ids).toEqual([]);
    agree(await run('i', [{ ...both, fan: { atLeast: 3 } }]));
  });

  it('does not evaluate an origin with more relationships than the count cap: skipped, named, a lower bound, never exact', async () => {
    const first = await run('sup', [fan(2)], small);
    expect(first.ids).toEqual([]);
    expect(first.item.anchorFound).toBe(true);
    expect(first.item.supernodes.map((ref) => ref.stableId)).toEqual(['sup']);
    expect(patternCountQualityOf(first.item, first.page.hasMore)).toBe('lowerBound');
    agree(first);
    // the same origin in the second step of a pattern: the node between is a supernode
    const later = await run('sup', [hop(), fan(2)], small);
    expect(later.ids).toEqual([]);
    agree(later);
    // within the cap the same fan is evaluated and exact
    const within = await run('sup', [fan(2)]);
    expect(within.ids).toHaveLength(6);
    expect(patternCountQualityOf(within.item, within.page.hasMore)).toBe('exact');
  });

  it('counts the neighbours with the conditions of the step and not the order of the path, while the rows are ordered', async () => {
    const free = await run('w0', [hop(), hop()]);
    expect(free.ids).toEqual(['u1', 'u2', 'u3']);
    const ordered = await run('w0', [hop(), hop({ after: 'previous' })]);
    expect(ordered.ids).toEqual(['u1', 'u3']);
    const fanned = await run('w0', [hop(), fan(3, { after: 'previous' })]);
    expect(fanned.ids).toEqual(['u1', 'u3']);
    const tooMany = await run('w0', [hop(), fan(4, { after: 'previous' })]);
    expect(tooMany.ids).toEqual([]);
    agree(ordered);
    agree(fanned);
    agree(tooMany);
  });

  it('counts the neighbours that meet the conditions and the window of the step, run and probe alike', async () => {
    expect((await run('fc', [fan(3)])).ids).toEqual(['fc1', 'fc2', 'fc3']);
    expect((await run('fc', [fan(2, { conditions: [lane('web')] })])).ids).toEqual(['fc1', 'fc2']);
    expect((await run('fc', [fan(3, { conditions: [lane('web')] })])).ids).toEqual([]);
    const windowed = await run('fc', [fan(2, WINDOW)]);
    expect(windowed.ids).toEqual(['fc1', 'fc3']);
    expect((await run('fc', [fan(3, WINDOW)])).ids).toEqual([]);
    expect((await run('fc', [fan(2, { ...WINDOW, conditions: [lane('web')] })])).ids).toEqual([]);
    for (const steps of [[fan(2, { conditions: [lane('web')] })], [fan(2, WINDOW)]]) agree(await run('fc', steps));
  });

  it('does not scan a high-degree origin to find a few qualifying neighbours: eight parallel relationships over the cap of 4 are a skipped supernode, however few qualify', async () => {
    const skipped = await run('hp', [fan(1 + 1, { conditions: [lane('web')] })], small);
    expect(skipped.ids).toEqual([]);
    expect(skipped.item.supernodes.map((ref) => ref.stableId)).toEqual(['hp']);
    expect(patternCountQualityOf(skipped.item, skipped.page.hasMore)).toBe('lowerBound');
    agree(skipped);
    const within = await run('hp', [fan(4)]);
    expect(within.ids).toEqual(['hp1', 'hp2', 'hp3', 'hp4']);
  });

  it('leaves a skipped origin reachable through the expansion’s own bounded paging, which reads it in pages', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await small.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: EXPAND_NEIGHBORS_ID, params: { entityType: 'maker', stableId: 'hp', neighborType: 'maker', direction: 'out', sort: 'observed', relTypes: ['LINKS'] }, limit: 3, ...(cursor === undefined ? {} : { cursor }) }));
      const item = result.items[0] as unknown as { nodes: { ref: { entityType: string; stableId: string } }[] };
      seen.push(...item.nodes.filter((node) => node.ref.stableId !== 'hp').map((node) => node.ref.stableId));
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    expect([...new Set(seen)].sort()).toEqual(['hp1', 'hp2', 'hp3', 'hp4']);
  });
});
