import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_PROMPTS, PromptError, buildPromptRegistry, type PromptRegistry } from '../prompts.js';
import { FAILURE_CODES, type ModelRequest, type PromptId } from '../provider.js';
import { DEFAULT_FIXTURE_MODEL, MissingFixtureReplyError, createFixtureProvider, replyKey, type FixtureReplies } from './fixture.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIGNAL = new AbortController().signal;
const REQUEST: ModelRequest = { promptId: 'ask.plan', parameters: { catalog: 'T1, T2', question: 'who is ‹person#1›?' } };

async function registry(overrides: Record<string, string> = {}): Promise<PromptRegistry> {
  const built = await buildPromptRegistry(overrides);
  if (!built.ok) throw new Error(built.problems.join('; '));
  return built.registry;
}

const folder = mkdtempSync(join(tmpdir(), 'fixture-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('a fixture provider', () => {
  it('answers an ok reply with no usage as unknown usage, the fixture model and the prompt record of the registry', async () => {
    const provider = createFixtureProvider({ registry: await registry(), replies: { [replyKey('ask.plan', 1)]: { kind: 'ok', text: 'draft plan' } } });
    const answer = await provider.complete(REQUEST, SIGNAL);
    expect(answer).toMatchObject({ status: 'ok', text: 'draft plan', usage: { kind: 'unknown' }, model: DEFAULT_FIXTURE_MODEL, prompt: { id: 'ask.plan', version: 1, source: 'builtin' } });
    expect(answer.prompt.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers a refused reply without usage as unknown usage', async () => {
    const provider = createFixtureProvider({ registry: await registry(), replies: { [replyKey('ask.plan', 1)]: { kind: 'refused' } } });
    expect(await provider.complete(REQUEST, SIGNAL)).toMatchObject({ status: 'refused', usage: { kind: 'unknown' } });
  });

  it('answers known usage, a recorded model name and every failure code as given, with the prompt record and no text', async () => {
    const known = createFixtureProvider({ registry: await registry(), replies: { [replyKey('ask.plan', 1)]: { kind: 'ok', text: 't', usage: { kind: 'known', inputTokens: 5, outputTokens: 7 }, model: 'claude-sonnet-5-5' } } });
    expect(await known.complete(REQUEST, SIGNAL)).toMatchObject({ usage: { kind: 'known', inputTokens: 5, outputTokens: 7 }, model: 'claude-sonnet-5-5' });
    for (const code of FAILURE_CODES) {
      const failing = createFixtureProvider({ registry: await registry(), replies: { [replyKey('ask.plan', 1)]: { kind: 'failed', code } } });
      const answer = await failing.complete(REQUEST, SIGNAL);
      expect(answer).toMatchObject({ status: 'failed', code, prompt: { id: 'ask.plan', version: 1 } });
      expect('text' in answer).toBe(false);
    }
  });

  it('uses the model name it is given', async () => {
    const provider = createFixtureProvider({ registry: await registry(), model: 'stub-model', replies: { [replyKey('ask.plan', 1)]: { kind: 'ok', text: 't' } } });
    expect(await provider.complete(REQUEST, SIGNAL)).toMatchObject({ model: 'stub-model' });
  });

  it('throws a named error naming the id and version when no reply is scripted, and makes none up', async () => {
    const provider = createFixtureProvider({ registry: await registry(), replies: { [replyKey('summary.view', 1)]: { kind: 'ok', text: 't' } } });
    await expect(provider.complete(REQUEST, SIGNAL)).rejects.toThrow(new MissingFixtureReplyError('the fixture has no reply for ask.plan@1'));
    await expect(provider.complete(REQUEST, SIGNAL)).rejects.toBeInstanceOf(MissingFixtureReplyError);
  });

  it('throws the registry error before it looks for a reply when a parameter is missing or not declared', async () => {
    const provider = createFixtureProvider({ registry: await registry(), replies: {} });
    await expect(provider.complete({ promptId: 'ask.plan', parameters: { question: 'q' } }, SIGNAL)).rejects.toBeInstanceOf(PromptError);
    await expect(provider.complete({ promptId: 'ask.plan', parameters: { catalog: 'c', question: 'q', extra: 'x' } }, SIGNAL)).rejects.toBeInstanceOf(PromptError);
    expect(provider.calls).toEqual([]);
  });

  it('says override and holds the override hash when the registry has an override', async () => {
    const path = join(folder, 'ask-plan.txt');
    writeFileSync(path, 'Plan {{question}} {{catalog}}');
    const provider = createFixtureProvider({ registry: await registry({ 'ask.plan': path }), replies: { [replyKey('ask.plan', 1)]: { kind: 'ok', text: 't' } } });
    const builtIn = createFixtureProvider({ registry: await registry(), replies: { [replyKey('ask.plan', 1)]: { kind: 'ok', text: 't' } } });
    const answer = await provider.complete(REQUEST, SIGNAL);
    expect(answer.prompt.source).toBe('override');
    expect(answer.prompt.sha256).not.toBe((await builtIn.complete(REQUEST, SIGNAL)).prompt.sha256);
  });

  it('lists the requests that resolved, in order, and calls a reply given as a function with the request', async () => {
    const seen: ModelRequest[] = [];
    const replies: FixtureReplies = { [replyKey('summary.view', 1)]: (request) => (seen.push(request), { kind: 'ok', text: `summary of ${String(request.parameters['view'])}` }) };
    const provider = createFixtureProvider({ registry: await registry(), replies });
    const first: ModelRequest = { promptId: 'summary.view', parameters: { view: '‹account#1›' } };
    const second: ModelRequest = { promptId: 'summary.view', parameters: { view: '‹account#2›' } };
    expect(await provider.complete(first, SIGNAL)).toMatchObject({ text: 'summary of ‹account#1›' });
    await provider.complete(second, SIGNAL);
    await expect(provider.complete({ promptId: 'summary.view', parameters: {} }, SIGNAL)).rejects.toBeInstanceOf(PromptError);
    expect(provider.calls).toEqual([first, second]);
    expect(seen).toEqual([first, second]);
  });

  it('has a reply key for every built-in prompt', () => {
    const ids = Object.keys(BUILT_IN_PROMPTS) as PromptId[];
    expect(ids.map((id) => replyKey(id, BUILT_IN_PROMPTS[id].version))).toEqual(['ask.plan@1', 'summary.view@1', 'assistant.route@1']);
  });
});

describe('a fixture provider with no network and no key', () => {
  it('answers with fetch and the network modules failing, and with an environment that holds no key', async () => {
    const refuse = (): never => {
      throw new Error('the network was used');
    };
    const spies = [vi.spyOn(http, 'request').mockImplementation(refuse), vi.spyOn(https, 'request').mockImplementation(refuse), vi.spyOn(net, 'connect').mockImplementation(refuse), vi.spyOn(net, 'createConnection').mockImplementation(refuse)];
    const savedFetch = globalThis.fetch;
    const savedEnv = { ...process.env };
    globalThis.fetch = () => {
      throw new Error('the network was used');
    };
    for (const name of Object.keys(process.env)) delete process.env[name];
    try {
      const provider = createFixtureProvider({ registry: await registry(), replies: { [replyKey('ask.plan', 1)]: { kind: 'ok', text: 'offline' } } });
      expect(await provider.complete(REQUEST, SIGNAL)).toMatchObject({ status: 'ok', text: 'offline' });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = savedFetch;
      for (const spy of spies) spy.mockRestore();
      Object.assign(process.env, savedEnv);
    }
  });
});
