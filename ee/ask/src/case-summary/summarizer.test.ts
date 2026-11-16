import type { AuditEvent, CaseSummaryInput, GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AuditUnavailableError, createAuditedModelCall } from '../audited.js';
import { promptRecordOf, type ModelProvider, type ModelRequest } from '../provider.js';
import { buildSummaryInstructions } from './instructions.js';
import { openToken } from './token.js';
import { createMemorySummaryRunStore } from './run-store.js';
import { createCaseSummarizer, SummaryHandled, type ReplyObservation } from './summarizer.js';
import type { SummarySettings } from './settings.js';

const instructions = buildSummaryInstructions('PROMPT', 'TYPOLOGY');
const KEYS = { current: { kid: 'abcd1234', bytes: Buffer.alloc(32, 7) } };
const settings: SummarySettings = { model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 5, maxElements: 300, maxInputTokens: 100_000, retentionDays: 30 };
const GOOD = JSON.stringify({ sentences: [{ text: 'A fixed sentence.', cites: ['n1'] }] });

const node: GraphNode = { ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, display: { title: 'Ana Silva', type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
const input = (overrides: Partial<CaseSummaryInput['reading']> = {}): CaseSummaryInput => ({
  actorId: 'a',
  actorRole: 'investigator',
  traceId: 't',
  policyVersion: 'p1',
  request: { investigationId: '0192f000-0000-7000-8000-000000000042', sourceId: 'demo', entities: [], edges: [], aggregates: [], derived: [] },
  reading: { nodes: [node], edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0, ...overrides },
});

function summarizerWith(replies: readonly string[], overrides: Partial<SummarySettings> = {}) {
  const requests: ModelRequest[] = [];
  const events: AuditEvent[] = [];
  let index = 0;
  const provider: ModelProvider = {
    complete: async (request) => {
      requests.push(request);
      return { status: 'ok', text: replies[Math.min(index++, replies.length - 1)] ?? GOOD, usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) };
    },
  };
  const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async (event) => void events.push(event) } });
  const used = { ...settings, ...overrides };
  const summarizer = createCaseSummarizer({ settings: used, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, runs: () => createMemorySummaryRunStore(), availability: () => ({ available: true }) });
  return { summarizer, requests, events };
}

describe('the case summarizer', () => {
  it('drafts, answering the sentences, the exact text sent in the first call, the model and the number of calls', async () => {
    const { summarizer, requests } = summarizerWith([GOOD]);
    const answer = await summarizer.summarize(input(), new AbortController().signal);
    expect(answer).toEqual({
      status: 'ok',
      sentences: [{ text: 'A fixed sentence.', cites: ['n1'], storable: false }],
      citations: [{ key: 'n1', kind: 'entity', ref: node.ref }],
      coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 1 of the 1 shown elements.' },
      removedCount: 0,
      sent: requests[0]?.values,
      model: 'claude-sonnet-5-5',
      calls: 1,
      summaryToken: expect.stringMatching(/^v1\.abcd1234\./),
    });
    expect(requests[0]?.instructions).toBe(instructions.text);
    expect(requests[0]?.values).toContain('n1 | "widget" | title: "Ana Silva"');
  });

  it('sends the same text in a repeated call as in the first, apart from the fixed note', async () => {
    const { summarizer, requests } = summarizerWith(['nope', GOOD]);
    const answer = await summarizer.summarize(input(), new AbortController().signal);
    expect(answer).toMatchObject({ status: 'ok', calls: 2 });
    expect(answer.status === 'ok' ? answer.sent : '').toBe(requests[0]?.values);
    expect(requests[1]?.values.startsWith(requests[0]?.values ?? 'x')).toBe(true);
  });

  it('refuses a text over the size guard as tooLarge and makes no call', async () => {
    const { summarizer, requests, events } = summarizerWith([GOOD], { maxInputTokens: 5 });
    const answer = await summarizer.summarize(input(), new AbortController().signal);
    expect(answer).toMatchObject({ status: 'tooLarge', limit: 'text', cap: 5 });
    expect(requests).toEqual([]);
    expect(events.map((event) => event.action)).toEqual(['ai.case-summary.closed']);
  });

  it('reports the element cap it holds to the route', () => {
    expect(summarizerWith([GOOD], { maxElements: 42 }).summarizer.maxElements).toBe(42);
  });

  it('is not asked while unavailable', async () => {
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => undefined, audit: () => undefined, tokenKeys: () => KEYS, runs: () => createMemorySummaryRunStore(), availability: () => ({ available: false, reason: 'x' }) });
    await expect(summarizer.summarize(input(), new AbortController().signal)).rejects.toThrow('not available');
  });

  it('is unavailable without a size guard, naming the setting', async () => {
    const { maxInputTokens: _guard, ...withoutGuard } = settings;
    const summarizer = createCaseSummarizer({ settings: withoutGuard, instructions, model: () => undefined, audit: () => undefined, tokenKeys: () => KEYS, runs: () => createMemorySummaryRunStore(), availability: () => ({ available: false, reason: 'NEBURYX_SUMMARY_MAX_INPUT_TOKENS is not set' }) });
    expect(summarizer.availability()).toEqual({ available: false, reason: 'NEBURYX_SUMMARY_MAX_INPUT_TOKENS is not set' });
    await expect(summarizer.summarize(input(), new AbortController().signal)).rejects.toThrow();
  });
});

