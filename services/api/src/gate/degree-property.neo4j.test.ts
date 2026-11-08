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
import { createSourceGate, type SourceGate } from './source-gate.js';
import { DEGREE_PREVIEW_BOUNDED_ID, DEGREE_PREVIEW_CHEAP_ID } from './templates/degree-preview.js';

const CAP = 5;
const webRoot = makeWebRoot();
let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'hub', label: 'PropHub', stable_id: 'hubId', degree: [{ type: 'LINKED', direction: 'out', property: 'linkDegree', observed_at: 'linkDegreeAt' }] },
  { type: 'leaf', label: 'PropLeaf', stable_id: 'leafId' },
];
const relationships = [{ type: 'LINKED', from: 'hub', to: 'leaf' }];
const mapping = () => ({ sources: [sourceFor(server, { entities, relationships, budgets: { heavy_op_threshold: CAP } })] });

/** One hub with `degree` relationships and the given property clause, written in Cypher, so each value kind is stored as the source would store it. */
async function hub(id: string, degree: number, properties = ''): Promise<void> {
  await runAdmin(server, `CREATE (h:PropHub {hubId: '${id}'${properties === '' ? '' : `, ${properties}`}}) WITH h UNWIND range(1, ${degree}) AS i CREATE (h)-[:LINKED]->(:PropLeaf {leafId: '${id}-' + i})`);
}

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT prop_hub FOR (n:PropHub) REQUIRE n.hubId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX prop_leaf FOR (n:PropLeaf) ON (n.leafId)');
  await hub('estimated', CAP + 1, 'linkDegree: 1200');
  await hub('under', 3, 'linkDegree: 9999');
  await hub('exact', CAP, 'linkDegree: 9999');
  await hub('equal', CAP + 1, `linkDegree: ${CAP}`);
  await hub('absent', CAP + 1);
  await hub('float', CAP + 1, 'linkDegree: 1200.0');
  const dated: readonly (readonly [string, string])[] = [
    ['dt', "datetime('2026-01-02T03:04:05Z')"],
    ['d', "date('2026-01-02')"],
    ['ldt', "localdatetime('2026-01-02T03:04:05')"],
    ['text', "'batch 7'"],
    ['empty', "''"],
    ['duration', "duration('P3D')"],
    ['time', "time('03:04:05Z')"],
    ['localtime', "localtime('03:04:05')"],
    ['number', '20260102'],
    ['big', '9007199254740993'],
    ['list', "['2026-01-02']"],
    ['point', 'point({x: 1, y: 2})'],
  ];
  for (const [kind, value] of dated) await hub(`dated-${kind}`, CAP + 1, `linkDegree: 1200, linkDegreeAt: ${value}`);
  await hub('dated-null', CAP + 1, 'linkDegree: 1200');
  const bad: readonly (readonly [string, string])[] = [
    ['text', "'many'"],
    ['bool', 'true'],
    ['list', '[9999]'],
    ['fraction', '1200.5'],
    ['negative', '-4'],
    ['zero', '0'],
    ['big', '9007199254740993'],
  ];
  for (const [kind, value] of bad) await hub(`bad-${kind}`, CAP + 1, `linkDegree: ${value}, linkDegreeAt: date('2026-01-02')`);
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: mapping(), env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 300_000);

afterAll(async () => {
  rmSync(webRoot, { recursive: true, force: true });
  await runAll([() => parts?.close(), () => server?.stop()]);
});

async function read(stableId: string, templateId = DEGREE_PREVIEW_BOUNDED_ID) {
  const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId, params: { entityType: 'hub', stableId }, limit: 1 }));
  return page.items[0];
}

