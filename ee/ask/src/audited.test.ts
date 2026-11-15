import { createHash } from 'node:crypto';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { AuditUnavailableError, createAuditedModelCall, type AuditedCallContext } from './audited.js';
import { promptRecordOf, type ModelProvider, type ModelRequest, type TokenUsage } from './provider.js';
import { CONFORMANCE_CASES, type ConformanceRig } from './testing/conformance.js';
import { createFixtureProvider, replyKey, type FixtureReply } from './testing/fixture.js';

const SIGNAL = new AbortController().signal;
const CONFIGURED_MODEL = 'configured-model';
const CONTEXT: AuditedCallContext = { actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator', traceId: 'tr-1', action: 'test.call' };
const REQUEST: ModelRequest = { promptId: 'test.prompt', version: 4, instructions: 'INSTRUCTIONS-MARKER Answer the question.', values: 'QUESTION-MARKER who is here?' };
const MARKERS = ['INSTRUCTIONS-MARKER', 'QUESTION-MARKER', 'ANSWER-MARKER'];
const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function recordingSink(failure?: Error): { readonly sink: AuditSink; readonly events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, sink: { record: (event) => (failure === undefined ? (events.push(event), Promise.resolve()) : Promise.reject(failure)) } };
}

function rig(reply: FixtureReply | ((request: ModelRequest) => FixtureReply) = { kind: 'ok', text: 'ANSWER-MARKER a plan', usage: { kind: 'known', inputTokens: 12, outputTokens: 34 } }, options: { failure?: Error; provider?: ModelProvider; model?: string } = {}) {
  const fixture = createFixtureProvider({ replies: { [replyKey(REQUEST.promptId, REQUEST.version)]: reply } });
  const recorded = recordingSink(options.failure);
  const audited = createAuditedModelCall({ provider: options.provider ?? fixture, configuration: { model: options.model ?? CONFIGURED_MODEL }, sink: recorded.sink });
  return { audited, fixture, ...recorded };
}

