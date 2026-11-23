import type { CaseSummarizer, CaseSummaryInput, CaseSummaryOutcome } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, VIEW_BODY, answerOf, nodeOf, ok, rig, routeAsk } from '../testing/assistant-rig.js';
import { buildToolRegistry, SUMMARY_TOOL } from './tool-registry.js';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';

afterAll(removeAskFolders);

const A1 = nodeOf('A-1').ref;
const A2 = nodeOf('A-2').ref;
const SHARED = routeAsk('shared', { id: 'A-1' });
const SUMMARY = ok('{"tool":"ai-summary","values":{}}');
const DONE = ok('{"done":true}');
const sentences = (...list: { text: string; cites: string[] }[]) => ok(JSON.stringify({ sentences: list }));
const sequence = (...replies: FixtureReply[]) => {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? DONE;
};
const draft = (over: Partial<Extract<CaseSummaryOutcome, { status: 'ok' }>> = {}): CaseSummaryOutcome => ({ status: 'ok', sentences: [{ text: 'Account A-1 is linked to Account A-2.', cites: ['n1', 'n2'], storable: true }], citations: [{ key: 'n1', kind: 'entity', ref: A1 }, { key: 'n2', kind: 'entity', ref: A2 }], coverage: { retrieval: 'x', summary: 'y' }, removedCount: 0, sent: '', model: 'm', calls: 1, summaryToken: 'tok', ...over });
const summarizer = (outcome: CaseSummaryOutcome, seen: CaseSummaryInput[] = [], over: Partial<CaseSummarizer> = {}): CaseSummarizer => ({
  maxElements: 300,
  availability: () => ({ available: true }),
  summarize: async (input) => {
    seen.push(input);
    return outcome;
  },
  ...over,
});
const readsOf = (answer: unknown): readonly Record<string, unknown>[] => (answer as { reads?: readonly Record<string, unknown>[] }).reads ?? [];

describe('the summary in the registry', () => {
  const registry = (summary?: boolean) => buildToolRegistry({ source: undefined, patterns: undefined, viewReadable: true, templateRunnable: () => true, ...(summary === undefined ? {} : { summary }) });
  it('is a tool of its own kind with no values when it can be drafted, and absent otherwise', () => {
    expect(registry(true).find(SUMMARY_TOOL)).toMatchObject({ name: 'ai-summary', kind: 'ai-summary', parameters: [], available: true });
    expect(registry(false).find(SUMMARY_TOOL)).toBeUndefined();
    expect(registry().find(SUMMARY_TOOL)).toBeUndefined();
  });
});

describe('a turn that drafts the AI case summary', () => {
  const turn = (answer: FixtureReply, extra: { maxCalls?: number } = {}) => rig({ reply: SHARED, step: sequence(SUMMARY, DONE), answer, ...extra });

  it('is not offered when the summarizer is not available or the view is empty', async () => {
    const off = await turn(sentences({ text: 'x', cites: ['r1'] }));
    await answerOf(off.route.handler(off.request(VIEW_BODY)));
    const empty = await turn(sentences({ text: 'x', cites: ['r1'] }));
    await answerOf(empty.route.handler(empty.request({ ...BODY, viewElementKeys: [] }, { caseSummarizer: summarizer(draft()) })));
  });

  it('reads the elements in view once through the gate when the turn has no reading, counts those rows, and gives the summarizer the calls the turn can spare', async () => {
    const seen: CaseSummaryInput[] = [];
    const r = await turn(sentences({ text: 'Account A-1 is linked to Account A-2.', cites: ['a1'] }));
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY, { caseSummarizer: summarizer(draft(), seen) })));
    expect(seen).toHaveLength(1);
    expect(r.elementReads).toHaveLength(1);
    expect(seen[0]?.reading.nodes).toHaveLength(2);
    // 5 calls: the router and the step call are made, one is kept for the answer
    expect(seen[0]?.maxCalls).toBe(4);
    expect(readsOf(answer).find((entry) => entry['kind'] === 'ai-summary')).toMatchObject({ tool: 'ai-summary', read: true, rows: 2, quality: 'exact', partial: false });
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ cites: ['r1', 'r2'] }] });
  });

  it('counts every call the summarizer made in the turn\'s calls', async () => {
    const r = await turn(sentences({ text: 'Account A-1 is linked to Account A-2.', cites: ['a1'] }));
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY, { caseSummarizer: summarizer(draft({ calls: 2 })) })));
    // the router, the agent's calls (the first read, the summary, the answer, the last) and the two calls of the summary
    expect(answer).toMatchObject({ status: 'answered', calls: 7 });
  });

  it('uses the reading of the view the turn already has and makes no read of its own', async () => {
    const seen: CaseSummaryInput[] = [];
    const r = await rig({ reply: ok('{"route":"view"}'), step: sequence(ok('{"tool":"view","values":{}}'), SUMMARY, DONE), answer: sentences({ text: 'Account A-1 is linked to Account A-2.', cites: ['a1'] }) });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY, { caseSummarizer: summarizer(draft(), seen) })));
    expect(seen).toHaveLength(1);
    // the one read of the elements is the view's own
    expect(r.elementReads).toHaveLength(1);
    expect(readsOf(answer).find((entry) => entry['kind'] === 'ai-summary')).toMatchObject({ rows: 0 });
  });

  it('is not drafted when the turn has no call to spare, and the turn answers over what it has', async () => {
    const seen: CaseSummaryInput[] = [];
    const r = await turn(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }), { maxCalls: 4 });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY, { caseSummarizer: summarizer(draft(), seen) })));
    expect(seen).toEqual([]);
    expect(answer.status).toBe('answered');
  });

  it.each([
    ['failed', { status: 'failed', kind: 'timeout', calls: 1 } as CaseSummaryOutcome],
    ['unsupported', { status: 'unsupported', removedCount: 2, coverage: { retrieval: 'x', summary: 'y' }, sent: '', model: 'm', calls: 2 } as CaseSummaryOutcome],
    ['time limit', { status: 'timeLimit', calls: 1 } as CaseSummaryOutcome],
    ['too large for its text', { status: 'tooLarge', limit: 'text', estimatedTokens: 9, cap: 5 } as CaseSummaryOutcome],
  ])('reads as not drafted, with no sentence, when the summarizer answers %s, and the turn goes on', async (_name, outcome) => {
    const r = await turn(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }));
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY, { caseSummarizer: summarizer(outcome) })));
    expect(answer.status).toBe('answered');
    expect(readsOf(answer).find((entry) => entry['kind'] === 'ai-summary')).toMatchObject({ read: false });
  });

  it('is not started for a view over the summarizer\'s own element limit, and nothing is read', async () => {
    const seen: CaseSummaryInput[] = [];
    const r = await turn(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }));
    await answerOf(r.route.handler(r.request(VIEW_BODY, { caseSummarizer: summarizer(draft(), seen, { maxElements: 1 }) })));
    expect(seen).toEqual([]);
    expect(r.elementReads).toHaveLength(0);
  });

  it('reads and drafts with the masking of the turn', async () => {
    const seen: CaseSummaryInput[] = [];
    const r = await turn(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }));
    await answerOf(r.route.handler(r.request({ ...VIEW_BODY, mask: true }, { caseSummarizer: summarizer(draft(), seen) })));
    expect(r.elementReads[0]?.mask).toBe(true);
    expect(seen[0]?.request.mask).toBe(true);
  });
});
