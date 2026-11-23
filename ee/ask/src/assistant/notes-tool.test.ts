import { AI_NOTES_MAX_SENTENCES, ExtensionRefusal, type AiNotesCapability } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { answerOf, nodeOf, ok, rig, routeAsk } from '../testing/assistant-rig.js';
import { buildToolRegistry, NOTES_TOOL } from './tool-registry.js';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';

afterAll(removeAskFolders);

const A1 = nodeOf('A-1').ref;
const A2 = nodeOf('A-2').ref;
const SHARED = routeAsk('shared', { id: 'A-1' });
const NOTES = ok('{"tool":"ai-notes","values":{}}');
const DONE = ok('{"done":true}');
const sentences = (...list: { text: string; cites: string[] }[]) => ok(JSON.stringify({ sentences: list }));
const sequence = (...replies: FixtureReply[]) => {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? DONE;
};

const stored = (tokenId: string, sentenceCount = 1): Record<string, unknown> => ({
  tokenId,
  generatedBy: 'person-1',
  modelRef: 'claude-sonnet-5-5',
  promptId: 'case-summary',
  promptVersion: '1',
  generatedAt: '2026-11-15T10:00:00.000Z',
  wordListVersion: 2,
  label: 'AI-drafted',
  sentences: Array.from({ length: sentenceCount }, () => ({ text: '‹widget#1› is linked to ‹widget#2›.', placeholders: [{ name: '‹widget#1›', descriptor: { kind: 'entity', ref: A1 } }, { name: '‹widget#2›', descriptor: { kind: 'entity', ref: A2 } }], cites: [{ key: 'n1', kind: 'entity', ref: A1 }, { key: 'n2', kind: 'entity', ref: A2 }] })),
  inputRefs: [{ key: 'n1', kind: 'entity', ref: A1 }, { key: 'n2', kind: 'entity', ref: A2 }],
});

const capability = (entries: Record<string, unknown>[], seen: string[] = [], refuse?: Error): AiNotesCapability => ({
  append: async () => Promise.reject(new Error('the assistant writes nothing')),
  canWrite: async () => undefined,
  read: async (investigationId) => {
    seen.push(investigationId);
    if (refuse !== undefined) throw refuse;
    return { entries, version: 1, save: { state: 'unsaved', savedAt: null } };
  },
});

const turn = (answer: FixtureReply) => rig({ reply: SHARED, step: sequence(NOTES, DONE), answer });
const readsOf = (answer: unknown): readonly Record<string, unknown>[] => (answer as { reads?: readonly Record<string, unknown>[] }).reads ?? [];

describe('the notes in the registry', () => {
  const registry = (notes?: boolean) => buildToolRegistry({ source: undefined, patterns: undefined, viewReadable: false, templateRunnable: () => true, ...(notes === undefined ? {} : { notes }) });
  it('is a tool of its own kind with no values when the turn has the capability, and absent without it', () => {
    expect(registry(true).find(NOTES_TOOL)).toMatchObject({ name: 'ai-notes', kind: 'ai-notes', parameters: [], available: true });
    expect(registry(false).find(NOTES_TOOL)).toBeUndefined();
    expect(registry().find(NOTES_TOOL)).toBeUndefined();
  });
});

