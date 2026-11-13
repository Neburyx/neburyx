import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedLinked } from './normalize/linked-entities.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { LINKED_ENTITIES_ID } from './templates/linked-entities.js';

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'maker', label: 'CMaker', stable_id: 'makerId' },
  { type: 'tool', label: 'CTool', stable_id: 'toolId' },
  { type: 'shop', label: 'CShop', stable_id: 'shopId' },
];
const relationships = [
  { type: 'USES', from: 'maker', to: 'tool', stable_id: 'useId', observed_at: 'seenAt' },
  { type: 'STOCKED_AT', from: 'tool', to: 'shop' },
];
const derived = [{ id: 'shared-tool', from: 'maker', to: 'maker', via: ['USES', 'tool', 'USES'], rule_version: 1, stop_list_property: 'isCommon' }];

const uses = (maker: string, tool: string, seenAt: string): string => `MATCH (m:CMaker {makerId: '${maker}'}), (t:CTool {toolId: '${tool}'}) CREATE (m)-[:USES {useId: '${maker}-${tool}', seenAt: ${seenAt}}]->(t)`;
const stocked = (tool: string, shop: string): string => `MATCH (t:CTool {toolId: '${tool}'}), (s:CShop {shopId: '${shop}'}) CREATE (t)-[:STOCKED_AT]->(s)`;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT c_maker FOR (n:CMaker) REQUIRE n.makerId IS UNIQUE');
  await runAdmin(server, "UNWIND ['m0', 'm1'] AS id CREATE (:CMaker {makerId: id})");
  await runAdmin(server, "UNWIND ['t1', 't3'] AS id CREATE (:CTool {toolId: id})");
  await runAdmin(server, "CREATE (:CTool {toolId: 't2', isCommon: true})");
  await runAdmin(server, "UNWIND ['s1', 's2', 's3'] AS id CREATE (:CShop {shopId: id})");
  await runAdmin(server, uses('m0', 't1', "datetime('2026-01-10T00:00:00Z')"));
  await runAdmin(server, uses('m0', 't2', "datetime('2026-01-11T00:00:00Z')"));
  await runAdmin(server, uses('m0', 't3', "datetime('2026-03-01T00:00:00Z')"));
  for (const [tool, shop] of [['t1', 's1'], ['t2', 's2'], ['t3', 's3'], ['t3', 's3']] as const) await runAdmin(server, stocked(tool, shop));
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, derived })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

async function run(extra: Record<string, unknown> = {}) {
  const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: LINKED_ENTITIES_ID, params: { entityType: 'maker', stableId: 'm0', targetType: 'shop', via: ['USES', 'STOCKED_AT'], direction: 'out', maxHops: 2, ...extra }, limit: 25 }));
  const [item] = page.items;
  if (!isNormalizedLinked(item)) throw new Error('the read gave no linked-entities result');
  return { item, ids: item.matches.map((entry) => entry.match.stableId) };
}

describe(`the linked-entities run through an entity that is not the target, on ${NEO4J_SERIES}`, () => {
  it('chains two relationship types, names the entity in between and does not traverse a stop-listed one', async () => {
    const { ids, item } = await run();
    expect(ids).toEqual(['s1', 's3']);
    expect(item.matches.map((entry) => entry.through?.stableId)).toEqual(['t1', 't3']);
    expect(item.matches.every((entry) => entry.hops === 2)).toBe(true);
    expect(item.stopListed).toBe(true);
  });

  it('answers an aggregate edge, with its members counted, for the relationship type that has no stable ID', async () => {
    const { item } = await run();
    const aggregate = item.edges.filter((edge) => edge.type === 'STOCKED_AT');
    expect(aggregate).toHaveLength(2);
    expect(aggregate.find((edge) => edge.to.stableId === 's1')?.memberCount).toMatchObject({ value: 1, quality: 'exact' });
    expect(aggregate.find((edge) => edge.to.stableId === 's3')?.memberCount).toMatchObject({ value: 2, quality: 'exact' });
  });

  it('applies a window to the hop whose type has a time and not to the other, and leaves the later one out', async () => {
    const { ids } = await run({ windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' });
    expect(ids).toEqual(['s1']);
  });
});
