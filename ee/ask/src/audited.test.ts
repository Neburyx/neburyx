import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS, AuditUnavailableError, createAuditedModelCall, type AuditedCallContext } from './audited.js';
import { buildPromptRegistry, PromptError, type PromptRegistry } from './prompts.js';
import type { ModelProvider, ModelRequest, PromptId, TokenUsage } from './provider.js';
import { CONFORMANCE_CASES, type ConformanceRig } from './testing/conformance.js';
import { createFixtureProvider, replyKey, type FixtureReply } from './testing/fixture.js';

const SIGNAL = new AbortController().signal;
const CONFIGURED_MODEL = 'configured-model';
const CONTEXT: AuditedCallContext = { actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator', traceId: 'tr-1' };
const REQUESTS: Readonly<Record<PromptId, ModelRequest>> = {
  'ask.plan': { promptId: 'ask.plan', parameters: { catalog: 'T1, T2', question: 'QUESTION-MARKER who is here?' } },
  'summary.view': { promptId: 'summary.view', parameters: { view: 'VIEW-MARKER a view' } },
  'assistant.route': { promptId: 'assistant.route', parameters: { message: 'MESSAGE-MARKER hello', view: 'VIEW-MARKER a view' } },
};
const MARKERS = ['QUESTION-MARKER', 'VIEW-MARKER', 'MESSAGE-MARKER', 'ANSWER-MARKER'];
const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const folder = mkdtempSync(join(tmpdir(), 'audited-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

async function registryWith(overrides: Record<string, string> = {}): Promise<PromptRegistry> {
  const built = await buildPromptRegistry(overrides);
  if (!built.ok) throw new Error(built.problems.join('; '));
  return built.registry;
}

function recordingSink(failure?: Error): { readonly sink: AuditSink; readonly events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, sink: { record: (event) => (failure === undefined ? (events.push(event), Promise.resolve()) : Promise.reject(failure)) } };
}

async function rig(reply: FixtureReply | ((request: ModelRequest) => FixtureReply) = { kind: 'ok', text: 'ANSWER-MARKER a plan', usage: { kind: 'known', inputTokens: 12, outputTokens: 34 } }, options: { overrides?: Record<string, string>; failure?: Error; sinkRegistry?: PromptRegistry; provider?: ModelProvider; model?: string } = {}) {
  const registry = await registryWith(options.overrides);
  const replies = Object.fromEntries((['ask.plan', 'summary.view', 'assistant.route'] as const).map((id) => [replyKey(id, 1), reply]));
  const fixture = createFixtureProvider({ registry: options.sinkRegistry ?? registry, replies });
  const recorded = recordingSink(options.failure);
  const audited = createAuditedModelCall({ provider: options.provider ?? fixture, configuration: { registry, model: options.model ?? CONFIGURED_MODEL }, sink: recorded.sink });
  return { audited, registry, fixture, ...recorded };
}

describe('an answered model call', () => {
  it('returns the answer unchanged and passes the request and the signal to the provider', async () => {
    const seen: { request?: ModelRequest; signal?: AbortSignal } = {};
    const registry = await registryWith();
    const fixture = createFixtureProvider({ registry, replies: { [replyKey('ask.plan', 1)]: { kind: 'ok', text: 'a plan' } } });
    const provider: ModelProvider = { complete: (request, signal) => ((seen.request = request), (seen.signal = signal), fixture.complete(request, signal)) };
    const { audited } = await rig(undefined, { provider });
    const answer = await audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL);
    expect(answer).toMatchObject({ status: 'ok', text: 'a plan' });
    expect(seen).toEqual({ request: REQUESTS['ask.plan'], signal: SIGNAL });
  });

  it.each(['ask.plan', 'summary.view', 'assistant.route'] as const)('records one success event for %s with the action, the context, the model, the prompt and the counts', async (id) => {
    const { audited, events, registry } = await rig();
    await audited.call(REQUESTS[id], { ...CONTEXT, investigationId: 'inv-1', sourceId: 'src-1' }, SIGNAL);
    const resolved = registry.resolve(id, REQUESTS[id].parameters);
    expect(events).toEqual([
      {
        actorId: CONTEXT.actorId,
        actorRole: 'investigator',
        action: AUDIT_ACTIONS[id],
        result: 'success',
        sourceId: 'src-1',
        investigationId: 'inv-1',
        traceId: 'tr-1',
        detail: { ai: { modelRef: 'fixture-model', promptId: id, promptVersion: '1', promptSha256: sha256Of(resolved.text), tokensIn: 12, tokensOut: 34 } },
      },
    ]);
  });

  it('records the model the answer names when another model than the configured one answered', async () => {
    const { audited, events } = await rig({ kind: 'ok', text: 'a plan', model: 'fallback-model' });
    await audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL);
    expect(events[0]?.detail).toMatchObject({ ai: { modelRef: 'fallback-model' } });
  });

  it.each<[string, TokenUsage]>([
    ['unknown usage', { kind: 'unknown' }],
    ['a decimal count', { kind: 'known', inputTokens: 1.5, outputTokens: 2.5 }],
    ['a negative count', { kind: 'known', inputTokens: -1, outputTokens: -2 }],
    ['counts that are not numbers', { kind: 'known', inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY }],
  ])('records the counts as unknown for %s, never as a number', async (_name, usage) => {
    const { audited, events } = await rig({ kind: 'ok', text: 'a plan', usage });
    await audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL);
    expect(events[0]?.detail).toMatchObject({ ai: { tokensIn: 'unknown', tokensOut: 'unknown' } });
  });

  it('records the hash of the override\'s filled text, which is not the built-in\'s', async () => {
    const file = join(folder, 'summary.txt');
    writeFileSync(file, 'An operator\'s own instruction about {{view}}.');
    const built = await rig(undefined, { overrides: { 'summary.view': file } });
    const plain = await rig();
    await built.audited.call(REQUESTS['summary.view'], CONTEXT, SIGNAL);
    await plain.audited.call(REQUESTS['summary.view'], CONTEXT, SIGNAL);
    const hashOf = (events: AuditEvent[]) => (events[0]?.detail && 'ai' in events[0].detail ? events[0].detail.ai?.promptSha256 : undefined);
    expect(hashOf(built.events)).toBe(sha256Of(`An operator's own instruction about ${REQUESTS['summary.view'].parameters['view']}.`));
    expect(hashOf(built.events)).not.toBe(hashOf(plain.events));
  });

  it('records the names of the pii properties sent when the context has any, and leaves the key out for an empty list', async () => {
    const { audited, events } = await rig();
    await audited.call(REQUESTS['ask.plan'], { ...CONTEXT, piiPropertiesSent: ['person.phone'] }, SIGNAL);
    await audited.call(REQUESTS['ask.plan'], { ...CONTEXT, piiPropertiesSent: [] }, SIGNAL);
    expect(events[0]?.detail).toMatchObject({ ai: { piiPropertiesSent: ['person.phone'] } });
    expect(events[1]?.detail && 'ai' in events[1].detail ? Object.keys(events[1].detail.ai ?? {}) : []).not.toContain('piiPropertiesSent');
  });

  it('writes no member that carries the filled text, the parameters, the question or the answer, and nothing to the process output', async () => {
    const { audited, events } = await rig();
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    try {
      for (const id of ['ask.plan', 'summary.view', 'assistant.route'] as const) await audited.call(REQUESTS[id], CONTEXT, SIGNAL);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(written).toEqual([]);
    for (const marker of MARKERS) expect(JSON.stringify(events)).not.toContain(marker);
  });

  it('refuses an answer whose prompt record differs from the one the wrapper resolved: a failed event, no answer and the audit error', async () => {
    const file = join(folder, 'other.txt');
    writeFileSync(file, 'Another registry\'s text for {{catalog}} and {{question}}.');
    const other = await registryWith({ 'ask.plan': file });
    const { audited, events } = await rig(undefined, { sinkRegistry: other });
    const outcome = await audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AuditUnavailableError);
    expect(outcome).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'failed', detail: { ai: { modelRef: CONFIGURED_MODEL, tokensIn: 'unknown', tokensOut: 'unknown' } } });
  });

  it.each([['a space', 'a model name'], ['201 characters', 'm'.repeat(201)]])('rejects with the audit error, and no text, when the answering model name has %s', async (_name, model) => {
    const { audited, events } = await rig({ kind: 'ok', text: 'ANSWER-MARKER', model });
    const outcome = await audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AuditUnavailableError);
    expect(events).toEqual([]);
  });

  it.each([['a space', 'a model name'], ['201 characters', 'm'.repeat(201)]])('rejects with the audit error, and no answer, when the configured model of a refusal has %s', async (_name, model) => {
    const { audited, events } = await rig({ kind: 'refused' }, { model });
    const outcome = await audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AuditUnavailableError);
    expect(events).toEqual([]);
  });

  it('is a provider for one context, and passes the conformance cases of a provider', async () => {
    const { audited, registry, fixture } = await rig();
    let next: FixtureReply = { kind: 'ok', text: 'a plan', usage: { kind: 'known', inputTokens: 1, outputTokens: 2 } };
    const replying = createFixtureProvider({ registry, replies: { [replyKey('ask.plan', 1)]: () => next } });
    const wrapped = createAuditedModelCall({ provider: replying, configuration: { registry, model: CONFIGURED_MODEL }, sink: recordingSink().sink });
    const conformanceRig: ConformanceRig = {
      provider: wrapped.asProvider(CONTEXT),
      registry,
      arrange(scenario) {
        next = scenario === 'refused' ? { kind: 'refused' } : scenario === 'ok-unknown-usage' ? { kind: 'ok', text: 'a plan' } : scenario === 'ok-known-usage' ? { kind: 'ok', text: 'a plan', usage: { kind: 'known', inputTokens: 12, outputTokens: 34 } } : scenario === 'timeout' ? { kind: 'failed', code: 'timeout' } : scenario === 'rate-limited' ? { kind: 'failed', code: 'rate-limited' } : scenario === 'rejected' ? { kind: 'failed', code: 'rejected' } : scenario === 'provider-error' ? { kind: 'failed', code: 'provider-error' } : scenario === 'unreachable' ? { kind: 'failed', code: 'unreachable' } : scenario === 'truncated' ? { kind: 'failed', code: 'truncated' } : { kind: 'failed', code: 'bad-reply' };
      },
      callsMade: () => replying.calls.length,
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
    expect(fixture.calls).toEqual([]);
  });
});

