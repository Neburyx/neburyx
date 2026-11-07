import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowlistFromMapping } from './allowlist.js';
import { renderTemplate } from './render.js';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import type { ExpansionPage } from './normalize/expansion.js';
import { EXPAND_NEIGHBORS_ID } from './templates/expand-neighbors.js';

let server: RunningNeo4j;
let parts: SourceGate;
const HUB_RELATIONSHIPS = 100_000;
const PAGE = 25;

const entities = [
  { type: 'hub', label: 'XHub', stable_id: 'hubId' },
  { type: 'leaf', label: 'XLeaf', stable_id: 'leafId' },
];
const relationships = [
  { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt' },
  { type: 'NOTED', from: 'hub', to: 'leaf', observed_at: 'seenAt' },
  { type: 'TIED', from: 'hub', to: 'leaf', stable_id: 'tieId' },
];

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT x_hub FOR (n:XHub) REQUIRE n.hubId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX x_leaf FOR (n:XLeaf) ON (n.leafId)');
  await runAdmin(server, "CREATE (:XHub {hubId: 'h1'}), (:XHub {hubId: 'h2'})");
  await runAdmin(server, "MATCH (h:XHub {hubId: 'h1'}) UNWIND range(1, 12) AS i CREATE (h)-[:LINKED {relId: 'r' + toString(i), seenAt: datetime('2026-03-01T10:00:00.123456789Z') + duration({minutes: i % 4})}]->(:XLeaf {leafId: 'a' + toString(i)})");
  await runAdmin(server, "MATCH (h:XHub {hubId: 'h1'}) UNWIND range(13, 16) AS i CREATE (h)-[:LINKED {relId: 'r' + toString(i)}]->(:XLeaf {leafId: 'a' + toString(i)})");
  await runAdmin(server, "MATCH (h:XHub {hubId: 'h1'}), (l:XLeaf {leafId: 'a1'}) CREATE (h)-[:LINKED {relId: 9007199254740993}]->(l), (h)-[:LINKED {seenAt: datetime('2026-03-01T10:00:00Z')}]->(l)");
  await runAdmin(server, "MATCH (h:XHub {hubId: 'h1'}), (l:XLeaf) WHERE l.leafId IN ['a1','a2','a3'] CREATE (h)-[:NOTED {seenAt: datetime('2026-04-01T00:00:00Z')}]->(l), (h)-[:NOTED {seenAt: datetime('2026-04-02T00:00:00Z')}]->(l), (h)-[:NOTED]->(l)");
  await runAdmin(server, "MATCH (h:XHub {hubId: 'h1'}), (l:XLeaf) WHERE l.leafId IN ['a4','a5'] CREATE (h)-[:NOTED]->(l)");
  await runAdmin(server, "MATCH (h:XHub {hubId: 'h1'}), (l:XLeaf) WHERE l.leafId IN ['a1','a2'] CREATE (h)-[:TIED {tieId: 't' + l.leafId}]->(l)");
  await runAdmin(server, "MATCH (h:XHub {hubId: 'h1'}), (l:XLeaf {leafId: 'a3'}) CREATE (h)-[:TIED {tieId: 'r13'}]->(l)");
  await runAdmin(server, "CREATE (:XHub {hubId: 'h3'})");
  await runAdmin(server, "MATCH (h:XHub {hubId: 'h3'}) UNWIND range(1, 3) AS i CREATE (h)-[:LINKED {relId: 'n' + toString(i), seenAt: datetime('2026-03-01T10:00:00.000000000Z') + duration({nanoseconds: i})}]->(:XLeaf {leafId: 'n' + toString(i)})");
  await runAdmin(server, "CREATE (:XHub {hubId: 'h4'})");
  await runAdmin(server, "MATCH (h:XHub {hubId: 'h4'}) CREATE (h)-[:LINKED {relId: 'k1', seenAt: datetime('2026-03-01T10:00:00Z')}]->(:XLeaf {leafId: 'k1'}), (h)-[:LINKED {relId: 'k2', seenAt: 'a text time'}]->(:XLeaf {leafId: 'k2'}), (h)-[:LINKED {relId: 'k3', seenAt: 42}]->(:XLeaf {leafId: 'k3'}), (h)-[:LINKED {relId: 'k4', seenAt: true}]->(:XLeaf {leafId: 'k4'}), (h)-[:LINKED {relId: 'k5', seenAt: date('2026-03-01')}]->(:XLeaf {leafId: 'k5'}), (h)-[:LINKED {relId: 'k6', seenAt: datetime('2026-03-02T10:00:00Z')}]->(:XLeaf {leafId: 'k6'}), (h)-[:LINKED {relId: 'k7', seenAt: duration('PT1H')}]->(:XLeaf {leafId: 'k7'}), (h)-[:LINKED {relId: 'k8', seenAt: 7.5}]->(:XLeaf {leafId: 'k8'})");
  await runAdmin(server, "CREATE (:XHub {hubId: 'big'})");
  await runAdmin(server, `MATCH (h:XHub {hubId: 'big'}) UNWIND range(1, ${HUB_RELATIONSHIPS}) AS i CREATE (h)-[:LINKED {relId: 'b' + toString(i), seenAt: datetime('2026-01-01T00:00:00Z') + duration({seconds: i})}]->(:XLeaf {leafId: 'b' + toString(i)})`);
  await runAdmin(server, "MATCH (h:XHub {hubId: 'big'}) UNWIND range(1, 10000) AS i MATCH (l:XLeaf {leafId: 'b' + toString(i)}) CREATE (h)-[:NOTED {seenAt: datetime('2026-02-01T00:00:00Z')}]->(l)");
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined }, usability: ALWAYS_USABLE });
}, 900_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

