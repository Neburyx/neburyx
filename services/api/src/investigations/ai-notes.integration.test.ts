import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AI_NOTES_MAX_ENTRIES, openInvestigationResponseSchema, type CaseSummarizer, type ProfileExtension } from '@neburyx/contracts';
import { createCopyToNotesRoute, createReadAiNotesRoute, sealToken } from '@neburyx/ee-ask';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import { uuidv7 } from '../identity/uuid.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { runCli } from '../testing/cli.js';
import { attempt, rows } from '../testing/database.js';
import pg from 'pg';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import { TestExecutor } from '../testing/gate.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { testSourceGate } from '../testing/source-gate.js';
import { webRoot } from '../testing/start-api.js';
import { contentHashOf, initialDraftDocuments } from './draft.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gizmo', label: 'Gizmo', stable_id: 'gizmoId' }], relationships: [{ type: 'LINKS', from: 'widget', to: 'gizmo' }] })), 'neburyx.yaml');
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const INITIAL_CONTENT_HASH = 'a5de85ae95f682f027744f9592c68417fd631c2706bad57870b404a5ddafc1b2';
const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });

let postgres: TestPostgres;
const stores: AppStore[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

function openStore(database: TestDatabase): AppStore {
  const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  let closing: Promise<void> | undefined;
  const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
  stores.push(store);
  return store;
}

async function appOn(database: TestDatabase, appMapping = mapping, answer: ExecuteOutcome | (() => Promise<ExecuteOutcome>) = entityRows(WIDGET), wrap: (store: AppStore) => AppStore = (store) => store) {
  const store = wrap(openStore(database));
  const data = typeof answer === 'function' ? answer : () => Promise.resolve(answer);
  const executor = new TestExecutor(withOnlineIndexes(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), data));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: appMapping, gate: testSourceGate(appMapping, { executor }).gate });
  return { app, store, executor };
}

async function running(answer: ExecuteOutcome | (() => Promise<ExecuteOutcome>) = entityRows(WIDGET)) {
  const database = await postgres.newDatabase();
  expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
  const first = await appOn(database, mapping, answer);
  await first.store.initialize();
  await first.store.syncSources(mapping.sources);
  const post = (payload: object) => first.app.inject({ method: 'POST', url: '/v1/investigations', payload });
  return { database, ...first, post };
}

const body = (overrides: Record<string, unknown> = {}) => ({ sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, ...overrides });
const count = async (database: TestDatabase, table: 'investigations' | 'saved_views') => Number((await rows(database.ownerUrl, `SELECT count(*)::int AS n FROM ${table}`))[0]?.['n']);

function asUser(store: AppStore, id: string): AppStore {
  return { ...store, current: async () => ({ ...(await store.current()), principal: { ...(await store.current()).principal, id } }) };
}

async function secondUser(database: TestDatabase): Promise<string> {
  const id = uuidv7();
  await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second')`, [id]);
  return id;
}

describe('the AI notes of a draft against Postgres', () => {
  const entry = (tokenId: string) => ({ tokenId, sentences: [{ text: 'a sentence' }], inputRefs: [{ key: 'n1' }] });

  async function opened() {
    const running_ = await running();
    const response = await running_.post(body());
    const id = openInvestigationResponseSchema.parse(response.json()).investigation.id;
    const { principal } = await running_.store.current();
    const append = (tokenId: string, expectedVersion: number) => running_.store.appendAiNotes({ investigationId: id, ownerId: principal.id, expectedVersion, entry: entry(tokenId), maxEntries: AI_NOTES_MAX_ENTRIES, contentHashOf: ({ layout, queryContext, notes, aiNotes }) => contentHashOf({ layout, queryContext }, notes, aiNotes) });
    const draft = async () => (await rows(running_.database.ownerUrl, `SELECT version, ai_notes, content_hash, notes FROM saved_views WHERE investigation_id = $1 AND kind = 'draft'`, [id]))[0];
    return { ...running_, id, principal, append, draft };
  }

  it('appends under the lock: the notes, the version, the hash and the last edit change together', async () => {
    const { app, database, id, append, draft } = await opened();
    const [before] = await rows(database.ownerUrl, 'SELECT last_edited_at FROM investigations WHERE id = $1', [id]);
    const result = await append('tok-1', 1);
    expect(result).toMatchObject({ outcome: 'appended', version: 2 });
    const stored = await draft();
    expect(stored).toMatchObject({ version: 2, ai_notes: { entries: [entry('tok-1')] } });
    const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
    expect(stored?.['content_hash']).toBe(contentHashOf(documents, null, { entries: [entry('tok-1')] }));
    const [after] = await rows(database.ownerUrl, 'SELECT last_edited_at FROM investigations WHERE id = $1', [id]);
    expect(after?.['last_edited_at']).not.toEqual(before?.['last_edited_at']);
    await app.close();
  });

  it('stores one entry when the same token is appended by two calls at once, and the other is told it was stored', async () => {
    const { app, id, append, draft } = await opened();
    const outcomes = await Promise.all([append('tok-1', 1), append('tok-1', 1)]);
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['already-stored', 'appended']);
    expect(outcomes.every((outcome) => 'version' in outcome && outcome.version === 2)).toBe(true);
    expect(await draft()).toMatchObject({ version: 2, ai_notes: { entries: [entry('tok-1')] } });
    expect(id).toBeTruthy();
    await app.close();
  });

  it('refuses a stale version for a new token, and decides a stored token before the version', async () => {
    const { app, append, draft } = await opened();
    await append('tok-1', 1);
    expect(await append('tok-2', 1)).toEqual({ outcome: 'conflict' });
    expect(await append('tok-1', 1)).toMatchObject({ outcome: 'already-stored', version: 2 });
    expect(await draft()).toMatchObject({ version: 2 });
    await app.close();
  });

  it('refuses an entry that would be past the entry cap, and does not write', async () => {
    const { app, id, principal, store, draft } = await opened();
    for (let index = 0; index < 3; index += 1) await store.appendAiNotes({ investigationId: id, ownerId: principal.id, expectedVersion: index + 1, entry: entry(`tok-${index}`), maxEntries: 3, contentHashOf: ({ layout, queryContext, notes, aiNotes }) => contentHashOf({ layout, queryContext }, notes, aiNotes) });
    expect(await store.appendAiNotes({ investigationId: id, ownerId: principal.id, expectedVersion: 4, entry: entry('tok-over'), maxEntries: 3, contentHashOf: () => 'x' })).toEqual({ outcome: 'full' });
    expect(await draft()).toMatchObject({ version: 4 });
    await app.close();
  });

  it('keeps the notes in the hash of the next draft save and copies them into a named view', async () => {
    const { app, id, append, draft, database } = await opened();
    await append('tok-1', 1);
    const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
    const saved = await app.inject({ method: 'PUT', url: `/v1/investigations/${id}/draft`, headers: { 'if-match': '"2"' }, payload: { layout: documents.layout, queryContext: documents.queryContext, notes: null } });
    expect(saved.statusCode).toBe(200);
    expect(await draft()).toMatchObject({ version: 2 });
    const view = await app.inject({ method: 'POST', url: `/v1/investigations/${id}/views`, headers: { 'if-match': '"2"' }, payload: { name: 'With notes', notes: null } });
    expect(view.statusCode).toBeLessThan(300);
    const [named] = await rows(database.ownerUrl, `SELECT ai_notes FROM saved_views WHERE investigation_id = $1 AND kind = 'named'`, [id]);
    expect(named?.['ai_notes']).toEqual({ entries: [entry('tok-1')] });
    await app.close();
  });

  it('answers not found for another person, as a draft read does', async () => {
    const { app, id, store, database } = await opened();
    const other = await secondUser(database);
    expect(await asUser(store, other).readAiNotes(id, other)).toEqual({ outcome: 'not-found' });
    await app.close();
  });
});

