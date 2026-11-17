import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedPattern } from './normalize/pattern.js';
import { isNormalizedPatternCount } from './normalize/pattern-count.js';
import { patternCountQualityOf } from './templates/pattern-notices.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { PATTERN_ID } from './templates/pattern.js';
import { PATTERN_COUNT_ID } from './templates/pattern-count.js';

let server: RunningNeo4j;
let parts: SourceGate;
let small: SourceGate;

const entities = [{ type: 'maker', label: 'FMaker', stable_id: 'makerId' }];
const relationships = [
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt' },
  { type: 'ALSO', from: 'maker', to: 'maker', stable_id: 'alsoId', observed_at: 'seenAt' },
];
const SMALL_CAP = { heavy_op_threshold: 4 };
let edges = 0;
const rel = (type: string, from: string, to: string, at?: string): string => `MATCH (a:FMaker {makerId: '${from}'}), (b:FMaker {makerId: '${to}'}) CREATE (a)-[:${type} {${type === 'LINKS' ? 'linkId' : 'alsoId'}: 'r${(edges += 1)}'${at === undefined ? '' : `, seenAt: datetime('${at}')`}}]->(b)`;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT f_maker FOR (n:FMaker) REQUIRE n.makerId IS UNIQUE');
  const ids = ['c2a', 'c2b', 't1', 't2', 't3', 'k', 'x', 'y', 'p', 'q', 'sl', 'ra', 'rb', 'par', 'parb', 'one', 'oneb', 'nc', 'ncb', 'sa', 'hub', 'h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'f0', 'f1', 'f2', 'f3'];
  await runAdmin(server, `UNWIND [${ids.map((id) => `'${id}'`).join(',')}] AS id CREATE (:FMaker {makerId: id})`);
  const at = '2026-01-01T00:00:00Z';
  for (const [from, to] of [['c2a', 'c2b'], ['c2b', 'c2a'], ['t1', 't2'], ['t2', 't3'], ['t3', 't1'], ['k', 'x'], ['x', 'y'], ['y', 'k'], ['k', 'p'], ['p', 'q'], ['q', 'k'], ['sl', 'sl'], ['ra', 'rb'], ['par', 'parb'], ['par', 'parb'], ['one', 'oneb'], ['nc', 'ncb'], ['sa', 'hub'], ['hub', 'sa']] as const) await runAdmin(server, rel('LINKS', from, to, at));
  for (const id of ['h0', 'h1', 'h2', 'h3', 'h4', 'h5']) await runAdmin(server, rel('LINKS', 'hub', id, at));
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  const open = (budgets: Record<string, number>): SourceGate => createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, derived: [], budgets })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
  parts = open({});
  small = open(SMALL_CAP);
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => small?.close(), () => server?.stop()]);
});

const hop = (over: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...over });
const close = (over: Record<string, unknown> = {}) => hop({ closesAtAnchor: true, ...over });

async function run(stableId: string, steps: Record<string, unknown>[], gate: SourceGate = parts) {
  const page = await gate.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_ID, params: { anchorType: 'maker', stableId, steps }, limit: 25 }));
  const [item] = page.items;
  if (!isNormalizedPattern(item)) throw new Error('the read gave no pattern result');
  const probe = await gate.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_COUNT_ID, params: { anchorType: 'maker', stableId, steps }, limit: 1 }));
  const [counted] = probe.items;
  if (!isNormalizedPatternCount(counted)) throw new Error('the read gave no pattern count');
  return { item, counted, ids: item.matches.map((entry) => entry.match.stableId), page };
}

describe(`a pattern that closes back at the anchor on ${NEO4J_SERIES}`, () => {
  it('returns the anchor once, with the cycle as its path, for a cycle of two and of three steps, and the count is 1', async () => {
    for (const [anchor, steps] of [['c2a', [hop(), close()]], ['t1', [hop(), hop(), close()]]] as const) {
      const result = await run(anchor, [...steps]);
      expect(result.ids, anchor).toEqual([anchor]);
      expect(result.item.matches[0]?.hops).toBe(steps.length);
      expect(result.item.matches[0]?.relationships).toHaveLength(steps.length);
      expect(result.counted.matches).toBe(1);
      expect(result.item.anchorFound).toBe(true);
      expect(patternCountQualityOf(result.item, result.page.hasMore)).toBe('exact');
    }
  });

  it('returns one match, with the first cycle by stable ID as its path, when there are two cycles through the anchor', async () => {
    const result = await run('k', [hop(), hop(), close()]);
    expect(result.ids).toEqual(['k']);
    expect(result.item.matches[0]?.through.map((ref) => ref?.stableId)).toEqual(['p', 'q']);
    expect(result.counted.matches).toBe(1);
  });

  it('finds nothing, and says the anchor was found, when there is no cycle: a path that does not return, a self-loop and a lone relationship read back', async () => {
    for (const [anchor, steps] of [['nc', [hop(), close()]], ['sl', [hop(), close()]], ['ra', [hop({ direction: 'both' }), close({ direction: 'both' })]]] as const) {
      const result = await run(anchor, [...steps]);
      expect(result.ids, anchor).toEqual([]);
      expect(result.item.anchorFound).toBe(true);
      expect(result.counted.matches).toBe(0);
      expect(patternCountQualityOf(result.item, result.page.hasMore)).toBe('exact');
    }
  });

  it('never uses a relationship twice: two parallel relationships make a cycle of two, one does not', async () => {
    const out = [hop(), close({ direction: 'in' })];
    expect((await run('par', out)).ids).toEqual(['par']);
    expect((await run('one', out)).ids).toEqual([]);
  });

  it('skips a node on the cycle that has more relationships than the count cap, names it, and is a lower bound', async () => {
    const skipped = await run('sa', [hop(), close()], small);
    expect(skipped.ids).toEqual([]);
    expect(skipped.item.supernodes.map((ref) => ref.stableId)).toEqual(['hub']);
    expect(skipped.counted.supernodes).toBe(1);
    expect(patternCountQualityOf(skipped.item, skipped.page.hasMore)).toBe('lowerBound');
    expect((await run('sa', [hop(), close()])).ids).toEqual(['sa']);
  });
});
