import { rmSync } from 'node:fs';
import { CHAT_INVESTIGATION_IDS_MAX, type ChatInvestigation, type ExtensionRequest, type ProfileExtension } from '@neburyx/contracts';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryAppStore } from '../testing/app-store.js';
import { TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const VALUE = '+1-212-555-0100';
const entities = [
  { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
  { type: 'widget', label: 'Widget', stable_id: 'widgetId' },
];
const sources = [baseSource({ id: 'demo', uri: 'neo4j+s://demo.example.test:7687', entities, relationships: [] }), baseSource({ id: 'secret', uri: 'neo4j+s://secret.example.test:7687', entities, relationships: [] })];
const mapping = parseMapping(fileOf(...sources), 'neburyx.yaml');
const identityOf = (sourceId: string): string => {
  const found = mapping.sources.find((source) => source.id === sourceId);
  return found === undefined ? 'retired' : identityHashOf(found);
};
const ME = LOCAL_IDENTITY.principal.id;
const OTHER = '0192f000-0000-7000-8000-0000000000aa';

let counter = 0;
function row(over: Partial<InvestigationRow> = {}): InvestigationRow {
  counter += 1;
  const at = new Date(Date.UTC(2026, 10, 5, 12, counter)).toISOString();
  return {
    id: `0192f000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    sourceId: 'demo',
    sourceIdentityHash: identityOf('demo'),
    ownerId: ME,
    title: `Widget W-${counter}`,
    caseRef: null,
    startingEntityType: 'widget',
    startingStableId: `W-${counter}`,
    status: 'open',
    createdAt: at,
    lastEditedAt: at,
    closedAt: null,
    archivedAt: null,
    version: 1,
    ...over,
  };
}

interface Run {
  readonly named: readonly ChatInvestigation[];
  readonly shown: { readonly id: string; readonly title: string; readonly caseRef: string | null; readonly sourceId: string; readonly sourceAlias: string; readonly sourceState: string }[];
  readonly executor: TestExecutor;
  readonly status: number;
  readonly error?: string;
}

/** Calls the member from inside a route of an extension, as the real routes do, and reads the investigations list of the same app beside it. */
async function through(store: MemoryAppStore, ids: (all: readonly InvestigationRow[]) => readonly string[], refused: readonly string[] = ['secret']): Promise<Run> {
  const handler = async (request: ExtensionRequest): Promise<unknown> => {
    if (request.chatInvestigations === undefined) return { missing: true };
    return request.chatInvestigations(ids(store.investigations));
  };
  const extension: ProfileExtension = { name: 'probe', routeGroups: [{ routes: [{ method: 'GET', url: '/v1/probe', permission: 'principal', responseSchema: z.unknown(), handler }] }] };
  const executor = new TestExecutor();
  const seams = { policy: { authorizeSource: async ({ sourceId }: { sourceId: string }) => (refused.includes(sourceId) ? { allowed: false as const, reason: 'not permitted' } : { allowed: true as const }) } };
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor, referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS, extension, seams: { ...(await import('../seams/community-seams.js')).communitySeams(), ...seams } });
  const answer = await app.inject({ url: '/v1/probe' });
  const list = await app.inject({ url: '/v1/investigations?limit=100' });
  await app.close();
  const body = answer.json() as unknown;
  return { named: answer.statusCode === 200 ? (body as ChatInvestigation[]) : [], shown: (list.json() as { items: Run['shown'] }).items, executor, status: answer.statusCode, ...(answer.statusCode === 200 ? {} : { error: (body as { error?: { code?: string } }).error?.code ?? '' }) };
}

const idsOf = (rows: readonly InvestigationRow[]): string[] => rows.map((each) => each.id);

describe('the investigations a list of chats may name', () => {
  it('names each investigation with the fields the investigations list shows for it', async () => {
    const store = memoryAppStore();
    store.investigations.push(row({ caseRef: 'REF-1' }), row());
    const run = await through(store, idsOf);
    expect(run.status).toBe(200);
    expect(run.named).toHaveLength(2);
    for (const each of run.named) {
      const listed = run.shown.find((candidate) => candidate.id === each.id);
      expect(listed).toBeDefined();
      expect(each).toEqual({ id: listed?.id, title: listed?.title, caseRef: listed?.caseRef, sourceId: listed?.sourceId, sourceAlias: listed?.sourceAlias, sourceState: listed?.sourceState });
    }
  });

  it('gives the title the list shows for a generated title that holds a keyed value, and never the value', async () => {
    const store = memoryAppStore();
    store.investigations.push(row({ title: `Handle ${VALUE}`, startingEntityType: 'phone', startingStableId: VALUE }));
    const run = await through(store, idsOf);
    expect(run.named[0]?.title).toBe('Handle');
    expect(JSON.stringify(run.named)).not.toContain(VALUE);
    expect(run.named[0]?.title).toBe(run.shown[0]?.title);
  });

  it('names none of an investigation that is closed, archived or deleted, that another person owns, on a source the caller may not read, or that does not exist, and says nothing of which it was', async () => {
    const store = memoryAppStore();
    const live = row();
    store.investigations.push(live, row({ status: 'closed' }), row({ status: 'archived' }), row({ ownerId: OTHER }), row({ sourceId: 'secret', sourceIdentityHash: identityOf('secret') }));
    const deleted = row();
    store.investigations.push(deleted);
    await store.deleteInvestigation({ investigationId: deleted.id, ownerId: ME, expectedVersion: 1, retentionDays: 30, beforeCommit: async () => undefined });
    const run = await through(store, (all) => [...idsOf(all), '0192f000-0000-7000-8000-0000000fffff', 'not-an-id']);
    expect(run.named.map((each) => each.id)).toEqual([live.id]);
  });

  it('gives the source state of an investigation on a source taken out of the configuration or repointed, with the alias the application kept, and reads no source', async () => {
    const store = memoryAppStore();
    const removed = row({ sourceId: 'gone', sourceIdentityHash: 'retired' });
    const repointed = row({ sourceIdentityHash: 'another-identity' });
    store.investigations.push(removed, repointed, row());
    const run = await through(store, idsOf);
    const byId = new Map(run.named.map((each) => [each.id, each]));
    expect(byId.get(removed.id)?.sourceState).toBe('removed');
    expect(byId.get(repointed.id)?.sourceState).toBe('repointed');
    for (const each of run.named) expect(each.sourceState).toBe(run.shown.find((listed) => listed.id === each.id)?.sourceState);
    expect(run.executor.calls).toEqual([]);
  });

  it('accepts exactly the maximum number of ids and rejects one more as the application’s fixed error, never as a refusal of the request', async () => {
    const store = memoryAppStore();
    store.investigations.push(row());
    const ids = (count: number) => (all: readonly InvestigationRow[]) => [...idsOf(all), ...Array.from({ length: count - all.length }, (_, index) => `0192f000-0000-7000-8000-${String(900000 + index).padStart(12, '0')}`)];
    const at = await through(store, ids(CHAT_INVESTIGATION_IDS_MAX));
    expect(at.status).toBe(200);
    const over = await through(store, ids(CHAT_INVESTIGATION_IDS_MAX + 1));
    expect([over.status, over.error]).toEqual([500, 'INTERNAL_ERROR']);
  });

  it('is absent from a request that no application wired it into only when the mount does not give it', async () => {
    const handler = async (request: ExtensionRequest): Promise<unknown> => ({ present: request.chatInvestigations !== undefined });
    const extension: ProfileExtension = { name: 'probe', routeGroups: [{ routes: [{ method: 'GET', url: '/v1/probe', permission: 'principal', responseSchema: z.unknown(), handler }] }] };
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: testSourceGate(mapping).gate, referenceKeys: TEST_REFERENCE_KEYS, extension });
    expect((await app.inject({ url: '/v1/probe' })).json()).toEqual({ present: true });
    await app.close();
  });
});
