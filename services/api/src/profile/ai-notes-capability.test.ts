import { rmSync } from 'node:fs';
import { AI_NOTES_MAX_ENTRIES, AI_NOTES_MAX_SENTENCES, type AiNotesCapability, type ExtensionRequest, type ProfileExtension } from '@neburyx/contracts';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { contentHashOf, initialDraftDocuments } from '../investigations/draft.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryAppStore } from '../testing/app-store.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const ME = LOCAL_IDENTITY.principal.id;
const OTHER = '0192f000-0000-7000-8000-0000000000aa';
const ID = '0192f000-0000-7000-8000-0000000000c1';

function row(overrides: Partial<InvestigationRow> = {}): InvestigationRow {
  return { id: ID, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId: ME, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status: 'open', createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', closedAt: null, archivedAt: null, version: 3, ...overrides };
}

function seeded(overrides: Partial<InvestigationRow> = {}): MemoryAppStore {
  const store = memoryAppStore();
  const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
  store.investigations.push(row(overrides));
  store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, basedOnViewId: null, layout: documents.layout, queryContext: documents.queryContext, mappingHash: demo.configHash, investigationId: ID, contentHash: contentHashOf(documents) });
  return store;
}

const entry = (tokenId: string, extra: Record<string, unknown> = {}) => ({ tokenId, sentences: [{ text: 'a sentence' }], inputRefs: [{ key: 'n1' }], ...extra });

/** Calls the capability from inside a route of an extension, as the real routes do. */
async function through(store: MemoryAppStore, work: (notes: AiNotesCapability) => Promise<unknown>) {
  const handler = async (request: ExtensionRequest): Promise<unknown> => {
    if (request.aiNotes === undefined) return { missing: true };
    return work(request.aiNotes);
  };
  const extension: ProfileExtension = { name: 'probe', routeGroups: [{ routes: [{ method: 'GET', url: '/v1/probe', permission: 'principal', responseSchema: z.unknown(), handler }] }] };
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS, extension, previewOn: true });
  const answer = await app.inject({ url: '/v1/probe' });
  await app.close();
  return { status: answer.statusCode, body: answer.json() as unknown };
}

const append = (notes: AiNotesCapability, tokenId: string, expectedVersion = 1, id = ID, extra: Record<string, unknown> = {}, maxRefs = 300) => notes.append({ investigationId: id, expectedVersion, entry: entry(tokenId, extra), maxRefs });

