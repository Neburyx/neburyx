import neo4j from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { patternRunResponseSchema } from '@neburyx/contracts';
import type { MappingModel } from '../mapping/model.js';
import { createSourceAccess } from '../investigations/source-access.js';
import { createPatternRunService } from '../patterns/run-service.js';
import { defaultTemplateProbes, estimateOf } from '../graph/template-probes.js';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedPattern } from './normalize/pattern.js';
import { isNormalizedPatternCount, type NormalizedPatternCount } from './normalize/pattern-count.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { PATTERN_ID } from './templates/pattern.js';
import { PATTERN_COUNT_ID } from './templates/pattern-count.js';

let server: RunningNeo4j;
let parts: SourceGate;
let small: SourceGate;
let mappings: { readonly parts: MappingModel; readonly small: MappingModel };

const entities = [{ type: 'maker', label: 'QMaker', stable_id: 'makerId' }];
const relationships = [{ type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId' }];
const SMALL_CAP = { heavy_op_threshold: 3 };

let edges = 0;
const link = (from: string, to: string): string => `MATCH (a:QMaker {makerId: '${from}'}), (b:QMaker {makerId: '${to}'}) CREATE (a)-[:LINKS {linkId: 'q${(edges += 1)}'}]->(b)`;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT q_maker FOR (n:QMaker) REQUIRE n.makerId IS UNIQUE');
  const makers = ['g0', 'e0', 'e1', 'e2', 'el1', 'el2', 'el3', 'el4', 's0', 's1', 'sl1', 'sl2', 'sl3', 'sl4', 'sl5', 'sl6', 'b0', 'bn1', 'bn2', 'bn3', 'bn4', 'bn5', 'bl1', 'bl2', 'bl3', 'bl4', 'bl5', 'one0', 'one1', 'one2', 'one3', 'one4', 'lonely'];
  await runAdmin(server, `UNWIND [${makers.map((id) => `'${id}'`).join(',')}] AS id CREATE (:QMaker {makerId: id})`);
  // heavy: six middle entities of 100 leaves each (default count cap 500, so the second step reaches 600 distinct entities, each middle one far below the cap)
  await runAdmin(server, "MATCH (g:QMaker {makerId: 'g0'}) UNWIND range(1, 6) AS i CREATE (m:QMaker {makerId: 'gm' + toString(i)}) CREATE (g)-[:LINKS {linkId: 'gm' + toString(i)}]->(m) WITH m, i UNWIND range(1, 100) AS j CREATE (m)-[:LINKS {linkId: 'gl' + toString(i) + '-' + toString(j)}]->(:QMaker {makerId: 'gl' + toString(i) + '-' + toString(j)})");
  // under the threshold: two middle entities with two leaves each, every leaf reached by one path
  for (const [from, to] of [['e0', 'e1'], ['e0', 'e2'], ['e1', 'el1'], ['e1', 'el2'], ['e2', 'el3'], ['e2', 'el4']] as const) await runAdmin(server, link(from, to));
  // a supernode: the one middle entity has six relationships, above the small count cap of 3, and without the skip its neighbors alone would make the count heavy
  await runAdmin(server, link('s0', 's1'));
  for (const id of ['sl1', 'sl2', 'sl3', 'sl4', 'sl5', 'sl6']) await runAdmin(server, link('s1', id));
  // a first step that is cut: five neighbors of the anchor, one leaf each, above the small count cap
  for (const id of ['bn1', 'bn2', 'bn3', 'bn4', 'bn5']) await runAdmin(server, link('b0', id));
  for (const [mid, leaf] of [['bn1', 'bl1'], ['bn2', 'bl2'], ['bn3', 'bl3'], ['bn4', 'bl4'], ['bn5', 'bl5']] as const) await runAdmin(server, link(mid, leaf));
  // a one-step pattern from an anchor with more neighbors than the small count cap
  for (const id of ['one1', 'one2', 'one3', 'one4']) await runAdmin(server, link('one0', id));
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  const open = (budgets: Record<string, number>): SourceGate => createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, budgets })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
  parts = open({});
  small = open(SMALL_CAP);
  mappings = { parts: { sources: [sourceFor(server, { entities, relationships })] }, small: { sources: [sourceFor(server, { entities, relationships, budgets: SMALL_CAP })] } };
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => small?.close(), () => server?.stop()]);
});

const hop = (over: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...over });
const TWO = [hop(), hop()];

async function count(stableId: string, steps: Record<string, unknown>[], gate: SourceGate = parts): Promise<NormalizedPatternCount> {
  const page = await gate.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_COUNT_ID, params: { anchorType: 'maker', stableId, steps }, limit: 1 }));
  const [item] = page.items;
  if (!isNormalizedPatternCount(item)) throw new Error('the read gave no pattern count');
  return item;
}

async function run(stableId: string, steps: Record<string, unknown>[], limit = 25, gate: SourceGate = parts) {
  const page = await gate.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_ID, params: { anchorType: 'maker', stableId, steps }, limit }));
  const [item] = page.items;
  if (!isNormalizedPattern(item)) throw new Error('the read gave no pattern result');
  return item;
}

const SCOPE = 'template:pattern:estimate';

