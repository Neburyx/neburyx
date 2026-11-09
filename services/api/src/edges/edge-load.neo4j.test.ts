import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredEdgeRef } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { communityAccess } from '../testing/source-access.js';
import { createEdgeReader } from './edge-reader.js';

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId' },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
];
const relationships = [
  { type: 'LINKS', from: 'widget', to: 'gadget', stable_id: 'linkId', observed_at: 'seenAt', evidence: ['recordId'] },
  { type: 'BARE', from: 'widget', to: 'gadget', stable_id: 'linkId' },
  { type: 'NOIDX', from: 'widget', to: 'gadget', stable_id: 'linkId' },
];

const source = () => sourceFor(server, { entities, relationships });

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT widget_unique FOR (n:Widget) REQUIRE n.widgetId IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT gadget_unique FOR (n:Gadget) REQUIRE n.gadgetId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX links_id FOR ()-[r:LINKS]-() ON (r.linkId)');
  await runAdmin(server, 'CREATE INDEX links_record FOR ()-[r:LINKS]-() ON (r.recordId)');
  await runAdmin(server, 'CREATE INDEX bare_id FOR ()-[r:BARE]-() ON (r.linkId)');
  await runAdmin(server, "CREATE (w:Widget {widgetId: 'W-1'}), (g:Gadget {gadgetId: 'GD-1'}) CREATE (w)-[:LINKS {linkId: 'L-1', recordId: 'R-1', seenAt: datetime('2026-10-21T08:15:00Z')}]->(g), (w)-[:LINKS {linkId: 9007199254740993, recordId: 'R-2'}]->(g), (w)-[:LINKS {linkId: 'LD1', recordId: 'R-3'}]->(g), (w)-[:LINKS {linkId: 'LD1', recordId: 'R-4'}]->(g), (w)-[:BARE {linkId: 'LB1'}]->(g), (w)-[:NOIDX {linkId: 'LN1'}]->(g)");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const mapping = { sources: [source()] };
  const defaults = communitySeams();
  parts = createSourceGate({ mapping, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 600_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

const refOf = (type: string, stableId: string): StoredEdgeRef => ({ sourceId: 'graph', type, from: 'widget', to: 'gadget', stableId });

function read(ref: StoredEdgeRef) {
  const mapping = { sources: [source()] };
  return createEdgeReader({ gate: parts.gate, mapping, access: communityAccess(mapping) }).read({ traceId: 'tr-edge', principal: LOCAL_PRINCIPAL, ref, mask: false });
}

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
};

describe(`a stored edge read by its reference, on ${NEO4J_SERIES}`, () => {
  it('finds the edge with its two ends, its time and its record', async () => {
    const detail = await read(refOf('LINKS', 'L-1'));
    expect(detail.ref).toEqual(refOf('LINKS', 'L-1'));
    expect([detail.from.ref.stableId, detail.to.ref.stableId]).toEqual(['W-1', 'GD-1']);
    expect(detail.observedAt).toBe('2026-10-21T08:15:00Z');
    expect(detail.evidence).toEqual({ status: 'available', records: [{ sourceRecordId: 'R-1', linkable: false }] });
  });

  it('finds an edge whose stable ID is an integer above the safe JavaScript range by its text', async () => {
    const detail = await read(refOf('LINKS', '9007199254740993'));
    expect(detail.evidence).toEqual({ status: 'available', records: [{ sourceRecordId: 'R-2', linkable: false }] });
  });

  it('flags the first of two edges that share a type, ends and stable ID', async () => {
    const detail = await read(refOf('LINKS', 'LD1'));
    expect(detail.qualityFlags).toContain('conflicting-duplicate');
  });

  it('answers the not-available state for an edge of a type with no evidence property', async () => {
    const detail = await read(refOf('BARE', 'LB1'));
    expect(detail.evidence).toEqual({ status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' });
  });

  it('answers NOT_FOUND for a stable ID the source does not hold', async () => {
    expect(await codeOf(read(refOf('LINKS', 'L-404')))).toBe('NOT_FOUND');
  });

  it('refuses the read before any data is read when the stable ID property has no index', async () => {
    const failure = await read(refOf('NOIDX', 'LN1')).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'index-unavailable' });
  });
});