describe('the closing event of a click', () => {
  const closing = (events: readonly AuditEvent[]) => events.filter((event) => event.action === 'ai.case-summary.closed');

  it('is exactly one, holding counts, hashes, the model and prompt, and the outcome', async () => {
    const { summarizer, events } = summarizerWith(['nope', GOOD]);
    await summarizer.summarize(input(), new AbortController().signal);
    expect(closing(events)).toHaveLength(1);
    expect(closing(events)[0]).toMatchObject({
      actorId: 'a',
      actorRole: 'investigator',
      result: 'success',
      sourceId: 'demo',
      investigationId: '0192f000-0000-7000-8000-000000000042',
      detail: { summary: { elements: 0, calls: 2, modelRef: 'claude-sonnet-5-5', promptId: 'case-summary', promptVersion: '1', instructionsSha256: instructions.sha256, outcome: 'ok' } },
    });
    expect(events.filter((event) => event.action === 'ai.case-summary')).toHaveLength(2);
  });

  it.each([
    ['a refusal of the text size', { maxInputTokens: 5 }, 'tooLarge', 'refused', 0],
    ['a format failure', { maxCalls: 1 }, 'format', 'failed', 1],
  ])('is recorded for %s', async (_name, overrides, outcome, result, calls) => {
    const { summarizer, events } = summarizerWith(['nope'], overrides);
    await summarizer.summarize(input(), new AbortController().signal);
    expect(closing(events)).toHaveLength(1);
    expect(closing(events)[0]).toMatchObject({ result, detail: { summary: { outcome, calls } } });
  });

  it('holds no instructions, text sent, reply, element value or key', async () => {
    const { summarizer, events } = summarizerWith(['SECRET-REPLY', GOOD]);
    await summarizer.summarize(input(), new AbortController().signal);
    const text = JSON.stringify(events);
    for (const secret of ['SECRET-REPLY', 'PROMPT', 'TYPOLOGY', 'Ana Silva', 'n1 |']) expect(text).not.toContain(secret);
  });

  it('fails the click closed when the closing event cannot be written', async () => {
    const provider: ModelProvider = { complete: async (request) => ({ status: 'ok', text: GOOD, usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) }) };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => undefined } });
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async () => Promise.reject(new Error('down')) }), tokenKeys: () => KEYS, runs: () => createMemorySummaryRunStore(), availability: () => ({ available: true }) });
    await expect(summarizer.summarize(input(), new AbortController().signal)).rejects.toBeInstanceOf(AuditUnavailableError);
  });
});

describe('the closing event of a click that is interrupted', () => {
  it('says how many calls were made when the client gives up after a repair call, and the failure is passed on as handled', async () => {
    const controller = new AbortController();
    const events: AuditEvent[] = [];
    let seen = 0;
    const provider: ModelProvider = {
      complete: async (request) => {
        seen += 1;
        if (seen === 2) controller.abort();
        return { status: 'ok', text: 'nope', usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) };
      },
    };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async (event) => void events.push(event) } });
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, runs: () => createMemorySummaryRunStore(), availability: () => ({ available: true }) });
    await expect(summarizer.summarize(input(), controller.signal)).rejects.toBeInstanceOf(SummaryHandled);
    const closed = events.filter((event) => event.action === 'ai.case-summary.closed');
    expect(events.filter((event) => event.action === 'ai.case-summary')).toHaveLength(2);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ result: 'failed', detail: { summary: { outcome: 'cancelled', calls: 2, modelRef: 'claude-sonnet-5-5' } } });
  });
});

