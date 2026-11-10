import { rmSync } from 'node:fs';
import { edgeDetailSchema, edgeRefSegmentOf } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { makeWebRoot } from '../testing/web-root.js';

/** The element IDs of a real server look like `4:<uuid>:<number>`; none of them may be in the answer for an aggregate, whose members have no ID of their own. */
const ELEMENT_ID = /\b\d+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+\b/;

let server: RunningNeo4j;
let parts: SourceGate;
let app: Awaited<ReturnType<typeof buildApp>>;
const webRoot = makeWebRoot();

const entities = [
  { type: 'widget', label: 'AWidget', stable_id: 'widgetId' },
  { type: 'gadget', label: 'AGadget', stable_id: 'gadgetId' },
];
const relationships = [{ type: 'PAID', from: 'widget', to: 'gadget', observed_at: 'seenAt', filterable: ['remark'], evidence: ['recordId'] }];

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT a_widget FOR (n:AWidget) REQUIRE n.widgetId IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT a_gadget FOR (n:AGadget) REQUIRE n.gadgetId IS UNIQUE');
  await runAdmin(server, "CREATE (:AWidget {widgetId: 'W-1'}), (:AGadget {gadgetId: 'GD-1'})");
  await runAdmin(server, "MATCH (w:AWidget {widgetId: 'W-1'}), (g:AGadget {gadgetId: 'GD-1'}) UNWIND range(1, 30) AS i CREATE (w)-[:PAID {seenAt: datetime('2026-01-01T00:00:00Z') + duration({minutes: i}), remark: 'r' + toString(i), recordId: 'REC-' + toString(i)}]->(g)");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit };
  const mapping = { sources: [sourceFor(server, { entities, relationships })] };
  parts = createSourceGate({ mapping, env: envFor(server), seams, logger: { warn: () => undefined } });
  app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
}, 300_000);

afterAll(async () => {
  rmSync(webRoot, { recursive: true, force: true });
  await runAll([() => app?.close(), () => parts?.close(), () => server?.stop()]);
});

describe(`the evidence of an aggregate relationship read from a real graph on ${NEO4J_SERIES}`, () => {
  it('holds the exact count and the sample, and no element ID, record ID or member reference anywhere in the answer', async () => {
    const ref = { sourceId: 'graph', aggregate: { type: 'PAID', from: { sourceId: 'graph', entityType: 'widget', stableId: 'W-1' }, to: { sourceId: 'graph', entityType: 'gadget', stableId: 'GD-1' } } };
    const session = server.admin.session({ database: server.database });
    const issued = new Set<string>();
    try {
      const found = await session.run('MATCH (a)-[r:PAID]->(b) RETURN elementId(r) AS r, elementId(a) AS a, elementId(b) AS b');
      for (const record of found.records) for (const key of ['r', 'a', 'b']) issued.add(String(record.get(key)));
    } finally {
      await session.close();
    }
    expect(issued.size, 'the server holds the element IDs of the members and of both ends').toBeGreaterThan(30);
    for (const mask of ['', '?mask=true']) {
      const response = await app.inject({ method: 'GET', url: `/v1/edges/${edgeRefSegmentOf(ref)}${mask}` });
      expect(response.statusCode, response.body).toBe(200);
      const detail = edgeDetailSchema.parse(response.json());
      expect(detail.semantics).toBe('aggregate');
      if (detail.semantics !== 'aggregate') return;
      expect(detail.members).toMatchObject({ value: 30, quality: 'exact' });
      expect(detail.sample.rows.length).toBeGreaterThan(0);
      for (const id of issued) expect(response.body, `the element ID ${id}`).not.toContain(id);
      expect(response.body).not.toMatch(ELEMENT_ID);
      expect(response.body).not.toMatch(/elementId|REC-\d/i);
    }
  });
});
