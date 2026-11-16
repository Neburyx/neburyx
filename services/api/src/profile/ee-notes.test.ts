import { rmSync } from 'node:fs';
import { aiNotesResponseSchema, copyToNotesResponseSchema, type CaseSummarizer, type ProfileExtension } from '@neburyx/contracts';
import { createCopyToNotesRoute, createReadAiNotesRoute, sealToken } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_IDENTITY } from '../testing/app-store.js';
import { el, exportWebRoot, startExportRig } from '../testing/export-rig.js';

afterAll(() => rmSync(exportWebRoot, { recursive: true, force: true }));

const keys = { current: { kid: 'abcd1234', bytes: Buffer.alloc(32, 9) } };
const extension: ProfileExtension = { name: 'notes', routeGroups: [{ routes: [createCopyToNotesRoute({ tokenKeys: () => keys }), createReadAiNotesRoute({ maxRefs: () => 300 })] }] };
const summarizer: CaseSummarizer = { maxElements: 300, availability: () => ({ available: true }), summarize: async () => ({ status: 'timeLimit', calls: 1 }) };
const OTHER_PERSON = '0192f000-0000-7000-8000-0000000000bb';
const W1 = el('widget', 'W-1');
const W2 = el('widget', 'W-2');

async function rigOf(personId: string | undefined, options: { readonly unexportableNode?: string; readonly policyVersion?: () => string; readonly name?: (id: string) => string } = {}) {
  const rig = await startExportRig({ extension, previewOn: true, caseSummarizer: summarizer, widgets: ['W-1', 'W-2'], principal: () => ({ role: 'investigator', ...(personId === undefined ? {} : { id: personId }) }), ...options });
  const investigation = await rig.open();
  return { rig, investigationId: investigation.id };
}

/** The sealed token of a draft the person generated: one sentence about both widgets, one about the second only. */
function tokenOf(investigationId: string, personId: string, over: { readonly now?: number; readonly policyVersion?: string; readonly generatedBy?: string } = {}): string {
  const placeholders = (names: readonly [string, typeof W1][]) => names.map(([name, ref]) => ({ name, descriptor: { kind: 'entity' as const, ref } }));
  return sealToken(
    keys,
    {
      investigationId,
      generatedBy: over.generatedBy ?? personId,
      policyVersion: over.policyVersion ?? 'none',
      modelRef: 'claude-sonnet-5-5',
      promptId: 'case-summary',
      promptVersion: '1',
      sentences: [{ text: 'Widget one is linked to widget two.', cites: ['n1', 'n2'] }, { text: 'Widget two is listed.', cites: ['n2'] }],
      inputRefs: [{ key: 'n1', kind: 'entity', ref: W1 }, { key: 'n2', kind: 'entity', ref: W2 }],
      propertyValuesSent: false,
      runId: '0192f000-0000-7000-8000-0000000000aa',
      mask: false,
      wordListVersion: 1,
      templates: [
        { storable: true, text: '‹widget#1› is linked to ‹widget#2›.', placeholders: placeholders([['‹widget#1›', W1], ['‹widget#2›', W2]]) },
        { storable: true, text: '‹widget#2› is listed.', placeholders: placeholders([['‹widget#2›', W2]]) },
      ],
    },
    over.now ?? Date.now(),
  );
}

type Rig = Awaited<ReturnType<typeof rigOf>>;
const copy = (h: Rig, token: string, version = 1, id = h.investigationId) => h.rig.app.inject({ method: 'POST', url: `/v1/investigations/${id}/draft/ai-notes`, payload: { summaryToken: token, version } });
const notes = (h: Rig, id = h.investigationId) => h.rig.app.inject({ url: `/v1/investigations/${id}/draft/ai-notes?mask=false` });
const textsOf = async (h: Rig): Promise<string[][]> => aiNotesResponseSchema.parse((await notes(h)).json()).entries.map((entry) => entry.sentences.map((sentence) => sentence.text));

describe('AI notes read by a second person', () => {
  it('shows each person the sentences their own access allows: a sentence citing an element they cannot see is omitted for them, without a message, and shown to the author', async () => {
    const author = await rigOf(undefined, { name: (id) => `Widget ${id}` });
    const second = await rigOf(OTHER_PERSON, { unexportableNode: 'W-2', name: (id) => `Widget ${id}` });
    expect((await copy(author, tokenOf(author.investigationId, LOCAL_IDENTITY.principal.id))).statusCode).toBe(200);
    expect((await copy(second, tokenOf(second.investigationId, OTHER_PERSON))).statusCode).toBe(200);
    expect(await textsOf(author)).toEqual([['Widget W-1 is linked to Widget W-2.', 'Widget W-2 is listed.']]);
    const theirs = await notes(second);
    expect(theirs.statusCode).toBe(200);
    const entries = aiNotesResponseSchema.parse(theirs.json()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sentences).toEqual([]);
    expect(theirs.body).not.toMatch(/removed|dropped|hidden from you/i);
    await author.rig.stop();
    await second.rig.stop();
  });

  it('answers not found for another person\'s investigation on the read, and ACCESS_DENIED on the copy', async () => {
    const author = await rigOf(undefined);
    const second = await rigOf(OTHER_PERSON);
    expect((await notes(author, second.investigationId)).statusCode).toBe(404);
    expect((await copy(author, tokenOf(second.investigationId, OTHER_PERSON), 1, second.investigationId)).statusCode).toBe(403);
    await author.rig.stop();
    await second.rig.stop();
  });
});

describe('copy to notes refuses what it must, through the real mount, and stores nothing', () => {
  it.each([
    ['an expired token', (h: Rig) => tokenOf(h.investigationId, LOCAL_IDENTITY.principal.id, { now: Date.now() - 31 * 60 * 1000 })],
    ['another person\'s token', (h: Rig) => tokenOf(h.investigationId, LOCAL_IDENTITY.principal.id, { generatedBy: OTHER_PERSON })],
    ['a token for another investigation', (h: Rig) => tokenOf('0192f000-0000-7000-8000-0000000000c2', LOCAL_IDENTITY.principal.id)],
    ['a token of another policy version', (h: Rig) => tokenOf(h.investigationId, LOCAL_IDENTITY.principal.id, { policyVersion: 'p0' })],
  ])('refuses %s', async (_name, make) => {
    const h = await rigOf(undefined);
    const answer = await copy(h, make(h));
    expect(answer.statusCode).toBe(403);
    expect(await textsOf(h)).toEqual([]);
    await h.rig.stop();
  });

  it('copies once for a token: a second copy answers that it was copied before, and the stored notes hold one entry', async () => {
    const h = await rigOf(undefined);
    const token = tokenOf(h.investigationId, LOCAL_IDENTITY.principal.id);
    const first = copyToNotesResponseSchema.parse((await copy(h, token)).json());
    const again = copyToNotesResponseSchema.parse((await copy(h, token, first.version)).json());
    expect(first).toMatchObject({ copied: 2, notCopied: 0, alreadyCopied: false });
    expect(again).toMatchObject({ copied: 0, notCopied: 0, alreadyCopied: true, version: first.version });
    expect(await textsOf(h)).toHaveLength(1);
    await h.rig.stop();
  });

  it('stores nothing when nobody copies: reading the notes before and after a token is made shows an empty list', async () => {
    const h = await rigOf(undefined);
    tokenOf(h.investigationId, LOCAL_IDENTITY.principal.id);
    expect(await textsOf(h)).toEqual([]);
    await h.rig.stop();
  });
});