describe(`the count of a pattern run on ${NEO4J_SERIES}`, () => {
  it('counts one more than the threshold for a pattern whose second step reaches more entities than the threshold from middle entities that are each below the cap, so the estimate is a lower bound at the threshold and the run is heavy; the continue request reads 25 rows', async () => {
    const item = await count('g0', TWO);
    expect(item).toMatchObject({ anchorFound: true, usable: true, matches: 501, bounded: false, stopListed: false, supernodes: 0 });
    expect(estimateOf({ matches: item.matches, bounded: item.bounded }, 500, SCOPE)).toEqual({ estimate: { value: 500, quality: 'lowerBound', scope: SCOPE }, heavy: true });
    const first = await run('g0', TWO, 25);
    expect(first.matches).toHaveLength(25);
  });

  it('counts exactly the matches a run below the threshold returns, labelled exact, with no warning, when every match is reached by one path', async () => {
    const item = await count('e0', TWO);
    expect(item).toMatchObject({ anchorFound: true, usable: true, matches: 4, bounded: false, stopListed: false, supernodes: 0 });
    expect(estimateOf({ matches: item.matches, bounded: item.bounded }, 500, SCOPE)).toEqual({ estimate: { value: 4, quality: 'exact', scope: SCOPE }, heavy: false });
    const ran = await run('e0', TWO);
    expect(ran.matches.map((entry) => entry.match.stableId).sort()).toEqual(['el1', 'el2', 'el3', 'el4']);
    expect(ran.matches).toHaveLength(item.matches);
  });

  it('skips a middle entity with more relationships than the count cap, reports it, and is not heavy although its neighbors alone are over the threshold', async () => {
    const item = await count('s0', TWO, small);
    expect(item).toMatchObject({ anchorFound: true, usable: true, matches: 0, bounded: false, supernodes: 1 });
    expect(estimateOf({ matches: item.matches, bounded: item.bounded || item.supernodes > 0 }, 3, SCOPE)).toEqual({ estimate: { value: 0, quality: 'lowerBound', scope: SCOPE }, heavy: false });
    const ran = await run('s0', TWO, 25, small);
    expect(ran.matches).toHaveLength(0);
    expect(ran.supernodes.length).toBeGreaterThan(0);
    // without the skip: the same neighbors read from the supernode itself are over the small threshold
    expect((await count('s1', [hop()], small)).matches).toBe(4);
  });

  it('reports a step before the last that reached the cap as bounded, with the value counted', async () => {
    const item = await count('b0', TWO, small);
    expect(item).toMatchObject({ usable: true, matches: 3, bounded: true });
    expect(estimateOf({ matches: item.matches, bounded: item.bounded }, 3, SCOPE)).toEqual({ estimate: { value: 3, quality: 'lowerBound', scope: SCOPE }, heavy: false });
  });

  it('counts a one-step pattern from an anchor with more neighbors than the cap as heavy, and answers no row for an anchor that is not found', async () => {
    expect((await count('one0', [hop()], small)).matches).toBe(4);
    const page = await small.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_COUNT_ID, params: { anchorType: 'maker', stableId: 'nobody', steps: [hop()] }, limit: 1 }));
    expect(page.items[0]).toMatchObject({ anchorFound: false, usable: false });
  });

  it('is accepted by the database for one, two and four steps in a read call and answers one row of numbers and flags', async () => {
    for (const steps of [[hop()], TWO, [hop(), hop(), hop(), hop()]]) {
      const item = await count('e0', steps);
      expect(Object.keys(item).sort()).toEqual(['anchorFound', 'bounded', 'estimateKind', 'matches', 'stopListed', 'supernodes', 'usable']);
      expect(item.usable).toBe(true);
    }
  });

  it('cannot write through the login it reads with', async () => {
    const driver = neo4j.driver(server.boltUri, neo4j.auth.basic(server.reader.user, server.reader.password));
    const session = driver.session({ database: server.database });
    try {
      await expect(session.run("CREATE (:QMaker {makerId: 'written'})")).rejects.toMatchObject({ code: expect.stringContaining('Forbidden') });
    } finally {
      await session.close();
      await driver.close();
    }
  });
});

/** The pattern run service over the real gate and the real probe: what the route answers. */
function serviceOver(which: 'parts' | 'small') {
  const mapping = mappings[which];
  const seams = communitySeams();
  const access = createSourceAccess({ mapping, seams, logger: { warn: () => undefined } });
  const service = createPatternRunService({ gate: (which === 'parts' ? parts : small).gate, mapping, access, probes: defaultTemplateProbes() });
  return (stableId: string, steps: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    service.run({ traceId: 'tr-neo4j', principal: LOCAL_PRINCIPAL, sourceId: 'graph', definition: { anchorType: 'maker', steps }, anchor: { entityType: 'maker', stableId }, mask: false, ...extra }).then((answer) => patternRunResponseSchema.parse(answer));
}

describe(`the pattern run answers through the probe on ${NEO4J_SERIES}`, () => {
  it('stops as heavy with a lower bound at the threshold and no rows when the second step reaches more than the threshold, and the continue request answers 25 rows', async () => {
    const run = serviceOver('parts');
    const stopped = await run('g0', TWO, { limit: 40 });
    expect(stopped).toMatchObject({ status: 'heavy', estimate: { value: 500, quality: 'lowerBound', scope: SCOPE }, threshold: 500, continueLimit: 25 });
    const continued = await run('g0', TWO, { limit: 40, continue: true });
    expect(continued.status).toBe('ok');
    if (continued.status === 'ok') expect(continued.matches).toHaveLength(25);
  });

  it('answers ok with the run’s own exact count and no warning below the threshold', async () => {
    const answer = await serviceOver('parts')('e0', TWO);
    expect(answer).toMatchObject({ status: 'ok', count: { value: 4, quality: 'exact' } });
  });

  it('answers ok with a lower-bound count and the supernodesSkipped notice for a supernode, and is not heavy', async () => {
    const answer = await serviceOver('small')('s0', TWO);
    expect(answer.status).toBe('ok');
    if (answer.status === 'ok') {
      expect(answer.count.quality).toBe('lowerBound');
      expect(answer.notices.map((notice) => notice.code)).toContain('supernodesSkipped');
    }
  });
});
