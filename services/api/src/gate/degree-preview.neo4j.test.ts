import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import { rmSync } from 'node:fs';
import { degreePreviewSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { memoryAppStore } from '../testing/app-store.js';
import { makeWebRoot } from '../testing/web-root.js';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { allowlistFromMapping } from './allowlist.js';
import { createTemplateCatalog } from './catalog.js';
import { judgePlan } from '../source-test/degree-judge.js';
import { profileDegreeRead } from '../testing/degree-plan.js';
import { renderTemplate } from './render.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { DEGREE_PREVIEW_BOUNDED_ID, DEGREE_PREVIEW_CHEAP_ID, degreePreviewBoundedTemplate, degreePreviewCheapTemplate } from './templates/degree-preview.js';

const HUB_RELATIONSHIPS = 100_000;
const CAP = 500;
const PLAN_RELATIONSHIPS = 30_000;

const webRoot = makeWebRoot();
let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'hub', label: 'DegreeHub', stable_id: 'hubId' },
  { type: 'leaf', label: 'DegreeLeaf', stable_id: 'leafId' },
];
const relationships = [
  { type: 'LINKED', from: 'hub', to: 'leaf' },
  { type: 'SEEN_BY', from: 'leaf', to: 'hub' },
];

const source = () => sourceFor(server, { entities, relationships, budgets: { heavy_op_threshold: CAP } });

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT degree_hub FOR (n:DegreeHub) REQUIRE n.hubId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX degree_leaf FOR (n:DegreeLeaf) ON (n.leafId)');
  await runAdmin(server, 'CREATE INDEX degree_hub_plain FOR (n:DegreeHub) ON (n.hubId)').catch(() => undefined);
  await runAdmin(server, "CREATE (:DegreeHub {hubId: 'big'}), (:DegreeHub {hubId: 'exact'}), (:DegreeHub {hubId: 'over'}), (:DegreeHub {hubId: 'empty'}), (:DegreeHub {hubId: '123'})");
  await runAdmin(server, `MATCH (h:DegreeHub {hubId: 'big'}) UNWIND range(1, ${HUB_RELATIONSHIPS}) AS i CREATE (h)-[:LINKED]->(:DegreeLeaf {leafId: 'big' + i})`);
  await runAdmin(server, `MATCH (h:DegreeHub {hubId: 'exact'}) UNWIND range(1, ${CAP}) AS i CREATE (h)-[:LINKED]->(:DegreeLeaf {leafId: 'exact' + i})`);
  await runAdmin(server, `MATCH (h:DegreeHub {hubId: 'over'}) UNWIND range(1, ${CAP + 1}) AS i CREATE (h)-[:LINKED]->(:DegreeLeaf {leafId: 'over' + i})`);
  await runAdmin(server, "MATCH (h:DegreeHub {hubId: 'exact'}) CREATE (:DegreeLeaf {leafId: 'seer'})-[:SEEN_BY]->(h)");
  await runAdmin(server, "CREATE (:DegreeHub {hubId: 'plan-small'}), (:DegreeHub {hubId: 'plan-large'})");
  await runAdmin(server, 'MATCH (h:DegreeHub {hubId: "plan-small"}) UNWIND range(1, 10) AS i CREATE (h)-[:LINKED]->(:DegreeLeaf {leafId: "ps" + i})');
  await runAdmin(server, `MATCH (h:DegreeHub {hubId: 'plan-large'}) UNWIND range(1, ${PLAN_RELATIONSHIPS}) AS i CREATE (h)-[:LINKED]->(:DegreeLeaf {leafId: 'pl' + i})`);
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const mapping = { sources: [source()] };
  const defaults = communitySeams();
  parts = createSourceGate({ mapping, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 900_000);

afterAll(async () => {
  rmSync(webRoot, { recursive: true, force: true });
  await runAll([() => parts?.close(), () => server?.stop()]);
});

async function preview(entityType: string, stableId: string) {
  const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: DEGREE_PREVIEW_BOUNDED_ID, params: { entityType, stableId }, limit: 1 }));
  return page.items[0];
}

