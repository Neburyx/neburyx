import type { AuditEvent, CaseSummaryInput, GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AuditUnavailableError, createAuditedModelCall } from '../audited.js';
import { promptRecordOf, type ModelProvider, type ModelRequest } from '../provider.js';
import { buildSummaryInstructions } from './instructions.js';
import { openToken } from './token.js';
import { createCaseSummarizer, SummaryHandled } from './summarizer.js';
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
  const summarizer = createCaseSummarizer({ settings: used, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, availability: () => ({ available: true }) });
  return { summarizer, requests, events };
}

describe('the case summarizer', () => {
  it('drafts, answering the sentences, the exact text sent in the first call, the model and the number of calls', async () => {
    const { summarizer, requests } = summarizerWith([GOOD]);
    const answer = await summarizer.summarize(input(), new AbortController().signal);
    expect(answer).toEqual({
      status: 'ok',
      sentences: [{ text: 'A fixed sentence.', cites: ['n1'] }],
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
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => undefined, audit: () => undefined, tokenKeys: () => KEYS, availability: () => ({ available: false, reason: 'x' }) });
    await expect(summarizer.summarize(input(), new AbortController().signal)).rejects.toThrow('not available');
  });

  it('is unavailable without a size guard, naming the setting', async () => {
    const { maxInputTokens: _guard, ...withoutGuard } = settings;
    const summarizer = createCaseSummarizer({ settings: withoutGuard, instructions, model: () => undefined, audit: () => undefined, tokenKeys: () => KEYS, availability: () => ({ available: false, reason: 'NEBURYX_SUMMARY_MAX_INPUT_TOKENS is not set' }) });
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
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async () => Promise.reject(new Error('down')) }), tokenKeys: () => KEYS, availability: () => ({ available: true }) });
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
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, availability: () => ({ available: true }) });
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
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, availability: () => ({ available: true }) });
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
    const summarizer = createCaseSummarizer({ settings: { ...settings, totalTimeoutMs: 1000 }, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, availability: () => ({ available: true }), now: () => clock });
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
    const summarizer = createCaseSummarizer({ settings, instructions, model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, availability: () => ({ available: true }) });
    await expect(summarizer.summarize(input(), controller.signal)).rejects.toBeInstanceOf(SummaryHandled);
    expect(events.filter((event) => event.action === 'ai.case-summary.closed')[0]).toMatchObject({ result: 'failed', detail: { summary: { outcome: 'cancelled', calls: 2, sentencesKept: 0, sentencesRemoved: 2 } } });
  });
});
