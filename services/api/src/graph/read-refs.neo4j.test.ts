import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReadRefsRequest } from '@neburyx/contracts';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { communityAccess } from '../testing/source-access.js';
import { createReadRefsService } from './read-refs-service.js';

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'maker', label: 'XMaker', stable_id: 'makerId' },
  { type: 'tool', label: 'XTool', stable_id: 'toolId' },
];
const relationships = [
  { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' },
  { type: 'SEEN_WITH', from: 'maker', to: 'tool', observed_at: 'seenAt' },
];
const derived = [{ id: 'shared-tool', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 1 }];

const source = () => sourceFor(server, { entities, relationships, derived });
const end = (entityType: string, stableId: string) => ({ sourceId: 'graph', entityType, stableId });

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT x_maker FOR (n:XMaker) REQUIRE n.makerId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX x_tool FOR (n:XTool) ON (n.toolId)');
  await runAdmin(server, 'CREATE INDEX x_use FOR ()-[r:USES_TOOL]-() ON (r.useId)');
  await runAdmin(server, "CREATE (:XMaker {makerId: 'a1'}), (:XMaker {makerId: 'a2'}), (:XTool {toolId: 'd1'})");
  await runAdmin(server, "UNWIND [['a1', 'd1'], ['a2', 'd1']] AS pair MATCH (a:XMaker {makerId: pair[0]}), (d:XTool {toolId: pair[1]}) CREATE (a)-[:USES_TOOL {useId: pair[0] + pair[1]}]->(d)");
  await runAdmin(server, "UNWIND [1, 2, 3] AS i MATCH (a:XMaker {makerId: 'a1'}), (d:XTool {toolId: 'd1'}) CREATE (a)-[:SEEN_WITH {seenAt: datetime('2026-01-0' + toString(i) + 'T10:00:00Z')}]->(d)");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const mapping = { sources: [source()] };
  const defaults = communitySeams();
  parts = createSourceGate({ mapping, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 600_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

function read(request: Partial<ReadRefsRequest>) {
  const mapping = { sources: [source()] };
  const service = createReadRefsService({ gate: parts.gate, mapping, access: communityAccess(mapping), audit: { record: () => Promise.resolve() }, logger: { warn: () => undefined } });
  return service.read({ traceId: 'tr-refs', principal: LOCAL_PRINCIPAL, request: { sourceId: 'graph', entities: [], edges: [], aggregates: [], derived: [], ...request } });
}

describe(`a read by references against a real source, on ${NEO4J_SERIES}`, () => {
  it('returns the entities that exist and lists the others as missing', async () => {
    const answer = await read({ entities: [end('maker', 'a1'), end('maker', 'nobody'), end('tool', 'd1')] });
    expect(answer.nodes.map((node) => node.ref.stableId)).toEqual(['a1', 'd1']);
    expect(answer.missing.entities).toEqual([end('maker', 'nobody')]);
  });

  it('returns a stored edge by its reference, and lists one that does not exist as missing', async () => {
    const found = { sourceId: 'graph', type: 'USES_TOOL', from: 'maker', to: 'tool', stableId: 'a1d1' };
    const absent = { ...found, stableId: 'no-such-use' };
    const answer = await read({ edges: [found, absent] });
    expect(answer.edges.map((edge) => edge.ref)).toEqual([found]);
    expect(answer.missing.edges).toEqual([absent]);
  });

  it('returns an aggregate with its exact member count and range, and lists a pair with no member as missing', async () => {
    const found = { sourceId: 'graph', aggregate: { type: 'SEEN_WITH', from: end('maker', 'a1'), to: end('tool', 'd1') } };
    const absent = { sourceId: 'graph', aggregate: { type: 'SEEN_WITH', from: end('maker', 'a2'), to: end('tool', 'd1') } };
    const answer = await read({ aggregates: [found, absent] });
    expect(answer.edges).toHaveLength(1);
    expect(answer.edges[0]).toMatchObject({ ref: found, memberCount: { value: 3, quality: 'exact', scope: 'aggregate:members' } });
    expect(answer.missing.edges).toEqual([absent]);
  });

  it('returns a derived relationship its rule still finds, with its supports, and lists a pair it does not find as missing', async () => {
    const found = { sourceId: 'graph', derived: { ruleId: 'shared-tool', from: end('maker', 'a1'), to: end('maker', 'a2') } };
    const absent = { sourceId: 'graph', derived: { ruleId: 'shared-tool', from: end('maker', 'a1'), to: end('maker', 'nobody') } };
    const answer = await read({ derived: [found, absent] });
    expect(answer.edges).toHaveLength(1);
    expect(answer.edges[0]).toMatchObject({ ref: found, semantics: 'derived', derivation: { ruleId: 'shared-tool', ruleVersion: 1 } });
    expect(answer.edges[0]?.derivation?.supportingEdgeRefs.length).toBeGreaterThan(0);
    expect(answer.missing.edges).toEqual([absent]);
  });
});