describe('an answered model call', () => {
  it('returns the answer unchanged and passes the request and the signal to the provider', async () => {
    const seen: { request?: ModelRequest; signal?: AbortSignal } = {};
    const fixture = createFixtureProvider({ replies: { [replyKey(REQUEST.promptId, REQUEST.version)]: { kind: 'ok', text: 'a plan' } } });
    const provider: ModelProvider = { complete: (request, signal) => ((seen.request = request), (seen.signal = signal), fixture.complete(request, signal)) };
    const { audited } = rig(undefined, { provider });
    const answer = await audited.call(REQUEST, CONTEXT, SIGNAL);
    expect(answer).toMatchObject({ status: 'ok', text: 'a plan' });
    expect(seen).toEqual({ request: REQUEST, signal: SIGNAL });
  });

  it('records one success event with the action of the context, the model, the prompt and the counts', async () => {
    const { audited, events } = rig();
    await audited.call(REQUEST, { ...CONTEXT, investigationId: 'inv-1', sourceId: 'src-1' }, SIGNAL);
    expect(events).toEqual([
      {
        actorId: CONTEXT.actorId,
        actorRole: 'investigator',
        action: 'test.call',
        result: 'success',
        sourceId: 'src-1',
        investigationId: 'inv-1',
        traceId: 'tr-1',
        detail: { ai: { modelRef: 'fixture-model', promptId: 'test.prompt', promptVersion: '4', promptSha256: promptRecordOf(REQUEST).sha256, tokensIn: 12, tokensOut: 34, cacheReadTokens: 'unknown', cacheWriteTokens: 'unknown' } },
      },
    ]);
  });

  it('adds the run id of the context to the ai detail, and none where the context has none', async () => {
    const { audited, events } = rig();
    await audited.call(REQUEST, { ...CONTEXT, runId: '0192f000-0000-7000-8000-000000000042' }, SIGNAL);
    await audited.call(REQUEST, CONTEXT, SIGNAL);
    expect(events[0]?.detail).toMatchObject({ ai: { runId: '0192f000-0000-7000-8000-000000000042' } });
    expect(events[1]?.detail && 'ai' in events[1].detail ? events[1].detail.ai : {}).not.toHaveProperty('runId');
  });

  it('takes the action from the context of each call', async () => {
    const { audited, events } = rig();
    await audited.call(REQUEST, { ...CONTEXT, action: 'ai.first' }, SIGNAL);
    await audited.call(REQUEST, { ...CONTEXT, action: 'ai.second' }, SIGNAL);
    expect(events.map((event) => event.action)).toEqual(['ai.first', 'ai.second']);
  });

  it('records the pattern catalog of the context, and leaves it out when the context has none', async () => {
    const { audited, events } = rig();
    await audited.call(REQUEST, { ...CONTEXT, patternCatalog: { count: 2, sha256: 'b'.repeat(64) } }, SIGNAL);
    await audited.call(REQUEST, CONTEXT, SIGNAL);
    expect(events[0]?.detail).toMatchObject({ ai: { patternCatalog: { count: 2, sha256: 'b'.repeat(64) } } });
    expect(events[1]?.detail && 'ai' in events[1].detail ? Object.keys(events[1].detail.ai ?? {}) : []).not.toContain('patternCatalog');
  });

  it('records the model the answer names when another model than the configured one answered', async () => {
    const { audited, events } = rig({ kind: 'ok', text: 'a plan', model: 'fallback-model' });
    await audited.call(REQUEST, CONTEXT, SIGNAL);
    expect(events[0]?.detail).toMatchObject({ ai: { modelRef: 'fallback-model' } });
  });

  it.each<[string, TokenUsage]>([
    ['unknown usage', { kind: 'unknown' }],
    ['a decimal count', { kind: 'known', inputTokens: 1.5, outputTokens: 2.5 }],
    ['a negative count', { kind: 'known', inputTokens: -1, outputTokens: -2 }],
    ['counts that are not numbers', { kind: 'known', inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY }],
  ])('records the counts as unknown for %s, never as a number', async (_name, usage) => {
    const { audited, events } = rig({ kind: 'ok', text: 'a plan', usage });
    await audited.call(REQUEST, CONTEXT, SIGNAL);
    expect(events[0]?.detail).toMatchObject({ ai: { tokensIn: 'unknown', tokensOut: 'unknown' } });
  });

  it('records the hash of the fixed instructions only: the same whatever the values, another for other instructions, and never the hash of the values', async () => {
    const { audited, events } = rig({ kind: 'ok', text: 'a plan' });
    await audited.call(REQUEST, CONTEXT, SIGNAL);
    await audited.call({ ...REQUEST, values: 'another question entirely' }, CONTEXT, SIGNAL);
    await audited.call({ ...REQUEST, instructions: 'Other instructions.' }, CONTEXT, SIGNAL);
    const hashes = events.map((event) => (event.detail && 'ai' in event.detail ? event.detail.ai?.promptSha256 : undefined));
    expect(hashes[0]).toBe(sha256Of(REQUEST.instructions ?? ''));
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).toBe(sha256Of('Other instructions.'));
    expect(JSON.stringify(events)).not.toContain(sha256Of(REQUEST.values));
    expect(JSON.stringify(events)).not.toContain(sha256Of('another question entirely'));
  });

  it('writes no member that carries the instructions, the values or the answer, and nothing to the process output', async () => {
    const { audited, events } = rig();
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    try {
      await audited.call(REQUEST, CONTEXT, SIGNAL);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(written).toEqual([]);
    for (const marker of MARKERS) expect(JSON.stringify(events)).not.toContain(marker);
  });

  it('refuses an answer whose prompt record differs from the one sent: a failed event, no answer and the audit error', async () => {
    const fixture = createFixtureProvider({ replies: { [replyKey(REQUEST.promptId, REQUEST.version)]: { kind: 'ok', text: 'a plan' } } });
    const provider: ModelProvider = { complete: async (request, signal) => ({ ...(await fixture.complete(request, signal)), prompt: { ...promptRecordOf(request), sha256: 'c'.repeat(64) } }) };
    const { audited, events } = rig(undefined, { provider });
    const outcome = await audited.call(REQUEST, CONTEXT, SIGNAL).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AuditUnavailableError);
    expect(outcome).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'failed', detail: { ai: { modelRef: CONFIGURED_MODEL, tokensIn: 'unknown', tokensOut: 'unknown' } } });
  });

  it.each([['a space', 'a model name'], ['201 characters', 'm'.repeat(201)]])('rejects with the audit error, and no text, when the answering model name has %s', async (_name, model) => {
    const { audited, events } = rig({ kind: 'ok', text: 'ANSWER-MARKER', model });
    const outcome = await audited.call(REQUEST, CONTEXT, SIGNAL).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AuditUnavailableError);
    expect(events).toEqual([]);
  });

  it.each([['a space', 'a model name'], ['201 characters', 'm'.repeat(201)]])('rejects with the audit error, and no answer, when the configured model of a refusal has %s', async (_name, model) => {
    const { audited, events } = rig({ kind: 'refused' }, { model });
    const outcome = await audited.call(REQUEST, CONTEXT, SIGNAL).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AuditUnavailableError);
    expect(events).toEqual([]);
  });

  it('is a provider for one context, and passes the conformance cases of a provider', async () => {
    let next: FixtureReply = { kind: 'ok', text: 'a plan', usage: { kind: 'known', inputTokens: 1, outputTokens: 2 } };
    const replying = createFixtureProvider({ replies: { [replyKey('conformance', 1)]: () => next } });
    const wrapped = createAuditedModelCall({ provider: replying, configuration: { model: CONFIGURED_MODEL }, sink: recordingSink().sink });
    const conformanceRig: ConformanceRig = {
      provider: wrapped.asProvider(CONTEXT),
      arrange(scenario) {
        next = scenario === 'refused' ? { kind: 'refused' } : scenario === 'ok-unknown-usage' ? { kind: 'ok', text: 'a plan' } : scenario === 'ok-known-usage' ? { kind: 'ok', text: 'a plan', usage: { kind: 'known', inputTokens: 12, outputTokens: 34 } } : scenario === 'timeout' ? { kind: 'failed', code: 'timeout' } : scenario === 'rate-limited' ? { kind: 'failed', code: 'rate-limited' } : scenario === 'rejected' ? { kind: 'failed', code: 'rejected' } : scenario === 'provider-error' ? { kind: 'failed', code: 'provider-error' } : scenario === 'unreachable' ? { kind: 'failed', code: 'unreachable' } : scenario === 'truncated' ? { kind: 'failed', code: 'truncated' } : { kind: 'failed', code: 'bad-reply' };
      },
    };
    const failed: string[] = [];
    for (const conformanceCase of CONFORMANCE_CASES) {
      try {
        await conformanceCase.run(conformanceRig);
      } catch {
        failed.push(conformanceCase.name);
      }
    }
    expect(failed).toEqual([]);
  });
});

