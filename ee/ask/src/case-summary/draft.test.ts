import type { AuditEvent } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AuditUnavailableError, createAuditedModelCall } from '@neburyx/ee-ai-runtime';
import { promptRecordOf, type FailureCode, type ModelAnswer, type ModelProvider, type ModelRequest } from '@neburyx/ee-ai-runtime';
import { draftSummary } from './draft.js';

const PROMPT = { id: 'case-summary', version: 1, sha256: 'a'.repeat(64) };
const ok = (text: string): ModelAnswer => ({ status: 'ok', text, usage: { kind: 'known', inputTokens: 10, outputTokens: 5 }, model: 'm', prompt: PROMPT });
const failed = (code: FailureCode): ModelAnswer => ({ status: 'failed', code, prompt: PROMPT });
const GOOD = JSON.stringify({ sentences: [{ text: 'Two accounts share a device.', cites: ['n1', 'n2'] }] });
const CONTEXT = { action: 'ai.case-summary', actorId: 'a', actorRole: 'investigator' as const, traceId: 't' };

function scripted(answers: readonly (ModelAnswer | ((request: ModelRequest, signal: AbortSignal) => Promise<ModelAnswer>))[]) {
  const requests: ModelRequest[] = [];
  const events: AuditEvent[] = [];
  let index = 0;
  const provider: ModelProvider = {
    complete: async (request, signal) => {
      requests.push(request);
      const next = answers[Math.min(index++, answers.length - 1)];
      const answer = typeof next === 'function' ? await next(request, signal) : (next as ModelAnswer);
      return { ...answer, prompt: promptRecordOf(request) };
    },
  };
  const call = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async (event) => void events.push(event) } });
  return { call, requests, events };
}

const run = (call: ReturnType<typeof scripted>['call'], extra: Partial<Parameters<typeof draftSummary>[0]> = {}) =>
  draftSummary({ call, context: CONTEXT, instructions: 'INSTRUCTIONS', values: 'VALUES', judge: (sentences) => ({ kept: sentences, removed: 0, verdictFound: false }), maxCalls: 5, totalTimeoutMs: 180_000, signal: new AbortController().signal, ...extra });

describe('the drafting loop', () => {
  it('returns the sentences of a reply that fits, in one call', async () => {
    const { call, requests } = scripted([ok(GOOD)]);
    expect(await run(call)).toEqual({ status: 'drafted', sentences: [{ text: 'Two accounts share a device.', cites: ['n1', 'n2'] }], removed: 0, calls: 1 });
    expect(requests).toEqual([{ promptId: 'case-summary', version: 1, instructions: 'INSTRUCTIONS', values: 'VALUES' }]);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['an object with another key', '{"sentences":[],"extra":1}'],
    ['sentences that are not an array', '{"sentences":"x"}'],
    ['a sentence with no cites', '{"sentences":[{"text":"a"}]}'],
    ['a sentence with an empty text', '{"sentences":[{"text":"","cites":["n1"]}]}'],
    ['a cite that is not text', '{"sentences":[{"text":"a","cites":[1]}]}'],
    ['more than twelve sentences', JSON.stringify({ sentences: Array.from({ length: 13 }, () => ({ text: 'a', cites: ['n1'] })) })],
  ])('makes one more call, with a fixed note, for %s', async (_name, reply) => {
    const { call, requests } = scripted([ok(reply), ok(GOOD)]);
    const drafted = await run(call);
    expect(drafted).toMatchObject({ status: 'drafted', calls: 2 });
    expect(requests[1]?.values).toBe('VALUES\n\nYour last reply did not fit the reply format. Reply again, in the reply format only.');
    expect(requests[1]?.values).not.toContain(reply);
  });

  it('ends as a format failure when the last allowed call still does not fit, never above the call limit', async () => {
    const { call, requests } = scripted([ok('nope')]);
    expect(await run(call, { maxCalls: 3 })).toEqual({ status: 'failed', kind: 'format', calls: 3 });
    expect(requests).toHaveLength(3);
  });

  it.each<[FailureCode, string]>([
    ['timeout', 'timeout'],
    ['unreachable', 'unreachable'],
    ['rate-limited', 'rate-limited'],
    ['rejected', 'rejected'],
    ['provider-error', 'provider-error'],
    ['bad-reply', 'bad-reply'],
    ['truncated', 'truncated'],
  ])('ends at once on the provider failure %s, with no further call', async (code, kind) => {
    const { call, requests } = scripted([failed(code)]);
    expect(await run(call)).toEqual({ status: 'failed', kind, calls: 1 });
    expect(requests).toHaveLength(1);
  });

  it('ends at once on a refusal', async () => {
    const { call, requests } = scripted([{ status: 'refused', usage: { kind: 'unknown' }, prompt: PROMPT }]);
    expect(await run(call)).toEqual({ status: 'failed', kind: 'refused', calls: 1 });
    expect(requests).toHaveLength(1);
  });

  it('aborts the call in flight and ends as timeLimit when the total time is spent', async () => {
    let seenAbort = false;
    const { call } = scripted([
      (_request, signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => {
            seenAbort = true;
            resolve(failed('timeout'));
          }),
        ),
    ]);
    expect(await run(call, { totalTimeoutMs: 20 })).toEqual({ status: 'timeLimit', calls: 1 });
    expect(seenAbort).toBe(true);
  });

  it('makes no further call once the total time is spent between calls', async () => {
    let clock = 0;
    const { call, requests } = scripted([ok('nope')]);
    const drafted = await run(call, { totalTimeoutMs: 100, now: () => (clock += 60) });
    expect(drafted).toMatchObject({ status: 'timeLimit' });
    expect(requests.length).toBeLessThan(5);
  });

  it('aborts the call in flight and makes no further call when the client gives up', async () => {
    const controller = new AbortController();
    const { call, requests } = scripted([
      (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(failed('timeout')));
          controller.abort();
        }),
    ]);
    await expect(run(call, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(requests).toHaveLength(1);
  });

  it('fails closed when the audit event of a call cannot be written', async () => {
    const provider: ModelProvider = { complete: async (request) => ({ ...ok(GOOD), prompt: promptRecordOf(request) }) };
    const call = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async () => Promise.reject(new Error('down')) } });
    await expect(run(call)).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it('records one event per call and none holds the instructions, the text sent or a reply', async () => {
    const { call, events } = scripted([ok('SECRET-REPLY-TEXT'), ok(GOOD)]);
    await run(call, { instructions: 'SECRET-INSTRUCTIONS', values: 'SECRET-VALUES' });
    expect(events).toHaveLength(2);
    for (const secret of ['SECRET-INSTRUCTIONS', 'SECRET-VALUES', 'SECRET-REPLY-TEXT']) expect(JSON.stringify(events)).not.toContain(secret);
  });
});
