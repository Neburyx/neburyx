import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedLinked } from './normalize/linked-entities.js';
import { isNormalizedLinkedCount } from './normalize/linked-entities-count.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { LINKED_ENTITIES_ID } from './templates/linked-entities.js';
import { LINKED_ENTITIES_COUNT_ID } from './templates/linked-entities-count.js';

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'maker', label: 'FMaker', stable_id: 'makerId' },
  { type: 'tool', label: 'FTool', stable_id: 'toolId' },
  { type: 'shop', label: 'FShop', stable_id: 'shopId' },
];
/** Two shapes of a chain whose target is two steps from the anchor: the first relationship has a stable ID and a time and the second none (a maker uses a tool that a shop stocks), and the same chain with the first relationship stored the other way round (a tool is filed by a maker and sits under a shop). */
const relationships = [
  { type: 'USES', from: 'maker', to: 'tool', stable_id: 'useId', observed_at: 'seenAt' },
  { type: 'STOCKS', from: 'tool', to: 'shop' },
  { type: 'NOTED_BY', from: 'tool', to: 'maker', stable_id: 'noteId', observed_at: 'notedAt' },
  { type: 'UNDER', from: 'tool', to: 'shop' },
];

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT f_maker FOR (n:FMaker) REQUIRE n.makerId IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT f_tool FOR (n:FTool) REQUIRE n.toolId IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT f_shop FOR (n:FShop) REQUIRE n.shopId IS UNIQUE');
  await runAdmin(server, "UNWIND ['m0', 'm1'] AS id CREATE (:FMaker {makerId: id})");
  await runAdmin(server, "UNWIND ['t1', 't2', 't3'] AS id CREATE (:FTool {toolId: id})");
  await runAdmin(server, "UNWIND ['s1', 's2'] AS id CREATE (:FShop {shopId: id})");
  const q = (text: string): Promise<void> => runAdmin(server, text);
  for (const [maker, tool] of [['m0', 't1'], ['m0', 't2'], ['m1', 't3']] as const) await q(`MATCH (m:FMaker {makerId: '${maker}'}), (t:FTool {toolId: '${tool}'}) CREATE (m)-[:USES {useId: '${maker}${tool}', seenAt: datetime('2026-01-10T00:00:00Z')}]->(t), (t)-[:NOTED_BY {noteId: 'f${maker}${tool}', notedAt: datetime('2026-01-10T00:00:00Z')}]->(m)`);
  for (const [tool, shop] of [['t1', 's1'], ['t1', 's1'], ['t2', 's2'], ['t3', 's2']] as const) await q(`MATCH (t:FTool {toolId: '${tool}'}), (s:FShop {shopId: '${shop}'}) CREATE (t)-[:STOCKS]->(s), (t)-[:UNDER]->(s)`);
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

interface Case {
  readonly name: string;
  readonly params: Record<string, unknown>;
  readonly matches: readonly string[];
  /** The hop every match is found at; two unless the target is next to the anchor in one of the listed steps. */
  readonly hops?: number;
}

const CASES: readonly Case[] = [
  { name: 'out, the first relationship with a stable ID, then one without', params: { entityType: 'maker', stableId: 'm0', targetType: 'shop', via: ['USES', 'STOCKS'], direction: 'out', maxHops: 2 }, matches: ['s1', 's2'] },
  { name: 'both, the same chain', params: { entityType: 'maker', stableId: 'm0', targetType: 'shop', via: ['USES', 'STOCKS'], direction: 'both', maxHops: 2 }, matches: ['s1', 's2'] },
  { name: 'in, from the far end', params: { entityType: 'shop', stableId: 's1', targetType: 'maker', via: ['USES', 'STOCKS'], direction: 'in', maxHops: 2 }, matches: ['m0'] },
  { name: 'both, from the far end', params: { entityType: 'shop', stableId: 's2', targetType: 'maker', via: ['USES', 'STOCKS'], direction: 'both', maxHops: 2 }, matches: ['m0', 'm1'] },
  { name: 'both, the first relationship stored the other way round', params: { entityType: 'maker', stableId: 'm0', targetType: 'shop', via: ['NOTED_BY', 'UNDER'], direction: 'both', maxHops: 2 }, matches: ['s1', 's2'] },
  { name: 'out, from the tool side, where the target is next to the anchor in one step', params: { entityType: 'tool', stableId: 't3', targetType: 'shop', via: ['NOTED_BY', 'UNDER'], direction: 'out', maxHops: 2 }, matches: ['s2'], hops: 1 },
];

describe(`a linked-entities run whose target is two steps from the anchor, through two relationship types, on ${NEO4J_SERIES}`, () => {
  it.each(CASES.map((entry) => [entry.name, entry] as const))('reads the matches, %s', async (_name, entry) => {
    const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: LINKED_ENTITIES_ID, params: entry.params, limit: 25 }));
    const [item] = page.items;
    if (!isNormalizedLinked(item)) throw new Error('the read gave no linked-entities result');
    expect(item.matches.map((match) => match.match.stableId).sort()).toEqual([...entry.matches].sort());
    expect(item.matches.every((match) => match.hops === (entry.hops ?? 2))).toBe(true);
  });

  it.each(CASES.map((entry) => [entry.name, entry] as const))('counts the matches, %s', async (_name, entry) => {
    const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: LINKED_ENTITIES_COUNT_ID, params: entry.params, limit: 1 }));
    const [item] = page.items;
    if (!isNormalizedLinkedCount(item)) throw new Error('the read gave no count');
    expect(item.matches).toBe(entry.matches.length);
  });

  it('answers the aggregate relationship of the second step with the members it counted, for the chain whose second relationship has no stable ID', async () => {
    const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: LINKED_ENTITIES_ID, params: CASES[0]?.params ?? {}, limit: 25 }));
    const [item] = page.items;
    if (!isNormalizedLinked(item)) throw new Error('the read gave no linked-entities result');
    const aggregate = item.edges.filter((edge) => edge.type === 'STOCKS');
    expect(aggregate.find((edge) => edge.to.stableId === 's1')?.memberCount).toMatchObject({ value: 2, quality: 'exact' });
    expect(aggregate.find((edge) => edge.to.stableId === 's2')?.memberCount).toMatchObject({ value: 1, quality: 'exact' });
  });

  it('refuses a one-hop run whose target is not next to the anchor, as an invalid request and not a failed statement', async () => {
    const params = { entityType: 'maker', stableId: 'm0', targetType: 'shop', via: ['USES', 'STOCKS'], direction: 'out', maxHops: 1 };
    await expect(parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: LINKED_ENTITIES_ID, params, limit: 25 }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