describe('a refused, failed or thrown call', () => {
  it('returns a refusal unchanged and records a refused event under the configured model with the answer\'s counts', async () => {
    const { audited, events } = rig({ kind: 'refused', usage: { kind: 'known', inputTokens: 5, outputTokens: 0 } });
    const answer = await audited.call(REQUEST, CONTEXT, SIGNAL);
    expect(answer.status).toBe('refused');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'refused', detail: { ai: { modelRef: CONFIGURED_MODEL, tokensIn: 5, tokensOut: 0 } } });
  });

  it.each(['timeout', 'unreachable', 'rejected', 'rate-limited', 'provider-error', 'bad-reply', 'truncated'] as const)('returns the failure %s unchanged and records a failed event with both counts unknown', async (code) => {
    const { audited, events } = rig({ kind: 'failed', code });
    const answer = await audited.call(REQUEST, CONTEXT, SIGNAL);
    expect(answer).toMatchObject({ status: 'failed', code });
    expect(events[0]).toMatchObject({ result: 'failed', detail: { ai: { modelRef: CONFIGURED_MODEL, tokensIn: 'unknown', tokensOut: 'unknown' } } });
  });

  it.each(['timeout', 'unreachable', 'rejected', 'rate-limited', 'provider-error', 'bad-reply', 'truncated'] as const)('records the usage of the failure %s when the answer carries it', async (code) => {
    const { audited, events } = rig({ kind: 'failed', code, usage: { kind: 'known', inputTokens: 12, outputTokens: 256 } });
    const answer = await audited.call(REQUEST, CONTEXT, SIGNAL);
    expect(answer).toMatchObject({ status: 'failed', code, usage: { kind: 'known', inputTokens: 12, outputTokens: 256 } });
    expect(events[0]).toMatchObject({ result: 'failed', detail: { ai: { modelRef: CONFIGURED_MODEL, tokensIn: 12, tokensOut: 256 } } });
  });

  describe('a failed answer whose usage is not known', () => {
    async function eventFor(usage: unknown): Promise<AuditEvent> {
      const inner = createFixtureProvider({ replies: { [replyKey(REQUEST.promptId, REQUEST.version)]: { kind: 'failed', code: 'truncated' } } });
      const provider: ModelProvider = {
        complete: async (request, signal) => {
          const { usage: _usage, ...rest } = await inner.complete(request, signal);
          return (usage === undefined ? rest : { ...rest, usage }) as never;
        },
      };
      const { audited, events } = rig(undefined, { provider });
      await audited.call(REQUEST, CONTEXT, SIGNAL);
      return events[0] as AuditEvent;
    }

    it.each([
      ['unknown usage', { kind: 'unknown' }],
      ['no usage at all', undefined],
    ])('records unknown for both counts for %s', async (_name, usage) => {
      expect(await eventFor(usage)).toMatchObject({ result: 'failed', detail: { ai: { tokensIn: 'unknown', tokensOut: 'unknown' } } });
    });

    it('records unknown for a count that is not a whole non-negative number, and keeps the other', async () => {
      expect(await eventFor({ kind: 'known', inputTokens: -1, outputTokens: 2 })).toMatchObject({ detail: { ai: { tokensIn: 'unknown', tokensOut: 2 } } });
      expect(await eventFor({ kind: 'known', inputTokens: 3, outputTokens: 1.5 })).toMatchObject({ detail: { ai: { tokensIn: 3, tokensOut: 'unknown' } } });
    });
  });

  describe('the cache counts of the usage', () => {
    const usage = (extra: Record<string, number>): TokenUsage => ({ kind: 'known', inputTokens: 12, outputTokens: 5, ...extra });

    it.each(['ok', 'refused', 'failed'] as const)('are recorded in the event of a %s answer next to the other counts', async (kind) => {
      const reply: FixtureReply = kind === 'ok' ? { kind, text: 'a plan', usage: usage({ cacheReadTokens: 300, cacheWriteTokens: 40 }) } : kind === 'refused' ? { kind, usage: usage({ cacheReadTokens: 300, cacheWriteTokens: 40 }) } : { kind, code: 'truncated', usage: usage({ cacheReadTokens: 300, cacheWriteTokens: 40 }) };
      const { audited, events } = rig(reply);
      await audited.call(REQUEST, CONTEXT, SIGNAL);
      expect(events[0]?.detail).toMatchObject({ ai: { tokensIn: 12, tokensOut: 5, cacheReadTokens: 300, cacheWriteTokens: 40 } });
    });

    it('are unknown when the usage does not state them, zero when it states zero, and each is kept when the other is missing', async () => {
      const eventFor = async (given: TokenUsage): Promise<AuditEvent | undefined> => {
        const { audited, events } = rig({ kind: 'ok', text: 't', usage: given });
        await audited.call(REQUEST, CONTEXT, SIGNAL);
        return events[0];
      };
      expect((await eventFor(usage({})))?.detail).toMatchObject({ ai: { cacheReadTokens: 'unknown', cacheWriteTokens: 'unknown' } });
      expect((await eventFor(usage({ cacheReadTokens: 0, cacheWriteTokens: 0 })))?.detail).toMatchObject({ ai: { cacheReadTokens: 0, cacheWriteTokens: 0 } });
      expect((await eventFor(usage({ cacheReadTokens: 7 })))?.detail).toMatchObject({ ai: { cacheReadTokens: 7, cacheWriteTokens: 'unknown' } });
      expect((await eventFor({ kind: 'unknown' }))?.detail).toMatchObject({ ai: { tokensIn: 'unknown', cacheReadTokens: 'unknown', cacheWriteTokens: 'unknown' } });
    });

    it('are unknown for a count that is not a whole non-negative number, and the others stay', async () => {
      const { audited, events } = rig({ kind: 'ok', text: 't', usage: usage({ cacheReadTokens: -1, cacheWriteTokens: 1.5 }) });
      await audited.call(REQUEST, CONTEXT, SIGNAL);
      expect(events[0]?.detail).toMatchObject({ ai: { tokensIn: 12, cacheReadTokens: 'unknown', cacheWriteTokens: 'unknown' } });
    });
  });

  it('records a failed event and throws the original error when the provider throws', async () => {
    const boom = new Error('the provider broke');
    const { audited, events } = rig(undefined, { provider: { complete: () => Promise.reject(boom) } });
    await expect(audited.call(REQUEST, CONTEXT, SIGNAL)).rejects.toBe(boom);
    expect(events[0]).toMatchObject({ result: 'failed', detail: { ai: { tokensIn: 'unknown' } } });
  });

});

