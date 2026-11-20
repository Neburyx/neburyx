import type { AiNotesCapability, AssistantTurnAnswer, CaseSummarizer, CaseSummaryInput } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, VIEW_BODY, answerOf, heavyResult, nodeOf, ok, okResult, rig, routeAsk, type Rig } from '../testing/assistant-rig.js';
import { SummaryHandled } from '../case-summary/summarizer.js';
import { createMemoryAssistantPendingStore } from './pending-store.js';
import { TURN_CLOSED_ACTION } from './turn-audit.js';

afterAll(removeAskFolders);

const A1 = nodeOf('A-1').ref;
const A2 = nodeOf('A-2').ref;
const LINES = ['Fan-in: many sources send money to one receiver.'];
const SHARED = routeAsk('shared', { id: 'A-1' });
const DONE = ok('{"done":true}');
const tool = (name: string, values: Record<string, string> = {}) => ok(JSON.stringify({ tool: name, values }));
const GOOD = ok(JSON.stringify({ sentences: [{ text: 'Account A-1 is listed.', cites: ['r1'] }] }));
const sequence = (...replies: FixtureReply[]) => {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? DONE;
};

const stored = {
  tokenId: 'tok-1',
  generatedBy: 'person-1',
  modelRef: 'claude-sonnet-5-5',
  promptId: 'case-summary',
  promptVersion: '1',
  generatedAt: '2026-11-15T10:00:00.000Z',
  wordListVersion: 2,
  label: 'AI-drafted',
  sentences: [{ text: '‹widget#1› is linked to ‹widget#2›.', placeholders: [{ name: '‹widget#1›', descriptor: { kind: 'entity', ref: A1 } }, { name: '‹widget#2›', descriptor: { kind: 'entity', ref: A2 } }], cites: [{ key: 'n1', kind: 'entity', ref: A1 }, { key: 'n2', kind: 'entity', ref: A2 }] }],
  inputRefs: [{ key: 'n1', kind: 'entity', ref: A1 }, { key: 'n2', kind: 'entity', ref: A2 }],
};

function capabilities(counts: { notes: number; summaries: CaseSummaryInput[] }, onNotes?: () => void) {
  const aiNotes: AiNotesCapability = {
    append: async () => Promise.reject(new Error('the assistant writes nothing')),
    canWrite: async () => undefined,
    read: async () => {
      counts.notes += 1;
      onNotes?.();
      return { entries: [stored], version: 1, save: { state: 'unsaved', savedAt: null } };
    },
  };
  const caseSummarizer: CaseSummarizer = {
    maxElements: 300,
    availability: () => ({ available: true }),
    summarize: async (input) => {
      counts.summaries.push(input);
      return { status: 'ok', sentences: [{ text: 'Account A-1 is linked to Account A-2.', cites: ['n1', 'n2'], storable: true }], citations: [{ key: 'n1', kind: 'entity', ref: A1 }, { key: 'n2', kind: 'entity', ref: A2 }], coverage: { retrieval: 'x', summary: 'y' }, removedCount: 0, sent: '', model: 'm', calls: 2, summaryToken: 'tok' };
    },
  };
  return { aiNotes, caseSummarizer };
}

const runOf = (continuing: boolean, asked: unknown) => (JSON.stringify(asked).includes('A-9') && !continuing ? { status: 'ok' as const, result: heavyResult() } : { status: 'ok' as const, result: okResult() });
const closings = (r: Rig) => r.events.filter((event) => event.action === TURN_CLOSED_ACTION).map((event) => (event.detail as { turn: Record<string, unknown> }).turn);
const readsOf = (answer: unknown): readonly Record<string, unknown>[] => (answer as { reads?: readonly Record<string, unknown>[] }).reads ?? [];

describe('the application tools across a confirmation', () => {
  it('reads the typology and the notes again after the analyst confirms, does not draft the summary again, and makes no call for it', async () => {
    const counts = { notes: 0, summaries: [] as CaseSummaryInput[] };
    const over = capabilities(counts);
    const pending = createMemoryAssistantPendingStore();
    const r = await rig({ reply: SHARED, maxCalls: 10, loopSteps: 8, step: sequence(tool('typology'), tool('ai-notes'), tool('ai-summary'), tool('byId', { id: 'A-9' }), DONE), answer: GOOD, pending, run: runOf, typology: LINES });
    const first = await answerOf(r.route.handler(r.request(VIEW_BODY, over)));
    if (first.status !== 'confirmation') throw new Error(`not waiting: ${JSON.stringify(first).slice(0, 200)}`);
    expect(counts.notes).toBe(1);
    expect(counts.summaries).toHaveLength(1);
    const answer = await answerOf(r.route.handler(r.request({ ...VIEW_BODY, confirmation: { pendingId: first.pendingId, plan: first.plan, decision: 'confirm' } }, over)));
    expect(answer.status).toBe('answered');
    expect(counts.notes).toBe(2);
    expect(counts.summaries).toHaveLength(1);
    const reads = readsOf(answer);
    expect(reads.filter((entry) => entry['kind'] === 'typology')).toHaveLength(1);
    expect(reads.find((entry) => entry['kind'] === 'ai-summary')).toMatchObject({ read: false });
    expect(r.fixture.calls.filter((call) => call.promptId === 'assistant.step').length).toBeGreaterThan(0);
  });
});