describe('the checks in the click', () => {
  const reply = (...sentences: { text: string; cites: string[] }[]) => JSON.stringify({ sentences });
  const closed = (events: readonly AuditEvent[]) => events.filter((event) => event.action === 'ai.case-summary.closed');

  it('answers partial when a sentence is removed and the others are kept, with the count removed and the token holding only the kept', async () => {
    const { summarizer, events } = summarizerWith([reply({ text: 'A fixed sentence.', cites: ['n1'] }, { text: 'An uncited sentence.', cites: [] })]);
    const answer = await summarizer.summarize(input(), new AbortController().signal);
    expect(answer).toMatchObject({ status: 'partial', removedCount: 1, sentences: [{ text: 'A fixed sentence.', cites: ['n1'] }] });
    const opened = openToken(KEYS, answer.status === 'partial' ? answer.summaryToken : '', { investigationId: '0192f000-0000-7000-8000-000000000042', actorId: 'a', policyVersion: 'p1', now: Date.now() });
    expect(opened.ok && opened.payload.sentences).toEqual([{ text: 'A fixed sentence.', cites: ['n1'] }]);
    expect(closed(events)[0]).toMatchObject({ result: 'partial', detail: { summary: { outcome: 'partial', sentencesKept: 1, sentencesRemoved: 1 } } });
  });

  it('makes one more call with a fixed note when nothing passes, and answers unsupported when the calls are used up', async () => {
    const { summarizer, requests, events } = summarizerWith([reply({ text: 'An uncited sentence.', cites: [] })], { maxCalls: 2 });
    const answer = await summarizer.summarize(input(), new AbortController().signal);
    expect(answer).toMatchObject({ status: 'unsupported', removedCount: 1, calls: 2 });
    expect(answer).not.toHaveProperty('sentences');
    expect(answer).not.toHaveProperty('summaryToken');
    expect(requests[1]?.values.endsWith('No sentence of your last reply passed the checks. Reply again, with sentences that cite the elements given.')).toBe(true);
    expect(closed(events)[0]).toMatchObject({ result: 'failed', detail: { summary: { outcome: 'unsupported', calls: 2, sentencesKept: 0, sentencesRemoved: 1 } } });
  });

  it('treats an empty list as nothing left, and makes the further call', async () => {
    const { summarizer, requests } = summarizerWith([reply(), reply({ text: 'A fixed sentence.', cites: ['n1'] })]);
    expect(await summarizer.summarize(input(), new AbortController().signal)).toMatchObject({ status: 'ok', calls: 2 });
    expect(requests).toHaveLength(2);
  });

  it('makes a further call with the conclusion note for a verdict, checks the new reply in full, and removes the verdict sentences when the calls are used up', async () => {
    const verdict = reply({ text: 'The widget is guilty.', cites: ['n1'] }, { text: 'A fixed sentence.', cites: ['n1'] });
    const { summarizer, requests } = summarizerWith([verdict], { maxCalls: 3 });
    const answer = await summarizer.summarize(input(), new AbortController().signal);
    expect(requests).toHaveLength(3);
    expect(requests[1]?.values.endsWith('Your last reply stated a conclusion. Describe only what the elements show.')).toBe(true);
    expect(answer).toMatchObject({ status: 'partial', removedCount: 1, calls: 3, sentences: [{ text: 'A fixed sentence.', cites: ['n1'] }] });
  });

  it('never makes more calls than the limit, whatever the checks find', async () => {
    const { summarizer, requests } = summarizerWith([reply({ text: 'The widget is guilty.', cites: ['n1'] })], { maxCalls: 2 });
    await summarizer.summarize(input(), new AbortController().signal);
    expect(requests).toHaveLength(2);
  });

  it('keeps the counts of the last checked reply in the closing event when a later call fails', async () => {
    const events: AuditEvent[] = [];
    let seen = 0;
    const provider: ModelProvider = {
      complete: async (request) => {
        seen += 1;
        if (seen === 2) return { status: 'failed', code: 'unreachable', prompt: promptRecordOf(request) };
        return { status: 'ok', text: reply({ text: 'An uncited sentence.', cites: [] }), usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) };
      },
    };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => undefined } });
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, runs: () => createMemorySummaryRunStore(), availability: () => ({ available: true }) });
    expect(await summarizer.summarize(input(), new AbortController().signal)).toMatchObject({ status: 'failed', kind: 'unreachable', calls: 2 });
    expect(closed(events)[0]).toMatchObject({ detail: { summary: { outcome: 'unreachable', calls: 2, sentencesKept: 0, sentencesRemoved: 1 } } });
  });
});

