import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import type { ExpansionPage } from './normalize/expansion.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import type { ExpandCountItem } from './templates/expand-count.js';
import { EXPAND_COUNT_ID } from './templates/expand-count.js';
import { EXPAND_NEIGHBORS_ID } from './templates/expand-neighbors.js';

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'hub', label: 'WHub', stable_id: 'hubId' },
  { type: 'leaf', label: 'WLeaf', stable_id: 'leafId' },
];
const relationships = [
  { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt' },
  { type: 'NOTED', from: 'hub', to: 'leaf', observed_at: 'seenAt' },
  { type: 'TOUCHED', from: 'hub', to: 'leaf', stable_id: 'touchId' },
];

const MARCH = { windowFrom: '2026-03-01T00:00:00.000Z', windowTo: '2026-04-01T00:00:00.000Z' };

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT w_hub FOR (n:WHub) REQUIRE n.hubId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX w_leaf FOR (n:WLeaf) ON (n.leafId)');
  await runAdmin(
    server,
    `CREATE (h:WHub {hubId: 'h1'})
     CREATE (h)-[:LINKED {relId: 'r01', seenAt: datetime('2026-03-05T10:00:00Z')}]->(:WLeaf {leafId: 'l01'})
     CREATE (h)-[:LINKED {relId: 'r02', seenAt: datetime('2026-03-20T10:00:00Z')}]->(:WLeaf {leafId: 'l02'})
     CREATE (h)-[:LINKED {relId: 'r03', seenAt: datetime('2026-04-02T10:00:00Z')}]->(:WLeaf {leafId: 'l03'})
     CREATE (h)-[:LINKED {relId: 'r04'}]->(:WLeaf {leafId: 'l04'})
     CREATE (h)-[:LINKED {relId: 'r05', seenAt: datetime('2026-03-31T23:59:59Z')}]->(:WLeaf {leafId: 'l05'})
     CREATE (h)-[:LINKED {relId: 'r06', seenAt: datetime('2026-04-01T00:00:00Z')}]->(:WLeaf {leafId: 'l06'})
     CREATE (h)-[:LINKED {relId: 'r07', seenAt: localdatetime('2026-03-15T00:00:00')}]->(:WLeaf {leafId: 'l07'})
     CREATE (h)-[:LINKED {relId: 'r08', seenAt: date('2026-03-16')}]->(:WLeaf {leafId: 'l08'})
     CREATE (h)-[:LINKED {relId: 'r09', seenAt: '2026-03-17T00:00:00Z'}]->(:WLeaf {leafId: 'l09'})
     CREATE (h)-[:LINKED {relId: 'r10', seenAt: 1773705600000}]->(:WLeaf {leafId: 'l10'})
     CREATE (h)-[:LINKED {relId: 'r11', seenAt: datetime('2026-03-01T00:00:00Z')}]->(:WLeaf {leafId: 'l11'})
     CREATE (h)-[:LINKED {relId: 'r12', seenAt: datetime('2026-02-28T23:59:59Z')}]->(:WLeaf {leafId: 'l12'})
     CREATE (h)-[:NOTED {seenAt: datetime('2026-03-10T00:00:00Z')}]->(a6:WLeaf {leafId: 'a6'})
     CREATE (h)-[:NOTED {seenAt: datetime('2026-03-11T00:00:00Z')}]->(a6)
     CREATE (h)-[:NOTED {seenAt: datetime('2026-04-05T00:00:00Z')}]->(a6)
     CREATE (h)-[:NOTED {}]->(:WLeaf {leafId: 'a7'})
     CREATE (h)-[:TOUCHED {touchId: 't1'}]->(:WLeaf {leafId: 't1'})
     CREATE (h)-[:TOUCHED {touchId: 't2'}]->(:WLeaf {leafId: 't2'})`,
  );
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

const base = { entityType: 'hub', stableId: 'h1', neighborType: 'leaf', direction: 'out' };

async function page(relTypes: readonly string[], window: Record<string, string> | undefined, limit = 50) {
  const result = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: EXPAND_NEIGHBORS_ID, params: { ...base, sort: 'observed', relTypes, ...(window ?? {}) }, limit }));
  const item = result.items[0] as unknown as ExpansionPage;
  return { result, item, ids: item.nodes.filter((node) => node.ref.entityType === 'leaf').map((node) => node.ref.stableId).sort() };
}

async function count(relTypes: readonly string[], window: Record<string, string>): Promise<ExpandCountItem> {
  const result = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: EXPAND_COUNT_ID, params: { ...base, relTypes, ...window }, limit: 1 }));
  return result.items[0] as unknown as ExpandCountItem;
}

describe(`an expansion with a window on ${NEO4J_SERIES}`, () => {
  it('keeps the relationships observed from the first instant up to but not including the last, and reads a zoned date time, a local date time and a date as instants', async () => {
    const { ids } = await page(['LINKED'], MARCH);
    expect(ids).toEqual(['l01', 'l02', 'l05', 'l07', 'l08', 'l11']);
  });

  it('leaves out a relationship with no time, and one whose time is text or a number, and the ones outside, at the edges as at the middle', async () => {
    const { ids } = await page(['LINKED'], MARCH);
    for (const out of ['l03', 'l04', 'l06', 'l09', 'l10', 'l12']) expect(ids).not.toContain(out);
  });

  it('reads all of it with no window, as before', async () => {
    expect((await page(['LINKED'], undefined)).ids).toHaveLength(12);
  });

  it('counts the members of an aggregate edge that are in the window only, and leaves out an aggregate with no member in it', async () => {
    const { item, ids } = await page(['NOTED'], MARCH);
    expect(ids).toEqual(['a6']);
    expect(item.edges).toHaveLength(1);
    expect(item.edges[0]?.memberCount).toMatchObject({ value: 2, quality: 'exact' });
  });

  it('does not filter a relationship type that has no observed time', async () => {
    expect((await page(['TOUCHED'], MARCH)).ids).toEqual(['t1', 't2']);
    expect((await page(['LINKED', 'TOUCHED'], MARCH)).ids).toEqual(['l01', 'l02', 'l05', 'l07', 'l08', 'l11', 't1', 't2']);
  });

  it('pages a windowed read by cursor without a row twice or a row lost', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: EXPAND_NEIGHBORS_ID, params: { ...base, sort: 'observed', relTypes: ['LINKED'], ...MARCH }, limit: 2, ...(cursor === undefined ? {} : { cursor }) }));
      const item = result.items[0] as unknown as ExpansionPage;
      seen.push(...item.nodes.filter((node) => node.ref.entityType === 'leaf').map((node) => node.ref.stableId));
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    expect(seen.sort()).toEqual(['l01', 'l02', 'l05', 'l07', 'l08', 'l11']);
  });
});

describe(`the count of an expansion with a window on ${NEO4J_SERIES}`, () => {
  it('counts the relationships in the window and those of a dated type that have no usable time', async () => {
    expect(await count(['LINKED'], MARCH)).toEqual({ total: 6, undated: 3 });
  });

  it('counts the members of an aggregate in the window, and its members with no time', async () => {
    expect(await count(['NOTED'], MARCH)).toEqual({ total: 2, undated: 1 });
  });

  it('counts a type with no observed time in full and no undated for it', async () => {
    expect(await count(['TOUCHED'], MARCH)).toEqual({ total: 2, undated: 0 });
    expect(await count(['LINKED', 'NOTED', 'TOUCHED'], MARCH)).toEqual({ total: 10, undated: 4 });
  });
});
