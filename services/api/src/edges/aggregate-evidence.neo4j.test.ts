import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGGREGATE_SAMPLE_SIZE, type AggregateEdgeRef } from '@neburyx/contracts';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID } from '../gate/templates/aggregate-evidence.js';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { communityAccess } from '../testing/source-access.js';
import { createEdgeReader } from './edge-reader.js';

const MEMBERS = 100_000;
const PLAIN_MEMBERS = 100_000;
const READ_TIMEOUT_MS = 5000;

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId' },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
];
const relationships = [
  { type: 'PAID', from: 'widget', to: 'gadget', observed_at: 'seenAt', filterable: ['remark', 'n'], evidence: ['recordId'] },
  { type: 'PLAIN', from: 'widget', to: 'gadget', filterable: ['n'] },
  { type: 'PARTLY', from: 'widget', to: 'gadget', stable_id: 'linkId', observed_at: 'seenAt', filterable: ['n'] },
];

const source = (budgets: Record<string, unknown> = {}) => sourceFor(server, { entities, relationships, budgets });

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT widget_unique FOR (n:Widget) REQUIRE n.widgetId IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT gadget_unique FOR (n:Gadget) REQUIRE n.gadgetId IS UNIQUE');
  await runAdmin(server, "CREATE (:Widget {widgetId: 'W-1'}), (:Gadget {gadgetId: 'GD-1'})");
  await runAdmin(server, "UNWIND range(1, $members) AS i CALL { WITH i MATCH (w:Widget {widgetId: 'W-1'}), (g:Gadget {gadgetId: 'GD-1'}) CREATE (w)-[:PAID {seenAt: datetime('2026-01-01T00:00:00Z') + duration({seconds: i}), remark: 'web', n: i, recordId: 'SECRET-' + i}]->(g) } IN TRANSACTIONS OF 10000 ROWS", { members: MEMBERS });
  await runAdmin(server, "UNWIND range(1, $members) AS i CALL { WITH i MATCH (w:Widget {widgetId: 'W-1'}), (g:Gadget {gadgetId: 'GD-1'}) CREATE (w)-[:PLAIN {n: i}]->(g) } IN TRANSACTIONS OF 10000 ROWS", { members: PLAIN_MEMBERS });
  await runAdmin(server, "MATCH (w:Widget {widgetId: 'W-1'}), (g:Gadget {gadgetId: 'GD-1'}) CREATE (w)-[:PARTLY {linkId: 'L-1', n: 1}]->(g), (w)-[:PARTLY {n: 2, seenAt: datetime('2026-03-01T00:00:00Z')}]->(g), (w)-[:PARTLY {linkId: '', n: 3, seenAt: datetime('2026-02-01T00:00:00Z')}]->(g)");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [source()] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 900_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

const refOf = (type: string): AggregateEdgeRef => ({ sourceId: 'graph', aggregate: { type, from: { sourceId: 'graph', entityType: 'widget', stableId: 'W-1' }, to: { sourceId: 'graph', entityType: 'gadget', stableId: 'GD-1' } } });

function read(type: string) {
  const mapping = { sources: [source()] };
  return createEdgeReader({ gate: parts.gate, mapping, access: communityAccess(mapping) }).read({ traceId: 'tr-aggregate', principal: LOCAL_PRINCIPAL, ref: refOf(type), mask: false });
}

describe(`an aggregate read through the gate, on ${NEO4J_SERIES}`, () => {
  it('answers a 100,000-member aggregate within the read timeout: the exact count, 25 sampled members newest first and the rest as more, with no record value', async () => {
    const started = performance.now();
    const detail = await read('PAID');
    const elapsed = Math.round(performance.now() - started);
    process.stderr.write(`aggregate read of ${MEMBERS} members: ${elapsed} ms for the sample and the count together (read timeout ${READ_TIMEOUT_MS} ms)\n`);
    expect(elapsed).toBeLessThan(READ_TIMEOUT_MS);
    expect(detail.semantics).toBe('aggregate');
    if (detail.semantics !== 'aggregate') return;
    expect(detail.members).toEqual({ value: MEMBERS, quality: 'exact', scope: 'aggregate:members' });
    expect(detail.sample.order).toBe('observed-newest');
    expect(detail.sample.rows).toHaveLength(AGGREGATE_SAMPLE_SIZE);
    expect(detail.sample.more).toBe(MEMBERS - AGGREGATE_SAMPLE_SIZE);
    expect(detail.sample.rows[0]?.observedAt).toBe('2026-01-02T03:46:40Z');
    expect(detail.sample.rows.map((row) => row.properties.find((property) => property.key === 'n')?.value)).toEqual(Array.from({ length: AGGREGATE_SAMPLE_SIZE }, (_unused, index) => MEMBERS - index));
    expect(detail.observedFirst).toBe('2026-01-01T00:00:01Z');
    expect(detail.observedLast).toBe('2026-01-02T03:46:40Z');
    expect(JSON.stringify(detail)).not.toContain('SECRET');
  }, 120_000);

  it('measures the count and range read, the sorted sample read and the unsorted sample read alone on the 100,000 members', async () => {
    const params = { type: 'PAID', ends: [{ sourceId: 'graph', entityType: 'widget', stableId: 'W-1' }, { sourceId: 'graph', entityType: 'gadget', stableId: 'GD-1' }] };
    const timeOf = async (templateId: string, given: unknown, limit: number): Promise<number> => {
      const started = performance.now();
      await parts.gate.run(gateRequest({ sourceId: 'graph', templateId, params: given, limit }));
      return Math.round(performance.now() - started);
    };
    const count = await timeOf(AGGREGATE_SUMMARY_ID, params, 1);
    const sorted = await timeOf(AGGREGATE_SAMPLE_ID, params, AGGREGATE_SAMPLE_SIZE);
    const unsorted = await timeOf(AGGREGATE_SAMPLE_ID, { ...params, type: 'PLAIN' }, AGGREGATE_SAMPLE_SIZE);
    process.stderr.write(`100,000 members through the gate: count and range ${count} ms, sorted sample ${sorted} ms; the unsorted sample of a type with no observed time ${unsorted} ms\n`);
    expect(Math.max(count, sorted)).toBeLessThan(READ_TIMEOUT_MS / 2);
  }, 120_000);

  it('samples a type that maps no observed time in the source\'s order, which is the first members the source returns', async () => {
    const detail = await read('PLAIN');
    if (detail.semantics !== 'aggregate') throw new Error('not an aggregate');
    expect(detail.sample.order).toBe('source-order');
    expect(detail.sample.rows).toHaveLength(AGGREGATE_SAMPLE_SIZE);
    expect(detail.members).toMatchObject({ value: PLAIN_MEMBERS, quality: 'exact' });
    expect(detail.observedFirst).toBeUndefined();
  }, 120_000);

  it('gives the same sample when read twice', async () => {
    const [first, second] = [await read('PAID'), await read('PAID')];
    expect(second).toEqual(first);
  }, 120_000);

  it('reads only the members with no usable ID of a type that has a stable_id, and flags the answer', async () => {
    const detail = await read('PARTLY');
    if (detail.semantics !== 'aggregate') throw new Error('not an aggregate');
    expect(detail.members).toMatchObject({ value: 2, quality: 'exact' });
    expect(detail.qualityFlags).toContain('no-stable-id');
    expect(detail.sample.rows.map((row) => row.observedAt)).toEqual(['2026-03-01T00:00:00Z', '2026-02-01T00:00:00Z']);
  }, 120_000);
});