describe('the AI notes capability of an extension request', () => {
  it('appends an entry, raises the version, rehashes the draft with the notes and moves the last edit', async () => {
    const store = seeded();
    const before = store.investigations[0]?.lastEditedAt;
    const answer = await through(store, (notes) => append(notes, 'tok-1'));
    expect(answer).toEqual({ status: 200, body: { outcome: 'appended', version: 2, save: { state: 'unsaved', savedAt: null } } });
    const draft = store.drafts[0];
    expect(draft?.aiNotes).toEqual({ entries: [entry('tok-1')] });
    expect(draft?.contentHash).toBe(contentHashOf({ layout: draft?.layout, queryContext: draft?.queryContext } as never, null, draft?.aiNotes));
    expect(store.investigations[0]?.lastEditedAt).not.toBe(before);
  });

  it('changes nothing for a token id that is already stored, even with a stale version', async () => {
    const store = seeded();
    await through(store, (notes) => append(notes, 'tok-1'));
    const held = JSON.stringify(store.drafts[0]);
    const again = await through(store, (notes) => append(notes, 'tok-1', 1));
    expect(again).toEqual({ status: 200, body: { outcome: 'already-stored', version: 2, save: { state: 'unsaved', savedAt: null } } });
    expect(JSON.stringify(store.drafts[0])).toBe(held);
  });

  it('refuses a stale version for a new token and changes nothing', async () => {
    const store = seeded();
    await through(store, (notes) => append(notes, 'tok-1'));
    const held = JSON.stringify(store.drafts[0]);
    const answer = await through(store, (notes) => append(notes, 'tok-2', 1));
    expect(answer.status).toBe(409);
    expect(JSON.stringify(store.drafts[0])).toBe(held);
  });

  it('refuses an entry past the entry cap, a long entry and too many references, before anything is written', async () => {
    const store = seeded();
    for (let index = 0; index < AI_NOTES_MAX_ENTRIES; index += 1) await through(store, (notes) => append(notes, `tok-${index}`, index + 1));
    const full = await through(store, (notes) => append(notes, 'tok-over', AI_NOTES_MAX_ENTRIES + 1));
    expect(full).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST', details: { reason: 'ai-notes-full' } } } });
    const fresh = seeded();
    const sentences = Array.from({ length: AI_NOTES_MAX_SENTENCES + 1 }, () => ({ text: 's' }));
    const long = await through(fresh, (notes) => append(notes, 'tok-long', 1, ID, { sentences }));
    expect(long).toMatchObject({ status: 400, body: { error: { details: { reason: 'ai-notes-entry-too-large' } } } });
    const many = await through(fresh, (notes) => append(notes, 'tok-many', 1, ID, {}, 0));
    expect(many).toMatchObject({ status: 400, body: { error: { details: { reason: 'ai-notes-entry-too-large' } } } });
    expect(fresh.drafts[0]?.aiNotes).toBeUndefined();
  });

  it('is not found for another person\'s investigation and for an id that is not a UUID, on append and on read', async () => {
    const store = seeded({ ownerId: OTHER });
    expect((await through(store, (notes) => append(notes, 'tok-1'))).status).toBe(404);
    expect((await through(store, (notes) => notes.read(ID))).status).toBe(404);
    expect((await through(seeded(), (notes) => append(notes, 'tok-1', 1, 'not-a-uuid'))).status).toBe(404);
  });

  it('refuses a closed investigation as a draft write does and does not write', async () => {
    const store = seeded({ status: 'closed' });
    const answer = await through(store, (notes) => append(notes, 'tok-1'));
    expect(answer.status).toBe(409);
    expect(store.drafts[0]?.aiNotes).toBeUndefined();
  });

  it('reads the stored entries with the draft version and save state', async () => {
    const store = seeded();
    await through(store, (notes) => append(notes, 'tok-1'));
    const answer = await through(store, (notes) => notes.read(ID));
    expect(answer.body).toEqual({ entries: [entry('tok-1')], version: 2, save: { state: 'unsaved', savedAt: null } });
  });

  it('keeps the stored notes in the hash of a later draft save, so the save is not a change by itself', async () => {
    const store = seeded();
    await through(store, (notes) => append(notes, 'tok-1'));
    const draft = store.drafts[0];
    const unchanged = await store.saveDraft({ investigationId: ID, ownerId: ME, expectedVersion: 2, layout: draft?.layout as never, queryContext: draft?.queryContext as never, notes: null, mappingHash: demo.configHash, nodeCount: 1, edgeCount: 0, contentHashOf: ({ aiNotes }) => contentHashOf({ layout: draft?.layout, queryContext: draft?.queryContext } as never, null, aiNotes) });
    expect(unchanged).toMatchObject({ outcome: 'unchanged', version: 2 });
  });
});

describe('the AI notes capability and a source that changed', () => {
  it('refuses an append for an investigation whose source was re-pointed, as a draft write does, and writes nothing', async () => {
    const store = seeded({ sourceIdentityHash: 'another-identity' });
    const answer = await through(store, (notes) => append(notes, 'tok-1'));
    expect(answer).toMatchObject({ status: 409, body: { error: { details: { reason: 'source-changed' } } } });
    expect(store.drafts[0]?.aiNotes).toBeUndefined();
  });
});

describe('the AI notes capability: the check of a write', () => {
  it('resolves for an investigation that may be written and refuses as an append does, writing nothing', async () => {
    expect((await through(seeded(), async (notes) => (await notes.canWrite(ID), { ok: true }))).status).toBe(200);
    expect((await through(seeded({ status: 'closed' }), async (notes) => (await notes.canWrite(ID), { ok: true }))).status).toBe(409);
    expect((await through(seeded({ ownerId: OTHER }), async (notes) => (await notes.canWrite(ID), { ok: true }))).status).toBe(404);
    expect((await through(seeded({ sourceIdentityHash: 'another-identity' }), async (notes) => (await notes.canWrite(ID), { ok: true }))).body).toMatchObject({ error: { details: { reason: 'source-changed' } } });
    const store = seeded();
    await through(store, async (notes) => (await notes.canWrite(ID), { ok: true }));
    expect(store.drafts[0]?.aiNotes).toBeUndefined();
    expect(store.drafts[0]?.version).toBe(1);
  });
});