describe('the closing event of a click that ends before or after the checks', () => {
  const closed = (events: readonly AuditEvent[]) => events.filter((event) => event.action === 'ai.case-summary.closed');
  const reply = (...sentences: { text: string; cites: string[] }[]) => JSON.stringify({ sentences });

  it('holds no counts when no reply was checked, for a format failure and a refusal of the text size', async () => {
    const format = summarizerWith(['nope'], { maxCalls: 1 });
    await format.summarizer.summarize(input(), new AbortController().signal);
    expect(closed(format.events)[0]?.detail).toMatchObject({ summary: { outcome: 'format' } });
    expect(closed(format.events)[0]?.detail).not.toHaveProperty('summary.sentencesKept');
    const size = summarizerWith([GOOD], { maxInputTokens: 5 });
    await size.summarizer.summarize(input(), new AbortController().signal);
    expect(closed(size.events)[0]?.detail).not.toHaveProperty('summary.sentencesRemoved');
  });

  it('keeps the counts of the last checked reply when the time limit ends a later call', async () => {
    let clock = 0;
    const events: AuditEvent[] = [];
    let seen = 0;
    const provider: ModelProvider = {
      complete: async (request) => {
        seen += 1;
        clock += seen === 1 ? 10 : 1_000_000;
        return { status: 'ok', text: reply({ text: 'An uncited sentence.', cites: [] }), usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) };
      },
    };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => undefined } });
    const summarizer = createCaseSummarizer({ settings: { ...settings, totalTimeoutMs: 1000 }, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, runs: () => createMemorySummaryRunStore(), availability: () => ({ available: true }), now: () => clock });
    expect(await summarizer.summarize(input(), new AbortController().signal)).toMatchObject({ status: 'timeLimit' });
    expect(closed(events)[0]).toMatchObject({ detail: { summary: { outcome: 'timeLimit', sentencesKept: 0, sentencesRemoved: 1 } } });
  });
});

describe('the closing event of a click that is cancelled after a checked reply', () => {
  it('keeps the counts of the reply that was checked', async () => {
    const controller = new AbortController();
    const events: AuditEvent[] = [];
    let seen = 0;
    const provider: ModelProvider = {
      complete: async (request) => {
        seen += 1;
        if (seen === 2) controller.abort();
        return { status: 'ok', text: JSON.stringify({ sentences: [{ text: 'An uncited sentence.', cites: [] }, { text: 'Another uncited sentence.', cites: [] }] }), usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) };
      },
    };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => undefined } });
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, runs: () => createMemorySummaryRunStore(), availability: () => ({ available: true }) });
    await expect(summarizer.summarize(input(), controller.signal)).rejects.toBeInstanceOf(SummaryHandled);
    expect(events.filter((event) => event.action === 'ai.case-summary.closed')[0]).toMatchObject({ result: 'failed', detail: { summary: { outcome: 'cancelled', calls: 2, sentencesKept: 0, sentencesRemoved: 2 } } });
  });
});

