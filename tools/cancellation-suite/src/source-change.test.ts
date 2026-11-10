import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../../../apps/web/src/api/client.js';
import { openById, openEntity } from '../../../apps/web/src/investigations/open-flow.js';
import { createClientState, type ClientState } from '../../../apps/web/src/state/client-state.js';
import { buildApp } from '../../../services/api/src/app.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { identityHashOf } from '../../../services/api/src/registry/identity-hash.js';
import { reportFromServer } from '../../../services/api/src/source-test/report.js';
import { runSourceRebindCommand } from '../../../services/api/src/source-rebind/command.js';
import { memoryStoreWith, type MemoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { TestExecutor } from '../../../services/api/src/testing/gate.js';
import { baseSource, fileOf } from '../../../services/api/src/testing/mapping.js';
import { plainNode } from '../../../services/api/src/testing/normalize-fixtures.js';
import { portOf } from '../../../services/api/src/testing/raw-request.js';
import { withOnlineIndexes } from '../../../services/api/src/testing/search-fixtures.js';
import { testSourceGate } from '../../../services/api/src/testing/source-gate.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';

const folder = mkdtempSync(join(tmpdir(), 'source-change-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const ENTITIES = [{ type: 'hub', label: 'Hub', stable_id: 'hubId' }];
const sourceYaml = (id: string, database: string) => baseSource({ id, database, entities: ENTITIES, relationships: [{ type: 'LINKED', from: 'hub', to: 'hub' }] });
const mappingOf = (...sources: ReturnType<typeof sourceYaml>[]) => parseMapping(fileOf(...sources), 'neburyx.yaml');

const ORIGINAL = mappingOf(sourceYaml('demo', 'neo4j'), sourceYaml('other', 'neo4j'));
const REPOINTED = mappingOf(sourceYaml('demo', 'a-different-database'), sourceYaml('other', 'neo4j'));
const REMOVED = mappingOf(sourceYaml('other', 'neo4j'));
const SOURCE_READ = /^(GET|POST) \/v1\/(graph|entities|search|edges|source-links)\//;
const HUB = plainNode(['Hub'], { hubId: 'H-1' }, 'e-hub');

interface Running {
  readonly client: ApiClient;
  readonly executor: TestExecutor;
  readonly requests: string[];
  close(): Promise<void>;
}

/** The real API over the given mapping and store, and the real web client in front of it; the source behind the gate is scripted and keeps every call it receives. */
async function runOn(mapping: ReturnType<typeof mappingOf>, store: MemoryAppStore): Promise<Running> {
  const [first] = mapping.sources;
  if (first === undefined) throw new Error('the mapping has a source');
  const executor = new TestExecutor(withOnlineIndexes(first, () => Promise.resolve(entityRows(HUB))));
  const webRoot = makeWebRoot();
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor }).gate });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${portOf(app)}`;
  const requests: string[] = [];
  const client = createApiClient(async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`);
    return fetch(`${base}${input}`, init as RequestInit);
  });
  return {
    client,
    executor,
    requests,
    close: async () => {
      app.server.closeAllConnections();
      await app.close();
      rmSync(webRoot, { recursive: true, force: true });
    },
  };
}

const sourcesRows = (...ids: string[]) => ids.map((id) => ({ id, alias: id, state: 'unknown' as const, stateReason: null, synthetic: false, lastTestAt: null }));
const CONTEXT = { principalId: 'person-1', mask: false };

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** An investigation of `demo` and one of `other`, made through the real open path while the sources are as they were. */
async function seeded(): Promise<{ readonly store: MemoryAppStore; readonly demoId: string; readonly otherId: string }> {
  const store = memoryStoreWith({ sources: sourcesRows('demo', 'other') });
  const before = await runOn(ORIGINAL, store);
  const ids: string[] = [];
  for (const sourceId of ['demo', 'other']) {
    const state = createClientState();
    const opened = await openEntity(before.client, state, { sourceId, entity: { sourceId, entityType: 'hub', stableId: 'H-1' }, caseRef: `CASE-${sourceId}` }, CONTEXT);
    if (opened.kind !== 'shown') throw new Error('the investigation was not opened');
    ids.push(opened.id);
  }
  await before.close();
  const [demoId, otherId] = ids;
  if (demoId === undefined || otherId === undefined) throw new Error('two investigations were made');
  return { store, demoId, otherId };
}

const placeholders = (state: ClientState) => state.loadedGraph().nodes.every((node) => node.qualityFlags.includes('saved-layout-not-read'));