describe('the audit of a turn that used the application tools', () => {
  it('counts the summary\'s calls in the turn\'s calls and holds no wording, no sentence and no note text', async () => {
    const counts = { notes: 0, summaries: [] as CaseSummaryInput[] };
    const r = await rig({ reply: SHARED, maxCalls: 10, step: sequence(tool('typology'), tool('ai-notes'), tool('ai-summary'), DONE), answer: GOOD, typology: LINES });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY, capabilities(counts))));
    expect(answer.status).toBe('answered');
    const [turn] = closings(r);
    const own = r.fixture.calls.length;
    // the calls of the turn's own recording and the two calls of the summary
    expect(turn).toMatchObject({ modelCalls: own + 2, steps: 4 });
    const text = JSON.stringify(r.events);
    for (const secret of ['is linked to', 'Fan-in', 'many sources', 'Account A-1 is listed']) expect(text, secret).not.toContain(secret);
    expect(turn?.['promptId']).toBe('assistant.answer');
  });
});

describe('a summary that ends with the turn', () => {
  it('is given the turn\'s deadline, ends with it at the turn\'s time limit, and its calls are counted in the closing event', async () => {
    let received: AbortSignal | undefined;
    const caseSummarizer: CaseSummarizer = {
      maxElements: 300,
      availability: () => ({ available: true }),
      summarize: (input) =>
        new Promise((resolve) => {
          received = input.deadline;
          input.deadline?.addEventListener('abort', () => resolve({ status: 'timeLimit', calls: 1 }));
          queueMicrotask(() => r.expire());
        }),
    };
    const r = await rig({ reply: SHARED, maxCalls: 10, step: sequence(tool('ai-summary'), DONE), answer: GOOD });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY, { caseSummarizer })));
    expect(received?.aborted).toBe(true);
    expect(answer).toMatchObject({ status: 'limit', limit: 'time' });
    const [turn] = closings(r);
    expect(turn).toMatchObject({ modelCalls: r.fixture.calls.length + 1 });
  });

  it('ends the turn at its time limit when the summary throws after the deadline, and counts the calls it made', async () => {
    let received: AbortSignal | undefined;
    const caseSummarizer: CaseSummarizer = {
      maxElements: 300,
      availability: () => ({ available: true }),
      summarize: (input) =>
        new Promise((_resolve, reject) => {
          received = input.deadline;
          input.deadline?.addEventListener('abort', () => reject(new SummaryHandled(new Error('ended with the time limit'), 1)));
          queueMicrotask(() => r.expire());
        }),
    };
    const r = await rig({ reply: SHARED, maxCalls: 10, step: sequence(tool('ai-summary'), DONE), answer: GOOD });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY, { caseSummarizer })));
    expect(received?.aborted).toBe(true);
    expect(answer).toMatchObject({ status: 'limit', limit: 'time' });
    const [turn] = closings(r);
    expect(turn).toMatchObject({ modelCalls: r.fixture.calls.length + 1 });
  });
});

describe('a cancel during an application tool', () => {
  it('ends the turn as cancelled when the signal is raised during the read of the notes, and keeps no sentence of them', async () => {
    const counts = { notes: 0, summaries: [] as CaseSummaryInput[] };
    const controller = new AbortController();
    const over = { ...capabilities(counts, () => controller.abort()), signal: controller.signal };
    const r = await rig({ reply: SHARED, step: sequence(tool('ai-notes'), DONE), answer: GOOD });
    await expect(r.route.handler(r.request(BODY, over))).rejects.toThrow('the request was cancelled');
    expect(counts.notes).toBe(1);
    expect(r.fixture.calls.filter((call) => call.promptId === 'assistant.answer')).toHaveLength(0);
    expect(closings(r)).toMatchObject([{ outcome: 'cancelled' }]);
  });
});

describe('the steps limit and the application tools', () => {
  it('makes no step call and runs no application tool once the steps are used, and drafts the answer over what was read', async () => {
    const counts = { notes: 0, summaries: [] as CaseSummaryInput[] };
    const r = await rig({ reply: SHARED, loopSteps: 2, step: sequence(tool('typology'), tool('ai-notes'), DONE), answer: GOOD, typology: LINES });
    const answer: AssistantTurnAnswer = await answerOf(r.route.handler(r.request(BODY, capabilities(counts))));
    expect(answer.status).toBe('answered');
    expect(counts.notes).toBe(0);
    expect(r.fixture.calls.filter((call) => call.promptId === 'assistant.step')).toHaveLength(1);
  });
});
