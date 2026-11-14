import type { Login } from '@neburyx/test-neo4j';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { buildApp } from '../../../services/api/src/app.js';
import { fileQueryDepsOf } from '../../../services/api/src/gate/file-query.js';
import { createSourceGate, type SourceGate } from '../../../services/api/src/gate/source-gate.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { communitySeams } from '../../../services/api/src/seams/community-seams.js';
import { makeAskFolder, removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { memoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../../../services/api/src/testing/neo4j-server.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';
import type { AuditEvent } from '@neburyx/contracts';
import { handFolder, reply } from './fixtures.js';
import { recordingRunStore, JSON_HEADERS } from './rig.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

const entities = [{ type: 'person', label: 'XPerson', stable_id: 'pid' }];
const relationships = [{ type: 'XKNOWS', from: 'person', to: 'person' }];
const WRITES: Readonly<Record<string, string>> = {
  create: 'MATCH (a:XPerson {pid: $id}) CREATE (b:XWritten {pid: "w"}) RETURN b',
  set: 'MATCH (a:XPerson {pid: $id}) SET a.touched = true RETURN a',
};

let server: RunningNeo4j;
let writer: Login;
let gate: SourceGate;
let stub: ModelStub;
let app: Awaited<ReturnType<typeof buildApp>>;
const rows = recordingRunStore();
const events: AuditEvent[] = [];

async function count(cypher: string): Promise<number> {
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(cypher);
    const value: unknown = result.records[0]?.get('n');
    return typeof value === 'number' ? value : Number((value as { toNumber(): number }).toNumber());
  } finally {
    await session.close();
  }
}

beforeAll(async () => {
  stub = await startModelStub();
  server = await startNeo4j();
  writer = await server.createLogin('writer');
  await runAdmin(server, "CREATE (:XPerson {pid: 'p1', name: 'Ann'})-[:XKNOWS]->(:XPerson {pid: 'p2', name: 'Bo'})");
  // the extension's folder holds a harmless query under each name; the gate's own folder holds the writes, with the text check left permissive so that a write that passed it meets the transaction
  const folderPath = makeAskFolder(['graph'], Object.fromEntries(Object.keys(WRITES).map((name) => [name, { parameters: ['id'], query: 'MATCH (a:XPerson {pid: $id}) RETURN a' }])));
  const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: rows.factory });
  const configured = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: folderPath, NEBURYX_ASK_MAX_RETRIES: '0' }, { sourceIds: ['graph'] });
  expect(configured, JSON.stringify(configured)).toMatchObject({ ok: true });
  extension.createAuditSink?.({ databaseUrl: 'postgres://app@127.0.0.1:1/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => crypto.randomUUID(), onConnectionError: () => undefined });
  const mapping = { sources: [sourceFor(server, { entities, relationships })] };
  const defaults = communitySeams();
  const seams = { ...defaults, audit: { record: (event: AuditEvent) => (events.push(event), Promise.resolve()) } };
  gate = createSourceGate({ mapping, env: envFor(server, writer), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: seams.audit }, logger: { warn: () => undefined }, fileQueries: fileQueryDepsOf(() => handFolder(WRITES), () => []) });
  app = await buildApp({ webRoot: makeWebRoot(), logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, seams, gate: gate.gate, indexes: gate.indexes, extension, previewOn: true });
}, 300_000);

afterAll(async () => {
  removeAskFolders();
  await runAll([() => app?.close(), () => gate?.close(), () => server?.stop(), () => stub?.close()]);
});

describe(`a write that passed the text check, asked as a question on ${NEO4J_SERIES}`, () => {
  it.each(Object.keys(WRITES))('is refused by the explicit READ transaction on a login that can write: an error of the source, a failed run, no summary, and nothing written (%s)', async (name) => {
    const before = await count('MATCH (n) RETURN count(n) AS n');
    stub.replies.push(reply(name, { id: 'p1' }));
    const answer = await app.inject({ method: 'POST', url: '/v1/ask', payload: JSON.stringify({ sourceId: 'graph', question: 'Touch it' }), headers: JSON_HEADERS });
    const body = answer.json() as { error?: { code?: string }; answered?: unknown };
    expect(['INTERNAL_ERROR', 'SOURCE_UNAVAILABLE']).toContain(body.error?.code);
    expect(body.answered).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/CREATE|SET /);
    expect(rows.rows.at(-1)).toMatchObject({ intent: name, outcome: 'failed' });
    expect(events.filter((event) => event.action === 'ask.question').at(-1)).toMatchObject({ result: 'failed' });
    expect(await count('MATCH (n) RETURN count(n) AS n')).toBe(before);
    expect(await count("MATCH (n:XPerson {pid: 'p1'}) WHERE n.touched IS NOT NULL RETURN count(n) AS n")).toBe(0);
  });
});