describe('a source that was re-pointed', () => {
  it('opens read-only on its saved layout with no read of any kind, and opens normally after the rebind', async () => {
    const { store, demoId } = await seeded();
    running = await runOn(REPOINTED, store);
    const state = createClientState();
    expect(await openById(running.client, state, demoId, CONTEXT)).toMatchObject({ kind: 'shown', id: demoId });
    expect(state.investigation.getState().record).toMatchObject({ readOnly: true, sourceState: 'repointed' });
    expect(placeholders(state)).toBe(true);
    expect(running.executor.calls).toEqual([]);
    expect(running.requests.filter((request) => SOURCE_READ.test(request))).toEqual([]);
    const draft = await running.client.saveDraft(demoId, 1, { notes: null, layout: { schemaVersion: 1, layout: 'force', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } } });
    expect(draft).toMatchObject({ ok: false, failure: { code: 'CONFLICT', details: { reason: 'source-changed', sourceState: 'repointed' } } });
    const reuse = await openEntity(running.client, createClientState(), { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'hub', stableId: 'H-1' }, caseRef: 'CASE-demo' }, CONTEXT);
    expect(reuse).toMatchObject({ kind: 'shown', id: demoId, created: false });
    expect(running.executor.calls).toEqual([]);

    // the operator tests the new connection, then rebinds; the API is not restarted
    const source = REPOINTED.sources.find((candidate) => candidate.id === 'demo');
    if (source === undefined) throw new Error('demo is in the mapping');
    await store.recordSourceCheck({ id: 'check-1', report: reportFromServer(source, { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] }, false, '2026-11-10T10:00:00.000Z'), triggeredBy: null, identityHash: identityHashOf(source), configHash: source.configHash });
    const file = join(folder, 'neburyx.yaml');
    writeFileSync(file, fileOf(sourceYaml('demo', 'a-different-database'), sourceYaml('other', 'neo4j')));
    let out = '';
    let err = '';
    const code = await runSourceRebindCommand(['rebind', 'demo', '--confirm', 'demo'], { DATABASE_URL: 'postgres://u:p@h.example.test/db', NEBURYX_CONFIG: file }, { stdout: { write: (text) => (out += text) }, stderr: { write: (text) => (err += text) }, openStore: () => ({ rebindSource: store.rebindSource, close: () => Promise.resolve() }) });
    expect({ code, out, err }).toEqual({ code: 0, out: 'Source: demo\nInvestigations rebound: 1\n', err: '' });
    expect(running.executor.calls).toEqual([]);

    const after = createClientState();
    expect(await openById(running.client, after, demoId, CONTEXT)).toMatchObject({ kind: 'shown', id: demoId });
    expect(after.investigation.getState().record).toMatchObject({ readOnly: false, sourceState: 'available' });
    expect(after.loadedGraph().nodes.some((node) => node.qualityFlags.includes('saved-layout-not-read'))).toBe(false);
    expect(running.executor.calls.length).toBeGreaterThan(0);
    expect(await running.client.saveDraft(demoId, 1, { notes: null, layout: { schemaVersion: 1, layout: 'force', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } } })).toMatchObject({ ok: true });
  });
});

describe('a source that was removed', () => {
  it('shows the saved layout with no read, refuses writes, and lets the owner delete the investigation', async () => {
    const { store, demoId } = await seeded();
    running = await runOn(REMOVED, store);
    const state = createClientState();
    expect(await openById(running.client, state, demoId, CONTEXT)).toMatchObject({ kind: 'shown', id: demoId });
    expect(state.investigation.getState().record).toMatchObject({ readOnly: true, sourceState: 'removed' });
    expect(placeholders(state)).toBe(true);
    expect(state.loadedGraph().nodes).toHaveLength(1);
    expect(running.executor.calls).toEqual([]);
    expect(running.requests.filter((request) => SOURCE_READ.test(request))).toEqual([]);
    expect(await running.client.renameInvestigation(demoId, 'New name', 1)).toMatchObject({ ok: false, failure: { code: 'CONFLICT', details: { reason: 'source-changed', sourceState: 'removed' } } });
    const record = state.investigation.getState().record;
    const deleted = await running.client.deleteInvestigation(demoId, record?.version ?? 1);
    expect(deleted.ok).toBe(true);
    expect(await running.client.getInvestigation(demoId)).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND' } });
    expect(running.executor.calls).toEqual([]);
  });
});

describe('an investigation of another source of the same deployment', () => {
  it('is unaffected by a re-pointed or removed source', async () => {
    const { store, otherId } = await seeded();
    for (const mapping of [REPOINTED, REMOVED]) {
      running = await runOn(mapping, store);
      const state = createClientState();
      expect(await openById(running.client, state, otherId, CONTEXT)).toMatchObject({ kind: 'shown', id: otherId });
      expect(state.investigation.getState().record).toMatchObject({ readOnly: false, sourceState: 'available' });
      expect(placeholders(state)).toBe(false);
      await running.close();
      running = undefined;
    }
  });
});
