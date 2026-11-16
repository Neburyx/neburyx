import { promptRecordOf, type ModelAnswer, type ModelRequest } from '@neburyx/ee-ask';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defined, expectNoText, hashOfValue, sha256Of, SuiteCheckFailed } from './checks.js';
import { loadCases, readingOf, type LabelledCase } from './cases.js';
import { failure, replyOf, startRig } from './rig.js';

const set = loadCases();
const first = (labelled: LabelledCase): string => defined(labelled.entities[0], 'an entity').name;

afterEach(() => vi.useRealTimers());

describe('the call limit', () => {
  it.each([undefined, 3])('makes exactly the configured number of requests, the default of five without a setting, for a provider whose reply never fits, on every view, and ends in the Error state (%s)', async (limit) => {
    for (const labelled of set.cases) {
      const rig = startRig({ replies: ['not a reply'], ...(limit === undefined ? {} : { settings: { maxCalls: limit } }) });
      const outcome = await rig.summarize(readingOf(labelled));
      expect(rig.requests, labelled.id).toHaveLength(limit ?? 5);
      expect(outcome).toMatchObject({ status: 'failed', kind: 'format', calls: limit ?? 5 });
      expect(rig.store.runs[0]).toMatchObject({ outcome: 'format', calls: limit ?? 5 });
    }
  });

  it('makes one further call for a reply that does not fit, with a fixed note and never the provider\'s text', async () => {
    for (const labelled of set.cases) {
      const rig = startRig({ replies: ['SENTINEL-PROVIDER-TEXT is not json', replyOf({ text: `${first(labelled)} is listed.`, cites: ['n1'] })] });
      const outcome = await rig.summarize(readingOf(labelled));
      expect(rig.requests, labelled.id).toHaveLength(2);
      expect(rig.requests[1]?.values).not.toContain('SENTINEL-PROVIDER-TEXT');
      expect(outcome.status).toBe('ok');
    }
  });
});

describe('the total time limit, on a clock the test moves', () => {
  it('aborts the call in flight when the clock passes the limit, makes no further call, and ends the click as timeLimit, on every view', async () => {
    const waiting = (request: ModelRequest, _call: number, signal: AbortSignal) =>
      new Promise<ModelAnswer>((resolve) => signal.addEventListener('abort', () => resolve({ status: 'failed', code: 'timeout', prompt: promptRecordOf(request) }), { once: true }));
    for (const labelled of set.cases) {
      vi.useFakeTimers();
      const rig = startRig({ replies: [waiting], settings: { totalTimeoutMs: 180_000 }, now: () => Date.now() });
      const pending = rig.summarize(readingOf(labelled));
      await vi.advanceTimersByTimeAsync(179_999);
      expect(rig.requests, labelled.id).toHaveLength(1);
      expect(rig.store.runs[0]?.outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      const outcome = await pending;
      vi.useRealTimers();
      expect(outcome, labelled.id).toMatchObject({ status: 'timeLimit', calls: 1 });
      expect(rig.requests).toHaveLength(1);
      expect(rig.store.runs[0]).toMatchObject({ outcome: 'timeLimit', calls: 1 });
      expect(rig.store.runs[0]?.callEnds[0]).toMatchObject({ status: 'cancelled', failureKind: 'timeLimit' });
    }
  });
});

describe('a cancel, over every view', () => {
  it('before the text is assembled makes no call and ends the run and its closing event cancelled', async () => {
    for (const labelled of set.cases) {
      const rig = startRig({ replies: [replyOf()] });
      const controller = new AbortController();
      controller.abort();
      await expect(rig.summarize(readingOf(labelled), controller.signal), labelled.id).rejects.toMatchObject({ name: 'SummaryHandled' });
      expect(rig.requests).toEqual([]);
      expect(rig.store.runs[0]).toMatchObject({ outcome: 'cancelled', calls: 0 });
      expect(rig.events.filter((event) => event.action === 'ai.case-summary.closed')[0]?.detail).toMatchObject({ summary: { outcome: 'cancelled', calls: 0 } });
    }
  });

  it('while the first call is in flight aborts it, makes no second call even for a late reply that would earn one, and ends the run cancelled', async () => {
    for (const labelled of set.cases) {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      const late = (_request: ModelRequest, _call: number, signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          seen = signal;
          signal.addEventListener('abort', () => resolve('not a reply'), { once: true });
          controller.abort();
        });
      const rig = startRig({ replies: [late] });
      await expect(rig.summarize(readingOf(labelled), controller.signal), labelled.id).rejects.toMatchObject({ name: 'SummaryHandled' });
      expect(seen?.aborted).toBe(true);
      expect(rig.requests).toHaveLength(1);
      expect(rig.store.runs[0]).toMatchObject({ outcome: 'cancelled', calls: 1 });
    }
  });
});