describe('the record of a click', () => {
  function recorded(replies: readonly string[], store = createMemorySummaryRunStore(), overrides: Partial<SummarySettings> = {}) {
    const events: AuditEvent[] = [];
    const requests: ModelRequest[] = [];
    let index = 0;
    const provider: ModelProvider = {
      complete: async (request) => {
        requests.push(request);
        return { status: 'ok', text: replies[Math.min(index++, replies.length - 1)] ?? GOOD, usage: { kind: 'known', inputTokens: 9, outputTokens: 3 }, model: 'm', prompt: promptRecordOf(request) };
      },
    };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async (event) => void events.push(event) } });
    const summarizer = createCaseSummarizer({ settings: { ...settings, ...overrides }, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, runs: () => store, availability: () => ({ available: true }) });
    return { summarizer, store, events, requests };
  }

  it('writes the run, each call before it is made with the exact text sent, the reply text and the end of the run', async () => {
    const { summarizer, store, requests } = recorded(['nope', GOOD]);
    await summarizer.summarize(input(), new AbortController().signal);
    const [run] = store.runs;
    expect(store.runs).toHaveLength(1);
    expect(run?.start).toMatchObject({ actorId: 'a', investigationId: '0192f000-0000-7000-8000-000000000042', sourceId: 'demo', traceId: 't', settings: { model: 'claude-sonnet-5-5', maxCalls: 5, maxElements: 300 } });
    expect(run?.callStarts.map((call) => call.number)).toEqual([1, 2]);
    expect(run?.callStarts[0]?.valuesText).toBe(requests[0]?.values);
    expect(run?.callStarts[0]?.instructionsText).toBe(requests[0]?.instructions);
    expect(run?.callEnds.map((call) => [call.number, call.status, call.replyText, call.tokensIn, call.tokensOut])).toEqual([[1, 'answered', 'nope', 9, 3], [2, 'answered', GOOD, 9, 3]]);
    expect(run).toMatchObject({ outcome: 'ok', calls: 2 });
  });

  it('puts the run id in the per-call events and in the closing event', async () => {
    const { summarizer, store, events } = recorded([GOOD]);
    await summarizer.summarize(input(), new AbortController().signal);
    const runId = store.runs[0]?.id;
    expect(runId).toBeDefined();
    for (const event of events) expect(JSON.stringify(event.detail)).toContain(runId as string);
    expect(events.map((event) => event.action)).toEqual(['ai.case-summary', 'ai.case-summary.closed']);
  });

  it('keeps the text of a rejected reply out of the answer and every event, and in the record only', async () => {
    const rejected = JSON.stringify({ sentences: [{ text: 'CANARY-REJECTED-SENTENCE about Zed.', cites: [] }] });
    const { summarizer, store, events } = recorded([rejected, GOOD]);
    const answer = await summarizer.summarize(input(), new AbortController().signal);
    expect(JSON.stringify(answer)).not.toContain('CANARY-REJECTED-SENTENCE');
    expect(JSON.stringify(events)).not.toContain('CANARY-REJECTED-SENTENCE');
    expect(store.runs[0]?.callEnds[0]?.replyText).toContain('CANARY-REJECTED-SENTENCE');
  });

  it('records a run with no call when the input is too large, with its outcome', async () => {
    const { summarizer, store } = recorded([GOOD], undefined, { maxInputTokens: 1 });
    await summarizer.summarize(input(), new AbortController().signal);
    expect(store.runs[0]).toMatchObject({ outcome: 'tooLarge', calls: 0, callStarts: [] });
  });

  it('records a cancelled call when the client gives up, and the run as cancelled', async () => {
    const controller = new AbortController();
    const store = createMemorySummaryRunStore();
    const provider: ModelProvider = { complete: async () => (controller.abort(), Promise.reject(new Error('aborted'))) };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => undefined } });
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async () => undefined }), tokenKeys: () => KEYS, runs: () => store, availability: () => ({ available: true }) });
    await expect(summarizer.summarize(input(), controller.signal)).rejects.toBeInstanceOf(SummaryHandled);
    expect(store.runs[0]?.callEnds[0]).toMatchObject({ number: 1, status: 'cancelled' });
    expect(store.runs[0]?.outcome).toBe('cancelled');
  });

  it.each(['begin', 'beginCall', 'endCall', 'finish'] as const)('fails the click closed when the record cannot be written at %s', async (step) => {
    const { summarizer, requests } = recorded([GOOD], createMemorySummaryRunStore({ failOn: step }));
    await expect(summarizer.summarize(input(), new AbortController().signal)).rejects.toBeInstanceOf(AuditUnavailableError);
    if (step === 'begin' || step === 'beginCall') expect(requests).toHaveLength(0);
  });

  it('keeps the reply text and the real status of a call whose audit event could not be written, and fails the click closed', async () => {
    const store = createMemorySummaryRunStore();
    const provider: ModelProvider = { complete: async (request) => ({ status: 'ok', text: 'CANARY-REPLY', usage: { kind: 'known', inputTokens: 7, outputTokens: 2 }, model: 'm', prompt: promptRecordOf(request) }) };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => Promise.reject(new Error('down')) } });
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async () => undefined }), tokenKeys: () => KEYS, runs: () => store, availability: () => ({ available: true }) });
    await expect(summarizer.summarize(input(), new AbortController().signal)).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(store.runs[0]?.callEnds[0]).toMatchObject({ number: 1, status: 'answered', replyText: 'CANARY-REPLY', tokensIn: 7, tokensOut: 2 });
    expect(store.runs[0]?.outcome).toBe('auditFailed');
  });

  it('fails closed when the end of a call cannot be written after the provider failed or the client gave up, instead of answering with the failure', async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      const store = createMemorySummaryRunStore({ failOn: 'endCall' });
      const provider: ModelProvider = { complete: async () => (cancel ? controller.abort() : undefined, Promise.reject(new Error('provider down'))) };
      const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => undefined } });
      const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async () => undefined }), tokenKeys: () => KEYS, runs: () => store, availability: () => ({ available: true }) });
      await expect(summarizer.summarize(input(), controller.signal)).rejects.toBeInstanceOf(AuditUnavailableError);
    }
  });

  it('ends the run row before the closing event is written, and writes no success event when the row cannot end', async () => {
    const order: string[] = [];
    const store = createMemorySummaryRunStore();
    const finish = store.finish.bind(store);
    store.finish = async (...args) => (order.push(`finish:${args[1]}`), finish(...args));
    const { summarizer, events } = recorded([GOOD], store);
    const original = events.push.bind(events);
    events.push = (...items) => (order.push(...items.map((event) => event.action)), original(...items));
    await summarizer.summarize(input(), new AbortController().signal);
    expect(order.indexOf('finish:ok')).toBeLessThan(order.indexOf('ai.case-summary.closed'));

    const failing = recorded([GOOD], createMemorySummaryRunStore({ failOn: 'finish' }));
    await expect(failing.summarizer.summarize(input(), new AbortController().signal)).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(failing.events.filter((event) => event.action === 'ai.case-summary.closed')).toHaveLength(0);
  });

  it('marks the run row auditFailed when the closing event cannot be written', async () => {
    const store = createMemorySummaryRunStore();
    const provider: ModelProvider = { complete: async (request) => ({ status: 'ok', text: GOOD, usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) }) };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => undefined } });
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async () => Promise.reject(new Error('down')) }), tokenKeys: () => KEYS, runs: () => store, availability: () => ({ available: true }) });
    await expect(summarizer.summarize(input(), new AbortController().signal)).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(store.runs[0]?.outcome).toBe('auditFailed');
  });

  it('ends the run row and fails closed on an unexpected failure when the row cannot end, and keeps the failure when only the event cannot be written', async () => {
    const boom: ModelProvider = { complete: async () => Promise.reject(new Error('provider down')) };
    const model = createAuditedModelCall({ provider: boom, configuration: { model: 'm' }, sink: { record: async () => undefined } });
    const make = (store: ReturnType<typeof createMemorySummaryRunStore>, audit: () => { record: () => Promise<void> }) => createCaseSummarizer({ settings, instructions, model: () => model, audit, tokenKeys: () => KEYS, runs: () => store, availability: () => ({ available: true }) });
    await expect(make(createMemorySummaryRunStore({ failOn: 'finish' }), () => ({ record: async () => undefined })).summarize(input(), new AbortController().signal)).rejects.toBeInstanceOf(AuditUnavailableError);
    await expect(make(createMemorySummaryRunStore(), () => ({ record: async () => Promise.reject(new Error('down')) })).summarize(input(), new AbortController().signal)).rejects.toBeInstanceOf(SummaryHandled);
  });

  it('records an early end with a run row and a closing event that name each other, and fails closed when either cannot be written', async () => {
    const events: AuditEvent[] = [];
    const store = createMemorySummaryRunStore();
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => undefined, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, runs: () => store, availability: () => ({ available: true }) });
    const end = { actorId: 'a', actorRole: 'investigator' as const, traceId: 't', request: input().request, outcome: 'tooLarge' as const };
    await summarizer.recordEarlyEnd?.(end);
    expect(store.runs[0]).toMatchObject({ outcome: 'tooLarge', calls: 0 });
    expect(events[0]).toMatchObject({ action: 'ai.case-summary.closed', result: 'refused', detail: { summary: { outcome: 'tooLarge', calls: 0, runId: store.runs[0]?.id } } });
    const failing = createCaseSummarizer({ settings, instructions, model: () => undefined, audit: () => ({ record: async () => undefined }), tokenKeys: () => KEYS, runs: () => createMemorySummaryRunStore({ failOn: 'begin' }), availability: () => ({ available: true }) });
    await expect(failing.recordEarlyEnd?.(end)).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it('is unavailable (fails closed) when there is no store', async () => {
    const provider: ModelProvider = { complete: async (request) => ({ status: 'ok', text: GOOD, usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) }) };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => undefined } });
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async () => undefined }), tokenKeys: () => KEYS, runs: () => undefined, availability: () => ({ available: true }) });
    await expect(summarizer.summarize(input(), new AbortController().signal)).rejects.toBeInstanceOf(AuditUnavailableError);
  });
});