describe('a prompt id the audit cannot hold', () => {
  it.each([
    ['an id with a space', { ...REQUEST, promptId: 'a prompt' }],
    ['an empty id', { ...REQUEST, promptId: '' }],
    ['an id that is too long', { ...REQUEST, promptId: 'p'.repeat(201) }],
    ['a version that is not a whole number', { ...REQUEST, version: 1.5 }],
    ['a negative version', { ...REQUEST, version: -1 }],
  ])('is refused before anything is sent: %s', async (_name, request) => {
    const { audited, fixture, events } = rig();
    await expect(audited.call(request, CONTEXT, SIGNAL)).rejects.toBeInstanceOf(RangeError);
    expect(fixture.calls).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('a call whose audit cannot be written', () => {
  const SINK_FAILURE = new Error('the sink broke: SINK-TEXT-MARKER');

  it('rejects with the audit error and returns no text', async () => {
    const { audited } = rig(undefined, { failure: SINK_FAILURE });
    const outcome = await audited.call(REQUEST, CONTEXT, SIGNAL).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AuditUnavailableError);
    expect(outcome).toMatchObject({ code: 'AUDIT_UNAVAILABLE', message: 'The action could not be recorded, so nothing was returned.' });
    const carried = JSON.stringify(outcome) + String(outcome) + (outcome instanceof Error ? (outcome.stack ?? '') + String(outcome.cause) : '');
    for (const marker of [...MARKERS, 'SINK-TEXT-MARKER']) expect(carried).not.toContain(marker);
    expect(outcome instanceof Error ? outcome.cause : 'not an error').toBeUndefined();
  });

  it.each<[string, FixtureReply]>([
    ['a refusal', { kind: 'refused' }],
    ['a failure', { kind: 'failed', code: 'timeout' }],
  ])('rejects with the same error for %s and returns no answer', async (_name, reply) => {
    const { audited } = rig(reply, { failure: SINK_FAILURE });
    await expect(audited.call(REQUEST, CONTEXT, SIGNAL)).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it('rejects with the audit error when the provider threw and the failed event cannot be written either', async () => {
    const { audited } = rig(undefined, { failure: SINK_FAILURE, provider: { complete: () => Promise.reject(new Error('broke')) } });
    await expect(audited.call(REQUEST, CONTEXT, SIGNAL)).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it('does not return an answer before a sink that has not settled does', async () => {
    const fixture = createFixtureProvider({ replies: { [replyKey(REQUEST.promptId, REQUEST.version)]: { kind: 'ok', text: 'ANSWER-MARKER' } } });
    let release: (() => void) | undefined;
    const sink: AuditSink = { record: () => new Promise<void>((resolve) => (release = resolve)) };
    const audited = createAuditedModelCall({ provider: fixture, configuration: { model: CONFIGURED_MODEL }, sink });
    let answered = false;
    const pending = audited.call(REQUEST, CONTEXT, SIGNAL).then((answer) => ((answered = true), answer));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
    release?.();
    expect(await pending).toMatchObject({ status: 'ok' });
  });
});
