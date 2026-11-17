import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedPattern } from './normalize/pattern.js';
import { isNormalizedPatternCount } from './normalize/pattern-count.js';
import { patternNoticesOf } from './templates/pattern-notices.js';
import { patternRequestOf } from './templates/pattern-request.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { PATTERN_ID } from './templates/pattern.js';
import { PATTERN_COUNT_ID } from './templates/pattern-count.js';

let server: RunningNeo4j;
let parts: SourceGate;
let small: SourceGate;

const entities = [{ type: 'maker', label: 'FMaker', stable_id: 'makerId' }];
const relationships = [
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt' },
  { type: 'ALSO', from: 'maker', to: 'maker', stable_id: 'alsoId', observed_at: 'spottedAt' },
];
const SMALL_CAP = { heavy_op_threshold: 4 };
let edges = 0;
const rel = (type: string, from: string, to: string, at?: string): string => `MATCH (a:FMaker {makerId: '${from}'}), (b:FMaker {makerId: '${to}'}) CREATE (a)-[:${type} {${type === 'LINKS' ? 'linkId' : 'alsoId'}: 'r${(edges += 1)}'${at === undefined ? '' : `, seenAt: datetime('${at}')`}}]->(b)`;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT f_maker FOR (n:FMaker) REQUIRE n.makerId IS UNIQUE');
  const ids = ['a', 'b', 'c', 'd', 'a2', 'b2', 'c2', 'a3', 'b3', 'c3', 'a4', 'b4', 'c4', 'a5', 'b5', 'c5'];
  await runAdmin(server, `UNWIND [${ids.map((id) => `'${id}'`).join(',')}] AS id CREATE (:FMaker {makerId: id})`);
  const set = (type: string, from: string, to: string, property: string, value: string | undefined): string => `MATCH (x:FMaker {makerId: '${from}'}), (y:FMaker {makerId: '${to}'}) CREATE (x)-[:${type} {${type === 'LINKS' ? 'linkId' : 'alsoId'}: 'r${(edges += 1)}'${value === undefined ? '' : `, ${property}: ${value}`}}]->(y)`;
  // a -> b (LINKS, seenAt Jan 10) -> c (ALSO, spottedAt Jan 10: equal) -> d (LINKS, seenAt Feb 1)
  await runAdmin(server, set('LINKS', 'a', 'b', 'seenAt', "datetime('2026-01-10T00:00:00Z')"));
  await runAdmin(server, set('ALSO', 'b', 'c', 'spottedAt', "datetime('2026-01-10T00:00:00Z')"));
  await runAdmin(server, set('LINKS', 'c', 'd', 'seenAt', "datetime('2026-02-01T00:00:00Z')"));
  // a2: the second relationship is before the first
  await runAdmin(server, set('LINKS', 'a2', 'b2', 'seenAt', "datetime('2026-01-10T00:00:00Z')"));
  await runAdmin(server, set('ALSO', 'b2', 'c2', 'spottedAt', "datetime('2026-01-05T00:00:00Z')"));
  // a3: the first has no time
  await runAdmin(server, set('LINKS', 'a3', 'b3', 'seenAt', undefined));
  await runAdmin(server, set('ALSO', 'b3', 'c3', 'spottedAt', "datetime('2026-02-01T00:00:00Z')"));
  // a4: the first has text for a time
  await runAdmin(server, set('LINKS', 'a4', 'b4', 'seenAt', "'next week'"));
  await runAdmin(server, set('ALSO', 'b4', 'c4', 'spottedAt', "datetime('2026-02-01T00:00:00Z')"));
  // a5: the second has a number for a time
  await runAdmin(server, set('LINKS', 'a5', 'b5', 'seenAt', "datetime('2026-01-10T00:00:00Z')"));
  await runAdmin(server, set('ALSO', 'b5', 'c5', 'spottedAt', '20260201'));
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  const open = (budgets: Record<string, number>): SourceGate => createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, derived: [], budgets })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
  parts = open({});
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

const hop = (types: string[], over: Record<string, unknown> = {}) => ({ relationshipTypes: types, direction: 'out', arrivesAt: 'maker', ...over });
const LINKS = hop(['LINKS']);
const ALSO = hop(['ALSO']);
const after = { after: 'previous' };

async function run(stableId: string, steps: Record<string, unknown>[]) {
  const params = { anchorType: 'maker', stableId, steps };
  const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_ID, params, limit: 25 }));
  const [item] = page.items;
  if (!isNormalizedPattern(item)) throw new Error('the read gave no pattern result');
  const probe = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_COUNT_ID, params, limit: 1 }));
  const [counted] = probe.items;
  if (!isNormalizedPatternCount(counted)) throw new Error('the read gave no pattern count');
  const ids = item.matches.map((entry) => entry.match.stableId).sort();
  expect(counted.matches, 'the probe agrees with the run').toBe(ids.length);
  return { item, ids };
}

describe(`a time order across steps with a time property of its own on each step on ${NEO4J_SERIES}`, () => {
  it('orders three steps over two different time properties: equal times pass, and each step compares with the one before it', async () => {
    expect((await run('a', [LINKS, { ...ALSO, ...after }, { ...LINKS, ...after }])).ids).toEqual(['d']);
    expect((await run('a', [LINKS, { ...ALSO, ...after }])).ids).toEqual(['c']);
    expect((await run('a', [LINKS, ALSO, LINKS])).ids).toEqual(['d']);
  });

  it('leaves out a path whose second relationship is earlier, and one whose time is missing or is no date and time, on either step', async () => {
    for (const anchor of ['a2', 'a3', 'a4', 'a5']) {
      expect((await run(anchor, [LINKS, { ...ALSO, ...after }])).ids, anchor).toEqual([]);
      expect((await run(anchor, [LINKS, ALSO])).ids, `${anchor} without the order`).toHaveLength(1);
    }
  });

  it('reports the relationships left out for no usable time whenever an order applies, and not for a chain without one', async () => {
    const [source] = [{ sources: [sourceFor(server, { entities, relationships, derived: [], budgets: {} })] }].flatMap((mapping) => mapping.sources);
    expect(source).toBeDefined();
    const params = (steps: Record<string, unknown>[]) => ({ anchorType: 'maker', stableId: 'a', steps });
    const { allowlistFromMapping } = await import('./allowlist.js');
    const { patternParamsSchema } = await import('./templates/pattern-request.js');
    if (source === undefined) return;
    const list = allowlistFromMapping(source as never);
    const codes = (steps: Record<string, unknown>[]) => patternNoticesOf({ stopListed: false, supernodes: [], bounded: false }, patternRequestOf(list, patternParamsSchema.parse(params(steps)))).map((notice) => notice.code);
    expect(codes([LINKS, { ...ALSO, ...after }])).toContain('undatedExcluded');
    expect(codes([LINKS, ALSO])).not.toContain('undatedExcluded');
  });
});