async function page(stableId: string, limit: number, cursor?: string, extra: Record<string, unknown> = {}) {
  const result = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: EXPAND_NEIGHBORS_ID, params: { entityType: 'hub', stableId, neighborType: 'leaf', direction: 'both', sort: 'observed', ...extra }, limit, ...(cursor === undefined ? {} : { cursor }) }));
  const [item] = result.items;
  return { ...result, item: item as unknown as ExpansionPage };
}

async function all(stableId: string, limit: number, extra: Record<string, unknown> = {}) {
  const pages: Awaited<ReturnType<typeof page>>[] = [];
  let cursor: string | undefined;
  do {
    const next = await page(stableId, limit, cursor, extra);
    pages.push(next);
    cursor = next.nextCursor;
  } while (cursor !== undefined);
  return pages;
}

describe(`the expansion read on ${NEO4J_SERIES}`, () => {
  it('pages every relationship of a node once, in a stable order, whatever the page size', async () => {
    const whole = await all('h1', 50);
    const wholeEdges = whole.flatMap((entry) => entry.item.edges.map((edge) => JSON.stringify([edge.type, edge.ref])));
    for (const size of [1, 2, 3, 5, 7]) {
      const pages = await all('h1', size);
      const edges = pages.flatMap((entry) => entry.item.edges.map((edge) => JSON.stringify([edge.type, edge.ref])));
      expect(edges).toEqual(wholeEdges);
      expect(new Set(edges).size).toBe(edges.length);
    }
    expect(wholeEdges.length).toBeGreaterThan(20);
  });

  it('orders the rows by phase, then sort value, ID text, relationship type and direction, all descending', async () => {
    const pages = await all('h1', 50);
    const key = (edge: ExpansionPage['edges'][number]) => ('stableId' in edge.ref ? `${edge.type}:${edge.ref.stableId}` : `${edge.type}:@${'aggregate' in edge.ref ? edge.ref.aggregate.to.stableId : ''}`);
    expect(pages.flatMap((entry) => entry.item.edges.map(key))).toEqual([
      'LINKED:r7', 'LINKED:r3', 'LINKED:r11', 'LINKED:r6', 'LINKED:r2', 'LINKED:r10', 'LINKED:r9', 'LINKED:r5', 'LINKED:r1', 'LINKED:r8', 'LINKED:r4', 'LINKED:r12',
      'NOTED:@a3', 'NOTED:@a2', 'NOTED:@a1', 'LINKED:@a1',
      'TIED:ta2', 'TIED:ta1', 'LINKED:r16', 'LINKED:r15', 'LINKED:r14', 'TIED:r13', 'LINKED:r13', 'LINKED:9007199254740993',
      'NOTED:@a5', 'NOTED:@a4',
    ]);
  });

  it('counts the members of an aggregate over every relationship of its pair and gives the earliest and latest time', async () => {
    const [only] = await all('h1', 50);
    const noted = only?.item.edges.filter((edge) => edge.type === 'NOTED' && 'aggregate' in edge.ref) ?? [];
    const byLeaf = Object.fromEntries(noted.map((edge) => [edge.to.stableId, edge]));
    expect(byLeaf['a1']).toMatchObject({ memberCount: { value: 3, quality: 'exact' }, observedFirst: '2026-04-01T00:00:00Z', observedLast: '2026-04-02T00:00:00Z' });
    expect(byLeaf['a4']).toMatchObject({ memberCount: { value: 1, quality: 'exact' } });
    expect(byLeaf['a4']).not.toHaveProperty('observedFirst');
  });

  it('keeps the fallback aggregate of a relationship with no usable ID, flagged', async () => {
    const [only] = await all('h1', 50);
    const fallback = only?.item.edges.find((edge) => edge.type === 'LINKED' && 'aggregate' in edge.ref);
    expect(fallback).toMatchObject({ qualityFlags: ['no-stable-id'], memberCount: { value: 1, quality: 'exact' } });
  });

  it('reaches every relationship of a node whose sort property holds values of several kinds, whatever the page size', async () => {
    const whole = (await all('h4', 50)).flatMap((entry) => entry.item.edges.map((edge) => ('stableId' in edge.ref ? edge.ref.stableId : '')));
    expect([...whole].sort()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8']);
    for (const size of [1, 2, 3]) {
      const ids = (await all('h4', size)).flatMap((entry) => entry.item.edges.map((edge) => ('stableId' in edge.ref ? edge.ref.stableId : '')));
      expect(ids).toEqual(whole);
    }
  });

  it('orders rows that differ by nanoseconds, across page boundaries, as the server orders them', async () => {
    for (const size of [1, 2, 3]) {
      const edges = (await all('h3', size)).flatMap((entry) => entry.item.edges.map((edge) => ('stableId' in edge.ref ? edge.ref.stableId : '')));
      expect(edges).toEqual(['n3', 'n2', 'n1']);
    }
  });

  it('answers a page of a node of 100,000 relationships with a cursor and a payload bounded by the page', async () => {
    const first = await page('big', PAGE);
    expect(first.item.edges).toHaveLength(PAGE);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();
    expect(first.item.nodes.length).toBeLessThanOrEqual(PAGE + 1);
    expect(JSON.stringify(first.item).length).toBeLessThan(PAGE * 4_000);
    const second = await page('big', PAGE, first.nextCursor);
    const ids = [...first.item.edges, ...second.item.edges].map((edge) => ('stableId' in edge.ref ? edge.ref.stableId : ''));
    expect(new Set(ids).size).toBe(2 * PAGE);
  });

  it('reads a node of 100,000 relationships with a plan that anchors on the stable ID index and returns at most a page and one row', async () => {
    const [model] = [sourceFor(server, { entities, relationships })];
    const catalog = (await import('./assemble.js')).defaultCatalog();
    const template = catalog.find(EXPAND_NEIGHBORS_ID);
    if (template === undefined) throw new Error('no template');
    const allowlist = allowlistFromMapping(model);
    const session = server.admin.session({ database: server.database });
    try {
      for (const cursor of [null, { phase: 1, ts: '2026-02-01T00:00:00Z', tk: 1, id: 'b500', rtype: 'NOTED', dir: 'out', nType: 'leaf' }, { phase: 2, ts: null, tk: null, id: 'b', rtype: 'LINKED', dir: 'out', nType: null }]) {
        const rendered = renderTemplate(template, { entityType: 'hub', stableId: 'big', stableInteger: null, neighborType: 'leaf', direction: 'both', sort: 'observed' }, allowlist, PAGE, 500);
        const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(PAGE), cursor });
        const profile = result.summary.profile;
        const operators = (plan: ProfiledPlan | false): ProfiledPlan[] => (plan === false ? [] : [plan, ...plan.children.flatMap(operators)]);
        const all = operators(profile);
        expect(all.some((operator) => /IndexSeek/.test(operator.operatorType))).toBe(true);
        const root = all[0];
        const rows = root?.arguments['Rows'];
        expect(neo4j.isInt(rows) ? rows.toNumber() : Number(rows ?? 0)).toBeLessThanOrEqual(PAGE + 1);
        expect(result.records.length).toBeLessThanOrEqual(PAGE + 1);
      }
    } finally {
      await session.close();
    }
  });

  it('answers an empty page for a node with no neighbors, and finds the node', async () => {
    const result = await page('h2', 5);
    expect(result.item.anchorFound).toBe(true);
    expect(result.item.edges).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('finds that a node is absent', async () => {
    const result = await page('nobody', 5);
    expect(result.item.anchorFound).toBe(false);
  });
});