describe('the record of a click and its events', () => {
  it('holds, for each call, the exact instructions, the exact text sent and the exact reply, and the hash of the instructions as worked out here', async () => {
    for (const labelled of set.cases) {
      const replies = [`not a reply SENTINEL-REPLY-TEXT ${labelled.id}`, replyOf({ text: `${first(labelled)} is listed.`, cites: ['n1'] })];
      const rig = startRig({ replies });
      await rig.summarize(readingOf(labelled));
      const run = defined(rig.store.runs[0], 'the run');
      expect(run.callStarts, labelled.id).toHaveLength(2);
      run.callStarts.forEach((start, index) => {
        const request = defined(rig.requests[index], 'a request');
        expect(start.instructionsText).toBe(request.instructions);
        expect(start.valuesText).toBe(request.values);
        expect(start.instructionsSha256).toBe(sha256Of(defined(request.instructions, 'the instructions')));
        expect(defined(run.callEnds.find((end) => end.number === index + 1), 'the end of a call').replyText).toBe(replies[index]);
      });
    }
  });

  it('removes a run after the retention period and keeps one inside it, through the store the summarizer writes to; the schedule and the setting are proved by the retention tests of the extension', async () => {
    const labelled = defined(set.cases[0], 'a case');
    const rig = startRig({ replies: [replyOf({ text: `${first(labelled)} is listed.`, cites: ['n1'] })] });
    await rig.summarize(readingOf(labelled));
    const startedAt = defined(rig.store.runs[0], 'the run').start.startedAt;
    expect(await rig.store.removeStartedBefore(startedAt)).toBe(0);
    expect(rig.store.runs).toHaveLength(1);
    expect(await rig.store.removeStartedBefore(new Date(startedAt.getTime() + 1))).toBe(1);
    expect(rig.store.runs).toEqual([]);
  });

  it('is one per-call event for each request and one closing event, each with the run id and the model, the prompt, the instructions hash, the tokens, the counts and the outcome, and the hash of the elements as worked out here, and no text', async () => {
    for (const labelled of set.cases) {
      const rig = startRig({ replies: ['not a reply SENTINEL-REPLY-TEXT', replyOf({ text: `${first(labelled)} is listed.`, cites: ['n1'] })] });
      const view = readingOf(labelled);
      await rig.summarize(view);
      const runId = rig.store.runs[0]?.id;
      const perCall = rig.events.filter((event) => event.action === 'ai.case-summary');
      const closing = rig.events.filter((event) => event.action === 'ai.case-summary.closed');
      expect(perCall, labelled.id).toHaveLength(rig.requests.length);
      expect(closing).toHaveLength(1);
      for (const event of perCall) expect(event.detail).toMatchObject({ ai: { modelRef: 'claude-sonnet-5-5', promptId: 'case-summary', promptVersion: '1', promptSha256: rig.instructions.sha256, runId, tokensIn: 100, tokensOut: 20 } });
      const refs = [view.nodes.map((node) => node.ref), view.edges.filter((edge) => 'stableId' in edge.ref).map((edge) => edge.ref), [], []];
      expect(closing[0]?.detail).toMatchObject({
        summary: { elements: view.nodes.length + view.edges.length, elementsSha256: hashOfValue(refs), calls: 2, modelRef: 'claude-sonnet-5-5', instructionsSha256: sha256Of(rig.instructions.text), runId, outcome: 'ok', sentencesKept: 1, sentencesRemoved: 0 },
      });
      expectNoText(rig.events, ['SENTINEL-REPLY-TEXT', defined(rig.requests[0], 'a request').values, `${first(labelled)} is listed.`]);
    }
  });

  it('holds no text of the instructions in any event, and the check fails on an event that does', async () => {
    const rig = startRig({ replies: [replyOf({ text: 'AC-1 is listed.', cites: ['n1'] })], prompt: 'SENTINEL-INSTRUCTION-TEXT of the prompt' });
    await rig.summarize(readingOf(defined(set.cases[0], 'a case')));
    expect(rig.requests[0]?.instructions).toContain('SENTINEL-INSTRUCTION-TEXT');
    expectNoText(rig.events, ['SENTINEL-INSTRUCTION-TEXT']);
    expect(() => expectNoText([...rig.events, { action: 'ai.case-summary', detail: { instructions: rig.requests[0]?.instructions } }], ['SENTINEL-INSTRUCTION-TEXT'])).toThrow(SuiteCheckFailed);
  });

  it('ends a click whose provider fails at once, with its call and its run recorded', async () => {
    const rig = startRig({ replies: [failure('rate-limited')] });
    const outcome = await rig.summarize(readingOf(defined(set.cases[0], 'a case')));
    expect(outcome).toMatchObject({ status: 'failed', kind: 'rate-limited', calls: 1 });
    expect(rig.requests).toHaveLength(1);
    expect(rig.store.runs[0]?.callEnds[0]).toMatchObject({ number: 1, status: 'failed' });
  });
});