describe('a click the client cancels while the record of it is written', () => {
  function cancelling(step: 'beginCall' | 'endCall' | 'finish', overrides: Partial<SummarySettings> = {}, rejecting = false) {
    const controller = new AbortController();
    const base = createMemorySummaryRunStore();
    let done = false;
    const store = {
      ...base,
      [step]: async (...args: never[]) => {
        if (!done) (done = true), controller.abort();
        return (base[step] as (...values: never[]) => Promise<void>)(...args);
      },
    };
    const events: AuditEvent[] = [];
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = { complete: async (request) => (requests.push(request), rejecting ? Promise.reject(new Error('down')) : { status: 'ok', text: GOOD, usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) }) };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async (event) => void events.push(event) } });
    const summarizer = createCaseSummarizer({ settings: { ...settings, ...overrides }, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, runs: () => store, availability: () => ({ available: true }) });
    return { summarizer, controller, base, events, requests };
  }
  const closing = (events: AuditEvent[]) => events.filter((event) => event.action === 'ai.case-summary.closed');

  it('never asks the model when the cancel arrives while the call is recorded as begun, and ends that call as cancelled', async () => {
    const { summarizer, controller, base, events, requests } = cancelling('beginCall');
    await expect(summarizer.summarize(input(), controller.signal)).rejects.toBeInstanceOf(SummaryHandled);
    expect(requests).toEqual([]);
    expect(base.runs[0]?.callEnds[0]).toMatchObject({ number: 1, status: 'cancelled' });
    expect(base.runs[0]).toMatchObject({ outcome: 'cancelled', calls: 0 });
    expect(closing(events)[0]).toMatchObject({ detail: { summary: { outcome: 'cancelled', calls: 0 } } });
  });

  it('marks a call whose provider failed cancelled when the cancel arrives while its end is recorded', async () => {
    const { summarizer, controller, base } = cancelling('endCall', {}, true);
    await expect(summarizer.summarize(input(), controller.signal)).rejects.toBeInstanceOf(SummaryHandled);
    expect(base.runs[0]?.callEnds).toHaveLength(1);
    expect(base.runs[0]?.callEnds[0]).toMatchObject({ number: 1, status: 'cancelled' });
    expect(base.runs[0]?.outcome).toBe('cancelled');
  });

  it('marks the call cancelled when the cancel arrives while its answer is recorded', async () => {
    const { summarizer, controller, base, events } = cancelling('endCall');
    await expect(summarizer.summarize(input(), controller.signal)).rejects.toBeInstanceOf(SummaryHandled);
    expect(base.runs[0]?.callEnds).toHaveLength(1);
    expect(base.runs[0]?.callEnds[0]).toMatchObject({ number: 1, status: 'cancelled' });
    expect(base.runs[0]?.outcome).toBe('cancelled');
    expect(closing(events).map((event) => event.result)).toEqual(['failed']);
  });

  it('ends the run and the closing event as cancelled, not ok, when the cancel arrives while the run row is finished', async () => {
    const { summarizer, controller, base, events } = cancelling('finish');
    await expect(summarizer.summarize(input(), controller.signal)).rejects.toBeInstanceOf(SummaryHandled);
    expect(base.runs[0]?.outcome).toBe('cancelled');
    // the call itself was answered before the cancel; only the click is cancelled
    expect(base.runs[0]?.callEnds[0]).toMatchObject({ number: 1, status: 'answered' });
    expect(closing(events)).toHaveLength(1);
    expect(closing(events)[0]).toMatchObject({ result: 'failed', detail: { summary: { outcome: 'cancelled' } } });
  });

  it('changes nothing when the cancel arrives while the closing event is being written: the draft is returned, one event, the run and the call as they were', async () => {
    const controller = new AbortController();
    const base = createMemorySummaryRunStore();
    const events: AuditEvent[] = [];
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = { complete: async (request) => (requests.push(request), { status: 'ok', text: GOOD, usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) }) };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => undefined } });
    const sink = {
      record: async (event: AuditEvent) => {
        if (event.action === 'ai.case-summary.closed') {
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        events.push(event);
      },
    };
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => sink, tokenKeys: () => KEYS, runs: () => base, availability: () => ({ available: true }) });
    const answer = await summarizer.summarize(input(), controller.signal);
    expect(answer.status).toBe('ok');
    expect(requests).toHaveLength(1);
    expect(closing(events)).toHaveLength(1);
    expect(closing(events)[0]).toMatchObject({ result: 'success', detail: { summary: { outcome: 'ok', calls: 1 } } });
    expect(base.runs[0]).toMatchObject({ outcome: 'ok', calls: 1 });
    expect(base.runs[0]?.callEnds[0]).toMatchObject({ number: 1, status: 'answered' });
  });

  it('ends a click that was cancelled before its text was measured as cancelled, not as too large', async () => {
    const { summarizer, base, events, requests } = cancelling('finish', { maxInputTokens: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(summarizer.summarize(input(), controller.signal)).rejects.toBeInstanceOf(SummaryHandled);
    expect(requests).toEqual([]);
    expect(base.runs[0]?.outcome).toBe('cancelled');
    expect(closing(events)[0]).toMatchObject({ detail: { summary: { outcome: 'cancelled' } } });
  });
});

