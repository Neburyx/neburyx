import { AI_NOTES_MAX_ENTRIES, AI_NOTES_MAX_SENTENCES, aiNotesResponseSchema, ExtensionRefusal, type AiNotesCapability, type ElementRefs, type ElementsScope, type ExtensionRequest, type GraphNode, type SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createReadAiNotesRoute } from './notes-read-route.js';

const ref = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
const W1 = ref('widget', 'W-1');
const W2 = ref('widget', 'W-2');
const node = (r: ReturnType<typeof ref>, title: string): GraphNode => ({ ref: r, display: { title, type: r.entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const reading = (nodes: GraphNode[], over: Partial<SummaryReading> = {}): SummaryReading => ({ nodes, edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0, ...over });

const stored = (tokenId: string, sentences: unknown[] = [{ text: '‹widget#1› is linked to ‹widget#2›.', placeholders: [{ name: '‹widget#1›', descriptor: { kind: 'entity', ref: W1 } }, { name: '‹widget#2›', descriptor: { kind: 'entity', ref: W2 } }], cites: [{ key: 'n1', kind: 'entity', ref: W1 }] }]) => ({
  tokenId,
  generatedBy: 'person-1',
  modelRef: 'claude-sonnet-5-5',
  promptId: 'case-summary',
  promptVersion: '1',
  generatedAt: '2026-11-15T10:00:00.000Z',
  wordListVersion: 2,
  label: 'AI-drafted',
  sentences,
  inputRefs: [{ key: 'n1', kind: 'entity', ref: W1 }, { key: 'n2', kind: 'entity', ref: W2 }],
});

function rig(entries: Record<string, unknown>[], seen: { scope?: ElementsScope; refs?: ElementRefs[] } = {}, read: SummaryReading = reading([node(W1, 'Ana Silva'), node(W2, 'Bo Chen')]), maxElements = 300): ExtensionRequest {
  const aiNotes: AiNotesCapability = { append: async () => Promise.reject(new Error('no')), canWrite: async () => undefined, read: async () => ({ entries, version: 3, save: { state: 'unsaved', savedAt: null } }) };
  return {
    principalId: 'person-2',
    principalRole: 'viewer',
    previewOn: true,
    traceId: 'tr-1',
    audit: { record: async () => undefined },
    askClassifier: { availability: () => ({ available: false, reason: 'x' }), classify: async () => ({ status: 'failed' }) } as never,
    caseSummarizer: { maxElements, availability: () => ({ available: true }), summarize: async () => ({ status: 'timeLimit', calls: 1 }) },
    signal: new AbortController().signal,
    investigation: { id: '0192f000-0000-7000-8000-0000000000c1', sourceId: 'demo' },
    query: { mask: 'false' },
    aiNotes,
    investigationReadable: async () => undefined,
    askSourceReadable: async () => undefined,
    readElements: async (scope, refs) => {
      seen.scope = scope;
      seen.refs = [...(seen.refs ?? []), refs];
      return read;
    },
  };
}

const route = (maxRefs = 300) => createReadAiNotesRoute({ maxRefs: () => maxRefs });
const call = async (request: ExtensionRequest, maxRefs = 300) => aiNotesResponseSchema.parse(await route(maxRefs).handler(request));

describe('reading the stored AI notes', () => {
  it('rebuilds each entry for the viewer in one batch of the references of all entries', async () => {
    const seen: { scope?: ElementsScope; refs?: ElementRefs[] } = {};
    const answer = await call(rig([stored('tok-1'), stored('tok-2')], seen));
    expect(seen.refs).toHaveLength(1);
    expect(seen.refs?.[0]?.entities).toEqual([W1, W2]);
    expect(seen.scope).toEqual({ investigationId: '0192f000-0000-7000-8000-0000000000c1', sourceId: 'demo', mask: false });
    expect(answer.entries.map((entry) => entry.sentences.map((sentence) => sentence.text))).toEqual([['Ana Silva is linked to Bo Chen.'], ['Ana Silva is linked to Bo Chen.']]);
    expect(answer.entries[0]).toMatchObject({ tokenId: 'tok-1', label: 'AI-drafted', model: 'claude-sonnet-5-5', generatedAt: '2026-11-15T10:00:00.000Z', coverage: '2 of 2 elements this summary was made from are shown to you' });
  });

  it('asks for masking when the viewer masks, and builds the coverage line for what the viewer\'s re-read left out', async () => {
    const seen: { scope?: ElementsScope; refs?: ElementRefs[] } = {};
    const masked = { ...rig([stored('tok-1')], seen, reading([node(W1, 'A••• S•••'), node(W2, 'B• C•')], { omitted: true })), query: { mask: 'true' } };
    const answer = await call(masked);
    expect(seen.scope?.mask).toBe(true);
    expect(answer.entries[0]?.sentences[0]?.text).toBe('A••• S••• is linked to B• C•.');
    expect(answer.entries[0]?.coverage).toBe('2 of 2 elements this summary was made from are shown to you');
  });

  it('leaves out, with no message, a sentence the viewer cannot see, and still returns the entry', async () => {
    const answer = await call(rig([stored('tok-1')], {}, reading([node(W1, 'Ana Silva')])));
    expect(answer.entries).toHaveLength(1);
    expect(answer.entries[0]?.sentences).toEqual([]);
    expect(JSON.stringify(answer)).not.toMatch(/removed|dropped|hidden from you/i);
  });

  it('answers an empty list with no read at all when nothing is stored', async () => {
    const seen: { refs?: ElementRefs[] } = {};
    expect(await call(rig([], seen))).toEqual({ entries: [], skipped: [] });
    expect(seen.refs).toBeUndefined();
  });

  it('does not read an entry over the bounds of an entry or one that is not of the stored shape, and names it', async () => {
    const long = stored('tok-long', Array.from({ length: AI_NOTES_MAX_SENTENCES + 1 }, () => ({ text: 'a', placeholders: [], cites: [] })));
    const many = stored('tok-many');
    const broken = { tokenId: 'tok-broken', sentences: 'no' };
    const answer = await call(rig([long, many, broken], {}, reading([node(W1, 'Ana Silva'), node(W2, 'Bo Chen')])), 1);
    expect(answer.skipped).toEqual([{ tokenId: 'tok-long', reason: 'too-large' }, { tokenId: 'tok-many', reason: 'too-large' }, { tokenId: 'tok-broken', reason: 'unreadable' }]);
    expect(answer.entries).toEqual([]);
  });

  it('checks that the caller may still read the source when nothing is stored or every entry is skipped, so revoked access is refused', async () => {
    const revokedSource = { ...rig([]), askSourceReadable: async () => Promise.reject(new Error('no access')) };
    await expect(route().handler(revokedSource)).rejects.toThrow('no access');
    const skippedRevoked = { ...rig([{ tokenId: 'tok-x', sentences: 'no' }]), askSourceReadable: async () => Promise.reject(new Error('no access')) };
    await expect(route().handler(skippedRevoked)).rejects.toThrow('no access');
  });

  it('checks that the investigation and its source are still readable even when nothing is stored or every entry is skipped', async () => {
    const revoked = { ...rig([]), investigationReadable: async () => Promise.reject(new Error('gone')) };
    await expect(route().handler(revoked)).rejects.toThrow('gone');
    const skippedOnly = { ...rig([{ tokenId: 'tok-x', sentences: 'no' }]), investigationReadable: async () => Promise.reject(new Error('gone')) };
    await expect(route().handler(skippedOnly)).rejects.toThrow('gone');
  });

  it('does not read an entry whose citations and placeholders name more elements than the bound, though its inputRefs are few', async () => {
    const cites = Array.from({ length: 10 }, (_value, index) => ({ key: `n${index}`, kind: 'entity', ref: ref('widget', `X-${index}`) }));
    const answer = await call(rig([stored('tok-wide', [{ text: 'a', placeholders: [], cites }])]), 5);
    expect(answer.skipped).toEqual([{ tokenId: 'tok-wide', reason: 'too-large' }]);
  });

  it('reads at most the entries a draft may hold, and names the rest as too large', async () => {
    const many = Array.from({ length: AI_NOTES_MAX_ENTRIES + 2 }, (_value, index) => stored(`tok-${index}`));
    const answer = await call(rig(many));
    expect(answer.entries).toHaveLength(AI_NOTES_MAX_ENTRIES);
    expect(answer.skipped.map((entry) => entry.reason)).toEqual(['too-large', 'too-large']);
  });

  it('gives each entry the coverage of its own elements, not one line for the whole read', async () => {
    const wide = { ...stored('tok-wide'), inputRefs: [...stored('x').inputRefs, { key: 'n3', kind: 'entity', ref: ref('widget', 'W-3') }] };
    const answer = await call(rig([stored('tok-1'), wide]));
    expect(answer.entries.map((entry) => entry.coverage)).toEqual(['2 of 2 elements this summary was made from are shown to you', '2 of 3 elements this summary was made from are shown to you']);
  });

  it('reads the notes whatever the state of the generation seam: the read bound is its own', async () => {
    const answer = await call({ ...rig([stored('tok-1')]), caseSummarizer: { maxElements: 0, availability: () => ({ available: false, reason: 'unset' }), summarize: async () => ({ status: 'timeLimit', calls: 1 }) } });
    expect(answer.entries).toHaveLength(1);
  });

  it('is available to a viewer and refuses when it has no capability or no reader', async () => {
    expect((await call(rig([]))).entries).toEqual([]);
    const { aiNotes: _gone, ...without } = rig([]);
    await expect(route().handler(without)).rejects.toBeInstanceOf(ExtensionRefusal);
    const { readElements: _reader, ...unread } = rig([]);
    await expect(route().handler(unread)).rejects.toBeInstanceOf(ExtensionRefusal);
  });
});
