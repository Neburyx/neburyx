import { rmSync } from 'node:fs';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { makeWebRoot } from '../testing/web-root.js';
import { deriveReferenceKeys } from './keys.js';

const webRoot = makeWebRoot();
const keys = deriveReferenceKeys(Buffer.alloc(32, 5));
const PHONE = '+1-212-555-0188';
const OTHER_PHONE = '+1-212-555-0199';

let server: RunningNeo4j;
let parts: SourceGate;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT phone_unique FOR (n:Handle) REQUIRE n.phoneNumber IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT person_unique FOR (n:Person) REQUIRE n.personId IS UNIQUE');
  await runAdmin(server, 'CREATE (a:Person {personId: "P-1"}), (b:Person {personId: "P-2"}), (p:Handle {phoneNumber: $phone}), (q:Handle {phoneNumber: $other}) CREATE (a)-[:HAS_PHONE]->(p), (b)-[:HAS_PHONE]->(p), (b)-[:HAS_PHONE]->(q)', { phone: PHONE, other: OTHER_PHONE });
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const source = sourceFor(server, {
    entities: [
      { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', search: ['phoneNumber'], pii: [{ property: 'phoneNumber', class: 'phone' }] },
      { type: 'person', label: 'Person', stable_id: 'personId', search: ['personId'] },
    ],
    relationships: [{ type: 'HAS_PHONE', from: 'person', to: 'phone' }],
  });
  const mapping = { sources: [source] };
  parts = createSourceGate({ mapping, env: envFor(server), seams: communitySeams(), logger: { warn: () => undefined }, referenceKeys: keys });
  app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), mapping, gate: parts.gate, indexes: parts.indexes, referenceKeys: keys, closeSources: () => parts.close() });
}, 600_000);

afterAll(async () => {
  await runAll([() => app?.close(), () => server?.stop()]);
  rmSync(webRoot, { recursive: true, force: true });
});

const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

describe(`a type keyed by a personal-data stable ID, on ${NEO4J_SERIES}`, () => {
  it('is found by its value in an unmasked search, with a token as its reference and no value in the reference', async () => {
    const response = await post('/v1/search/entities', { sourceId: 'graph', text: PHONE });
    expect(response.statusCode).toBe(200);
    const [hit] = response.json().exact;
    expect(hit.ref.stableId).toMatch(/^p1\./);
    expect(hit.ref.stableId).not.toContain('555');
    expect(hit.properties.find((property: { key: string }) => property.key === 'phoneNumber').value).toBe(PHONE);
  });

  it('is not searched by its value while masked, and shows no value in any masked answer', async () => {
    const search = await post('/v1/search/entities', { sourceId: 'graph', text: PHONE, mask: true });
    expect(search.statusCode).toBe(200);
    expect(search.json().exact).toEqual([]);
    expect(search.body).not.toContain('555-0188');
  });

  it('is answered by a lookup by body when unmasked, and by its token when masked with the value masked', async () => {
    const lookup = await post('/v1/entities/lookup', { sourceId: 'graph', value: { entityType: 'phone', value: PHONE } });
    expect(lookup.statusCode).toBe(200);
    const { stableId } = lookup.json().ref;
    const masked = await post('/v1/entities/lookup', { sourceId: 'graph', ref: { entityType: 'phone', stableId }, mask: true });
    expect(masked.statusCode).toBe(200);
    expect(masked.body).not.toContain('555-0188');
    const refused = await post('/v1/entities/lookup', { sourceId: 'graph', value: { entityType: 'phone', value: PHONE }, mask: true });
    expect(refused.statusCode).toBe(400);
    const missing = await post('/v1/entities/lookup', { sourceId: 'graph', value: { entityType: 'phone', value: '+1-000' } });
    expect(missing.statusCode).toBe(404);
  });

  it('counts its neighbors through a degree preview by token, with the number the graph holds', async () => {
    const lookup = await post('/v1/entities/lookup', { sourceId: 'graph', value: { entityType: 'phone', value: PHONE } });
    const preview = await post('/v1/graph/preview-expansion', { sourceId: 'graph', ref: { entityType: 'phone', stableId: lookup.json().ref.stableId }, mask: true });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().total).toMatchObject({ value: 2, quality: 'exact' });
    expect(preview.body).not.toContain('555-0188');
  });

  it('opens as an investigation by value, lists and reads back with the token and no value, and a person node is unchanged', async () => {
    const open = await post('/v1/investigations', { sourceId: 'graph', entity: { sourceId: 'graph', entityType: 'phone', value: PHONE } });
    expect(open.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/v1/investigations' });
    expect(list.body).not.toContain('555-0188');
    const person = await post('/v1/entities/lookup', { sourceId: 'graph', value: { entityType: 'person', value: 'P-1' } });
    expect(person.json().ref.stableId).toBe('P-1');
  });
});