describe(`the bounded degree read on ${NEO4J_SERIES}`, () => {
  it('counts a node at zero, at the cap and above it, and says the cap for a count that reached cap plus one', async () => {
    expect(await preview('hub', 'empty')).toEqual({ found: true, counts: [{ value: 0, quality: 'exact' }, { value: 0, quality: 'exact' }], duplicate: false });
    expect(await preview('hub', 'exact')).toEqual({ found: true, counts: [{ value: CAP, quality: 'exact' }, { value: 1, quality: 'exact' }], duplicate: false });
    expect(await preview('hub', 'over')).toMatchObject({ found: true, counts: [{ value: CAP, quality: 'lowerBound' }, { value: 0, quality: 'exact' }] });
  });

  it('answers a node of 100,000 relationships with a lower bound, after reading at most the cap plus one of them', async () => {
    expect(await preview('hub', 'big')).toMatchObject({ found: true, counts: [{ value: CAP, quality: 'lowerBound' }, { value: 0, quality: 'exact' }] });
    const mapping = { sources: [source()] };
    const [model] = mapping.sources;
    if (model === undefined) throw new Error('no source');
    const catalog = createTemplateCatalog({ templates: [degreePreviewBoundedTemplate] });
    const template = catalog.find(DEGREE_PREVIEW_BOUNDED_ID);
    if (template === undefined) throw new Error('no template');
    const rendered = renderTemplate(template, { entityType: 'hub', stableId: 'big', stableInteger: null }, allowlistFromMapping(model), 1, CAP);
    const session = server.admin.session({ database: server.database });
    try {
      const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(1), countCap: neo4j.int(CAP) });
      const hits = (profile: ProfiledPlan | false): number => (profile === false ? 0 : profile.dbHits + profile.children.reduce((sum, child) => sum + hits(child), 0));
      const total = hits(result.summary.profile);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(4 * (CAP + 1));
    } finally {
      await session.close();
    }
  });

  it('finds a node whose stable ID is stored as an integer, and flags it when another node holds the same ID as text', async () => {
    await runAdmin(server, 'CREATE (:DegreeHub {hubId: 9007199254740993})');
    expect(await preview('hub', '9007199254740993')).toMatchObject({ found: true, duplicate: false });
    await runAdmin(server, "CREATE (:DegreeHub {hubId: '9007199254740993'})");
    expect(await preview('hub', '9007199254740993')).toMatchObject({ found: true, duplicate: true });
  });

  it('answers no node for an ID the source does not hold', async () => {
    expect(await preview('hub', 'nobody')).toEqual({ found: false });
  });

  it('reads a leaf by the other pairs of its entity type', async () => {
    expect(await preview('leaf', 'seer')).toEqual({ found: true, counts: [{ value: 0, quality: 'exact' }, { value: 1, quality: 'exact' }], duplicate: false });
  });

  it('counts a node of 30,000 relationships exactly with the cheap read, by the degree of the node and not by expanding it', async () => {
    const [model] = [source()];
    const session = server.admin.session({ database: server.database });
    try {
      const small = await profileDegreeRead(session, degreePreviewCheapTemplate, model, 'hub', 'plan-small', CAP);
      const large = await profileDegreeRead(session, degreePreviewCheapTemplate, model, 'hub', 'plan-large', CAP);
      expect(judgePlan(small.operators)).toEqual({ result: 'cheap', basis: 'degree-operator' });
      expect(judgePlan(large.operators)).toEqual({ result: 'cheap', basis: 'degree-operator' });
      expect(large.dbHits).toBe(small.dbHits);
      expect(large.rows).toHaveLength(1);
    } finally {
      await session.close();
    }
    const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: DEGREE_PREVIEW_CHEAP_ID, params: { entityType: 'hub', stableId: 'plan-large' }, limit: 1 }));
    expect(page.items[0]).toEqual({ found: true, counts: [{ value: PLAN_RELATIONSHIPS, quality: 'exact' }, { value: 0, quality: 'exact' }], duplicate: false });
  });

  it('answers the endpoint with each count and its quality for a node of the real graph', async () => {
    const mapping = { sources: [source()] };
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate });
    const response = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'graph', ref: { entityType: 'hub', stableId: 'over' } } });
    expect(response.statusCode).toBe(200);
    const preview = degreePreviewSchema.parse(response.json());
    expect(preview.byType.map((entry) => `${entry.relationshipType} ${entry.direction} ${entry.count.value} ${entry.count.quality}`)).toEqual([`LINKED out ${CAP} lowerBound`, 'SEEN_BY in 0 exact']);
    expect(preview.total).toMatchObject({ value: CAP, quality: 'lowerBound' });
    await app.close();
  });
});