describe(`a declared degree property on ${NEO4J_SERIES}`, () => {
  it('is taken as an estimate by a node whose live read stopped at the cap', async () => {
    expect(await read('estimated')).toEqual({ found: true, counts: [{ value: 1200, quality: 'estimated', provenFloor: CAP }], duplicate: false });
  });

  it('is not taken by a node whose live count is exact, whatever it holds', async () => {
    expect(await read('under')).toMatchObject({ counts: [{ value: 3, quality: 'exact' }] });
    expect(await read('exact')).toMatchObject({ counts: [{ value: CAP, quality: 'exact' }] });
  });

  it('is not taken when it is only the cap, or when the node has none', async () => {
    expect(await read('equal')).toMatchObject({ counts: [{ value: CAP, quality: 'lowerBound' }] });
    expect(await read('absent')).toMatchObject({ counts: [{ value: CAP, quality: 'lowerBound' }] });
  });

  it('is taken as a whole number when the source stored it as a float with a whole value', async () => {
    expect(await read('float')).toMatchObject({ counts: [{ value: 1200, quality: 'estimated' }] });
  });

  it('is not read by the cheap read, which counts exactly', async () => {
    expect(await read('estimated', DEGREE_PREVIEW_CHEAP_ID)).toEqual({ found: true, counts: [{ value: CAP + 1, quality: 'exact' }], duplicate: false });
  });

  it.each([
    ['dt', '2026-01-02T03:04:05Z'],
    ['d', '2026-01-02'],
    ['ldt', '2026-01-02T03:04:05'],
    ['text', 'batch 7'],
  ])('carries a stored date of kind %s as its text', async (kind, text) => {
    expect(await read(`dated-${kind}`)).toEqual({ found: true, counts: [{ value: 1200, quality: 'estimated', provenFloor: CAP, observedAt: text }], duplicate: false });
  });

  it.each(['empty', 'duration', 'time', 'localtime', 'number', 'big', 'list', 'point', 'null'])('leaves the date out, and keeps the estimate, when the stored date is %s', async (kind) => {
    expect(await read(`dated-${kind}`)).toEqual({ found: true, counts: [{ value: 1200, quality: 'estimated', provenFloor: CAP }], duplicate: false });
  });

  it.each(['text', 'bool', 'list', 'fraction', 'negative', 'zero', 'big'])('keeps the lower bound, and flags the property, when it holds %s', async (kind) => {
    expect(await read(`bad-${kind}`)).toEqual({ found: true, counts: [{ value: CAP, quality: 'lowerBound', propertyIgnored: true }], duplicate: false });
  });

  it('is answered by the endpoint as an estimated count of the real graph', async () => {
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: mapping(), gate: parts.gate });
    const response = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'graph', ref: { entityType: 'hub', stableId: 'estimated' } } });
    expect(response.statusCode).toBe(200);
    const preview = degreePreviewSchema.parse(response.json());
    expect(preview.byType.map((entry) => `${entry.relationshipType} ${entry.direction} ${entry.count.value} ${entry.count.quality}`)).toEqual(['LINKED out 1200 estimated']);
    expect(preview.total).toMatchObject({ value: 1200, quality: 'estimated' });
    await app.close();
  });

  it('is answered by the endpoint with its date, and an ignored value as a warning that holds neither the value nor the key', async () => {
    const lines: string[] = [];
    const app = await buildApp({ webRoot, logger: createLogger({ write: (line) => lines.push(String(line)) }), store: memoryAppStore(), mapping: mapping(), gate: parts.gate });
    const ask = async (stableId: string) => degreePreviewSchema.parse((await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'graph', ref: { entityType: 'hub', stableId } } })).json());
    const dated = await ask('dated-dt');
    expect(dated.byType[0]?.count).toMatchObject({ value: 1200, quality: 'estimated', observedAt: '2026-01-02T03:04:05Z' });
    const ignored = await ask('bad-text');
    expect(ignored.byType[0]?.count).toMatchObject({ value: CAP, quality: 'lowerBound' });
    expect(ignored.warnings.filter((warning) => warning.code === 'degree-property-ignored')).toHaveLength(1);
    expect(JSON.stringify([ignored, lines])).not.toMatch(/many|linkDegree/);
    await app.close();
  });
});