describe('the AI notes routes against Postgres, for two people', () => {
  const keys = { current: { kid: 'abcd1234', bytes: Buffer.alloc(32, 9) } };
  const extension: ProfileExtension = { name: 'notes', routeGroups: [{ routes: [createCopyToNotesRoute({ tokenKeys: () => keys }), createReadAiNotesRoute({ maxRefs: () => 300 })] }] };
  const summarizer: CaseSummarizer = { maxElements: 300, availability: () => ({ available: true }), summarize: async () => ({ status: 'timeLimit', calls: 1 }) };
  const W1 = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };

  async function appFor(database: TestDatabase, person: string | undefined) {
    const base = openStore(database);
    const store = person === undefined ? base : asUser(base, person);
    const executor = new TestExecutor(withOnlineIndexes(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), () => Promise.resolve(entityRows(WIDGET))));
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor }).gate, extension, previewOn: true, seams: { ...communitySeams(), caseSummarizer: summarizer } });
    return { app, store };
  }

  const tokenOf = (investigationId: string, person: string) =>
    sealToken(keys, { investigationId, generatedBy: person, policyVersion: 'none', modelRef: 'm', promptId: 'case-summary', promptVersion: '1', sentences: [{ text: 'The record is linked.', cites: ['n1'] }], inputRefs: [{ key: 'n1', kind: 'entity', ref: W1 }], propertyValuesSent: false, runId: '0192f000-0000-7000-8000-0000000000aa', mask: false, wordListVersion: 1, templates: [{ storable: true, text: 'The record is linked.', placeholders: [] }] }, Date.now());

  it('stores a copy for its owner on the real draft row, and keeps it from another person, for whom the read is not found and the copy is refused', async () => {
    const { database, app, post, store } = await running();
    const owner = (await store.current()).principal.id;
    const investigationId = openInvestigationResponseSchema.parse((await post(body())).json()).investigation.id;
    const author = await appFor(database, undefined);
    const copied = await author.app.inject({ method: 'POST', url: `/v1/investigations/${investigationId}/draft/ai-notes`, payload: { summaryToken: tokenOf(investigationId, owner), version: 1 } });
    expect(copied.statusCode).toBe(200);
    expect(copied.json()).toMatchObject({ copied: 1, notCopied: 0, alreadyCopied: false, version: 2 });
    const held = await store.readAiNotes(investigationId, owner);
    expect(held).toMatchObject({ outcome: 'read', version: 2, entries: [{ tokenId: expect.any(String), sentences: [{ text: 'The record is linked.' }] }] });
    const second = await secondUser(database);
    const other = await appFor(database, second);
    expect((await other.app.inject({ url: `/v1/investigations/${investigationId}/draft/ai-notes?mask=false` })).statusCode).toBe(404);
    expect((await other.app.inject({ method: 'POST', url: `/v1/investigations/${investigationId}/draft/ai-notes`, payload: { summaryToken: tokenOf(investigationId, second), version: 1 } })).statusCode).toBe(403);
    await app.close();
    await author.app.close();
    await other.app.close();
  });
});