describe('a refused, failed or thrown call', () => {
  it('returns a refusal unchanged and records a refused event under the configured model with the answer\'s counts', async () => {
    const { audited, events } = await rig({ kind: 'refused', usage: { kind: 'known', inputTokens: 5, outputTokens: 0 } });
    const answer = await audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL);
    expect(answer.status).toBe('refused');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'refused', detail: { ai: { modelRef: CONFIGURED_MODEL, tokensIn: 5, tokensOut: 0 } } });
  });

  it.each(['timeout', 'unreachable', 'rejected', 'rate-limited', 'provider-error', 'bad-reply', 'truncated'] as const)('returns the failure %s unchanged and records a failed event with both counts unknown', async (code) => {
    const { audited, events } = await rig({ kind: 'failed', code });
    const answer = await audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL);
    expect(answer).toMatchObject({ status: 'failed', code });
    expect(events[0]).toMatchObject({ result: 'failed', detail: { ai: { modelRef: CONFIGURED_MODEL, tokensIn: 'unknown', tokensOut: 'unknown' } } });
  });

  it('records a failed event and throws the original error when the provider throws', async () => {
    const boom = new Error('the provider broke');
    const { audited, events } = await rig(undefined, { provider: { complete: () => Promise.reject(boom) } });
    await expect(audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL)).rejects.toBe(boom);
    expect(events[0]).toMatchObject({ result: 'failed', detail: { ai: { tokensIn: 'unknown' } } });
  });

  it('throws a PromptError before the provider is called and records no event', async () => {
    const { audited, events, fixture } = await rig();
    await expect(audited.call({ promptId: 'ask.plan', parameters: { catalog: 'T1' } }, CONTEXT, SIGNAL)).rejects.toBeInstanceOf(PromptError);
    expect(fixture.calls).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('a call whose audit cannot be written', () => {
  const SINK_FAILURE = new Error('the sink broke: SINK-TEXT-MARKER');

  it.each(['ask.plan', 'summary.view', 'assistant.route'] as const)('rejects with the audit error and returns no text for %s', async (id) => {
    const { audited } = await rig(undefined, { failure: SINK_FAILURE });
    const outcome = await audited.call(REQUESTS[id], CONTEXT, SIGNAL).catch((error: unknown) => error);
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
    const { audited } = await rig(reply, { failure: SINK_FAILURE });
    await expect(audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL)).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it('rejects with the audit error when the provider threw and the failed event cannot be written either', async () => {
    const { audited } = await rig(undefined, { failure: SINK_FAILURE, provider: { complete: () => Promise.reject(new Error('broke')) } });
    await expect(audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL)).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it('does not return an answer before a sink that has not settled does', async () => {
    const registry = await registryWith();
    const fixture = createFixtureProvider({ registry, replies: { [replyKey('ask.plan', 1)]: { kind: 'ok', text: 'ANSWER-MARKER' } } });
    let release: (() => void) | undefined;
    const sink: AuditSink = { record: () => new Promise<void>((resolve) => (release = resolve)) };
    const audited = createAuditedModelCall({ provider: fixture, configuration: { registry, model: CONFIGURED_MODEL }, sink });
    let answered = false;
    const pending = audited.call(REQUESTS['ask.plan'], CONTEXT, SIGNAL).then((answer) => ((answered = true), answer));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
    release?.();
    expect(await pending).toMatchObject({ status: 'ok' });
  });
});