describe('a turn that reads the person\'s own AI notes', () => {
  it('reads the notes of the turn\'s own investigation, lists a read of its kind with the rows of the gate\'s read, and gives each sentence a key with the elements it rests on', async () => {
    const seen: string[] = [];
    const r = await turn(sentences({ text: 'Account A-1 is linked to Account A-2.', cites: ['a1'] }));
    const answer = await answerOf(r.route.handler(r.request(undefined, { aiNotes: capability([stored('tok-1')], seen) })));
    expect(seen).toEqual(['inv-1']);
    expect(readsOf(answer).find((entry) => entry['kind'] === 'ai-notes')).toMatchObject({ tool: 'ai-notes', read: true, rows: 2, quality: 'exact', partial: false });
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ cites: ['r1', 'r2'] }] });
  });

  it('holds a sentence that cites an a key to the elements it rests on: a figure only the note states is dropped, and a key that was not returned is dropped', async () => {
    const r = await turn(sentences({ text: 'There are 17 widgets in the note.', cites: ['a1'] }, { text: 'Account A-1 is linked to Account A-2.', cites: ['a9'] }, { text: 'Account A-1 is linked to Account A-2 (a1).', cites: ['a1'] }));
    const answer = await answerOf(r.route.handler(r.request(undefined, { aiNotes: capability([stored('tok-1')]) })));
    expect((answer as { sentences: { text: string }[] }).sentences.map((sentence) => sentence.text)).toEqual(['Account A-1 is linked to Account A-2.']);
  });

  it('takes the a key out of a mixed bracketed group of keys and keeps the others, so a sentence that cites both is not dropped', async () => {
    const r = await turn(sentences({ text: 'Account A-1 is linked to Account A-2 (a1, r1).', cites: ['a1', 'r1'] }));
    const answer = await answerOf(r.route.handler(r.request(undefined, { aiNotes: capability([stored('tok-1')]) })));
    expect((answer as { sentences: { text: string }[] }).sentences.map((sentence) => sentence.text)).toEqual(['Account A-1 is linked to Account A-2.']);
  });

  it('does not return an entry over the bounds of an entry, says how many were not read without any wording, and lists the read as partial', async () => {
    const r = await turn(sentences({ text: 'Account A-1 is linked to Account A-2.', cites: ['a1'] }));
    const answer = await answerOf(r.route.handler(r.request(undefined, { aiNotes: capability([stored('tok-1'), stored('tok-2', AI_NOTES_MAX_SENTENCES + 1), { tokenId: 'tok-3', nonsense: true }]) })));
    expect(readsOf(answer).find((entry) => entry['kind'] === 'ai-notes')).toMatchObject({ partial: true });
  });

  it('lists the read as not run and goes on when the draft is not the caller\'s', async () => {
    const r = await turn(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }));
    const answer = await answerOf(r.route.handler(r.request(undefined, { aiNotes: capability([], [], new ExtensionRefusal({ code: 'NOT_FOUND' })) })));
    expect(answer.status).toBe('answered');
    expect(readsOf(answer).find((entry) => entry['kind'] === 'ai-notes')).toMatchObject({ read: false });
  });

  it('reads a refusal of the application that is not the extension\'s own (an error with the code NOT_FOUND) as the same: not read, and the turn goes on', async () => {
    const r = await turn(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }));
    const notFound = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    const answer = await answerOf(r.route.handler(r.request(undefined, { aiNotes: capability([], [], notFound) })));
    expect(answer.status).toBe('answered');
    expect(readsOf(answer).find((entry) => entry['kind'] === 'ai-notes')).toMatchObject({ read: false });
  });

  it('answers unavailable, and keeps no sentence of the notes, when the gate fails while the elements are read', async () => {
    const r = await rig({ reply: SHARED, step: sequence(NOTES, DONE), answer: sentences({ text: 'x', cites: ['a1'] }), viewReadThrows: new ExtensionRefusal({ code: 'SOURCE_UNAVAILABLE', reason: 'unreachable' }) });
    const answer = await answerOf(r.route.handler(r.request(undefined, { aiNotes: capability([stored('tok-1')]) })));
    expect(answer.status).toBe('unavailable');
    expect(JSON.stringify(answer)).not.toContain('is linked to');
  });

  it('never calls the capability\'s append', async () => {
    const calls: string[] = [];
    const base = capability([stored('tok-1')]);
    const watched: AiNotesCapability = { ...base, append: async (call) => (calls.push('append'), base.append(call)) };
    const r = await turn(sentences({ text: 'Account A-1 is linked to Account A-2.', cites: ['a1'] }));
    await answerOf(r.route.handler(r.request(undefined, { aiNotes: watched })));
    expect(calls).toEqual([]);
  });
});
