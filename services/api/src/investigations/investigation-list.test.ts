import { rmSync } from 'node:fs';
import { investigationListResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Decision, PolicyProvider, Seams } from '../seams/seams.js';
import { LOCAL_IDENTITY, memoryAppStore, memoryStoreWith, type MemoryAppStore } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const entities = [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' }];
const relationships = [{ type: 'LINKS', from: 'widget', to: 'gadget' }];
const sources = [baseSource({ id: 'open', uri: 'neo4j+s://open.example.test:7687', entities, relationships }), baseSource({ id: 'secret', uri: 'neo4j+s://secret.example.test:7687', entities, relationships })];
const mapping = parseMapping(fileOf(...sources), 'neburyx.yaml');
const SECOND_USER = '0192f000-0000-7000-8000-000000000002';

const identityOf = (sourceId: string): string => {
  const found = mapping.sources.find((source) => source.id === sourceId);
  return found === undefined ? 'retired' : identityHashOf(found);
};

let counter = 0;
function row(sourceId: string, minutes: number, overrides: Partial<InvestigationRow> = {}): InvestigationRow {
  counter += 1;
  const at = new Date(Date.UTC(2026, 10, 5, 12, minutes)).toISOString();
  return {
    id: `0192f000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    sourceId,
    sourceIdentityHash: identityOf(sourceId),
    ownerId: LOCAL_IDENTITY.principal.id,
    title: `Widget W-${counter}`,
    caseRef: null,
    startingEntityType: 'widget',
    startingStableId: `W-${counter}`,
    status: 'open',
    createdAt: at,
    lastEditedAt: at,
    version: 1,
    ...overrides,
  };
}

interface Started {
  readonly store: MemoryAppStore;
  readonly asks: string[];
  readonly events: AuditEvent[];
  readonly executor: TestExecutor;
  readonly list: (query?: string) => Promise<{ readonly status: number; readonly body: { items: { id: string; sourceId: string; sourceState: string; sourceAlias: string }[]; hasMore: boolean; error?: { code: string } } }>;
}

async function started(refused: readonly string[] = ['secret'], options: { readonly store?: MemoryAppStore; readonly failPolicy?: boolean } = {}): Promise<Started> {
  const asks: string[] = [];
  const events: AuditEvent[] = [];
  const policy: PolicyProvider = {
    authorizeSource: async ({ sourceId }): Promise<Decision> => {
      asks.push(sourceId);
      if (options.failPolicy === true) throw new Error('the policy could not answer');
      return refused.includes(sourceId) ? { allowed: false, reason: 'not permitted' } : { allowed: true };
    },
  };
  const seams: Seams = { ...communitySeams(), policy, audit: { record: async (event) => void events.push(event) } };
  const store = options.store ?? memoryAppStore();
  const executor = new TestExecutor(withOnlineIndexes(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), () => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'W-1' })))));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, seams, gate: testSourceGate(mapping, { executor, seams }).gate });
  const list = async (query = '') => {
    const response = await app.inject({ method: 'GET', url: `/v1/investigations${query}` });
    return { status: response.statusCode, body: response.json() };
  };
  return { store, asks, events, executor, list };
}

const idsOf = (answer: Awaited<ReturnType<Started['list']>>): string[] => answer.body.items.map((item) => item.id);

describe('the list of the caller\'s investigations', () => {
  it('lists the caller\'s own open investigations newest first, with the larger id first between equal times, each in the shape of the contract', async () => {
    const { store, list } = await started();
    const older = row('open', 1);
    const tieLow = row('open', 5);
    const tieHigh = row('open', 5);
    const newest = row('open', 9);
    store.investigations.push(older, tieLow, tieHigh, newest, row('open', 7, { ownerId: SECOND_USER }));
    const answer = await list('?limit=5&sort=lastEdited');
    expect(answer.status).toBe(200);
    expect(idsOf(answer)).toEqual([newest.id, tieHigh.id, tieLow.id, older.id]);
    expect(investigationListResponseSchema.safeParse(answer.body).success).toBe(true);
    expect(answer.body.items[0]).toMatchObject({ sourceId: 'open', sourceState: 'available', save: { state: 'unsaved', savedAt: null }, startingEntity: { entityType: 'widget', stableId: newest.startingStableId } });
    expect(await list()).toEqual(answer);
  });

  it('never lists a closed, archived or other person\'s investigation', async () => {
    const { store, list } = await started();
    const wanted = row('open', 1);
    store.investigations.push(wanted, row('open', 2, { status: 'closed' }), row('open', 3, { status: 'archived' }), row('open', 4, { ownerId: SECOND_USER }));
    expect(idsOf(await list())).toEqual([wanted.id]);
  });

  it('cuts the list at the limit and says there is more only when there is', async () => {
    const { store, list } = await started();
    store.investigations.push(...[1, 2, 3, 4, 5].map((minutes) => row('open', minutes)));
    expect((await list('?limit=5')).body).toMatchObject({ hasMore: false });
    expect((await list('?limit=5')).body.items).toHaveLength(5);
    store.investigations.push(row('open', 6));
    const answer = await list('?limit=5');
    expect(answer.body.items).toHaveLength(5);
    expect(answer.body.hasMore).toBe(true);
    expect((await list()).body.items).toHaveLength(5);
    expect((await list('?limit=2')).body.items).toHaveLength(2);
    expect((await list('?limit=25')).body.items).toHaveLength(6);
  });

  it.each([['limit=0'], ['limit=26'], ['limit=1.5'], ['limit=x'], ['limit='], ['limit=-1'], ['sort=name'], ['sort='], ['other=1'], ['limit=5&limit=6'], ['limit=5&other=1']])('refuses the query %s with INVALID_REQUEST', async (query) => {
    const { list, asks } = await started();
    const answer = await list(`?${query}`);
    expect(answer.status).toBe(400);
    expect(answer.body.error?.code).toBe('INVALID_REQUEST');
    expect(asks).toEqual([]);
  });

  it('lists the rows of a source no longer in the configuration as removed, and reads no source', async () => {
    const { store, list, executor, asks } = await started();
    const gone = row('retired', 3);
    store.investigations.push(gone, row('open', 2));
    const answer = await list();
    expect(answer.body.items.map((item) => [item.id, item.sourceState])).toEqual([[gone.id, 'removed'], [answer.body.items[1]?.id, 'available']]);
    expect(executor.calls).toHaveLength(0);
    expect(asks).toEqual(['open']);
  });

  it('answers an empty list with no rows and no more', async () => {
    const { list } = await started();
    expect((await list()).body).toEqual({ items: [], hasMore: false });
  });

  it('answers 500 INTERNAL_ERROR when the investigations cannot be read', async () => {
    const { list } = await started(['secret'], { store: memoryStoreWith({ failList: true }) });
    const answer = await list();
    expect(answer.status).toBe(500);
    expect(answer.body.error?.code).toBe('INTERNAL_ERROR');
  });
});

describe('the sources a person may read in the list', () => {
  it('leaves out the rows of a source the policy refuses, writes no audit event and reads no source', async () => {
    const { store, list, events, executor } = await started();
    const readable = row('open', 1);
    store.investigations.push(readable, row('secret', 2));
    const answer = await list();
    expect(idsOf(answer)).toEqual([readable.id]);
    expect(events).toEqual([]);
    expect(executor.calls).toHaveLength(0);
  });

  it('lists readable rows up to the limit when refused rows are newer than them', async () => {
    const { store, list } = await started();
    const readable = [1, 2, 3].map((minutes) => row('open', minutes));
    store.investigations.push(...readable, row('secret', 20), row('secret', 21), row('secret', 22));
    const answer = await list('?limit=3');
    expect(idsOf(answer)).toEqual(readable.map((entry) => entry.id).reverse());
    expect(answer.body.hasMore).toBe(false);
  });

  it('says there is more only for readable rows beyond the limit, never for refused ones', async () => {
    const { store, list } = await started();
    store.investigations.push(...[1, 2].map((minutes) => row('open', minutes)), row('secret', 0), row('secret', 30));
    expect((await list('?limit=2')).body.hasMore).toBe(false);
    store.investigations.push(row('open', 3));
    const answer = await list('?limit=2');
    expect(answer.body.items).toHaveLength(2);
    expect(answer.body.hasMore).toBe(true);
  });

  it('asks the policy once for each configured source among the rows', async () => {
    const { store, list, asks } = await started([]);
    store.investigations.push(row('open', 1), row('open', 2), row('secret', 3), row('open', 4));
    expect((await list()).body.items).toHaveLength(4);
    expect([...asks].sort()).toEqual(['open', 'secret']);
  });

  it('answers 500 INTERNAL_ERROR, and no shorter list, when the policy fails', async () => {
    const { store, list } = await started([], { failPolicy: true });
    store.investigations.push(row('open', 1));
    const answer = await list();
    expect(answer.status).toBe(500);
    expect(answer.body.error?.code).toBe('INTERNAL_ERROR');
    expect(answer.body.items).toBeUndefined();
  });
});