describe('the observer of the checks', () => {
  const WRITTEN = [
    { text: 'A fixed sentence.', cites: ['n1'] },
    { text: 'The record is listed (n1).', cites: ['n1'] },
    { text: 'No source here.', cites: [] },
  ];
  const build = (replies: readonly string[], observe?: Parameters<typeof createCaseSummarizer>[0]['observe']) => {
    const events: AuditEvent[] = [];
    const store = createMemorySummaryRunStore();
    let index = 0;
    const provider: ModelProvider = {
      complete: async (request) => ({ status: 'ok', text: replies[Math.min(index++, replies.length - 1)] ?? GOOD, usage: { kind: 'known', inputTokens: 9, outputTokens: 3 }, model: 'm', prompt: promptRecordOf(request) }),
    };
    const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async (event) => void events.push(event) } });
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, runs: () => store, availability: () => ({ available: true }), ...(observe === undefined ? {} : { observe }) });
    return { summarizer, events, store };
  };
  const run = async (replies: readonly string[], observe?: Parameters<typeof createCaseSummarizer>[0]['observe']) => {
    const rig = build(replies, observe);
    const outcome = await rig.summarizer.summarize(input(), new AbortController().signal);
    return { ...rig, outcome };
  };
  const strip = (result: Awaited<ReturnType<typeof run>>) => JSON.stringify({ outcome: { ...result.outcome, summaryToken: 'x' }, events: result.events, runs: result.store.runs.map((entry) => ({ ...entry, id: 'x', start: { ...entry.start, startedAt: 0 }, callStarts: entry.callStarts.map((call) => ({ ...call, startedAt: 0 })), callEnds: entry.callEnds.map((call) => ({ ...call, durationMs: 0 })), finishedAt: 0 })) });

  it('changes nothing either when the observer is asynchronous and rejects', async () => {
    const replies = [JSON.stringify({ sentences: WRITTEN })];
    const plain = strip(await run(replies));
    const rejecting = strip(await run(replies, async () => { throw new Error('later'); }));
    expect(rejecting).toBe(plain);
  });

  it('is told, for each reply the checks judge, the sentences written and kept and the counts, and a click with two replies gives two observations', async () => {
    const seen: ReplyObservation[] = [];
    const verdict = { text: 'This is evidence of fraud.', cites: ['n1'] };
    await run([JSON.stringify({ sentences: [...WRITTEN, verdict] }), JSON.stringify({ sentences: WRITTEN.slice(0, 1) })], (observation) => void seen.push(observation));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ removed: 2, keysStripped: 1, keysRemoved: 0, verdictFound: true });
    expect(seen[1]).toMatchObject({ removed: 0, verdictFound: false });
    expect(seen[0]?.written).toEqual([...WRITTEN, verdict]);
    expect(seen[0]?.kept.map((sentence) => sentence.text)).toEqual(['A fixed sentence.', 'The record is listed.']);
  });

  it('changes nothing of the answer, the events or the record, whether it is absent, throws, or changes what it was given', async () => {
    const replies = [JSON.stringify({ sentences: WRITTEN })];
    const plain = strip(await run(replies));
    const throwing = strip(await run(replies, () => { throw new Error('boom'); }));
    const mutating = strip(await run(replies, (observation) => {
      // the observer is typed read-only: the test breaks that on purpose to prove that what it holds is a copy
      (observation.written as { text: string; cites: string[] }[]).forEach((sentence) => { sentence.text = 'CHANGED'; sentence.cites.push('n99'); });
      (observation.kept as unknown[]).length = 0;
    }));
    expect(throwing).toBe(plain);
    expect(mutating).toBe(plain);
  });
});
