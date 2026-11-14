import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { FAILURE_CODES, type ModelRequest } from '../provider.js';
import { DEFAULT_FIXTURE_MODEL, MissingFixtureReplyError, createFixtureProvider, replyKey, type FixtureReplies } from './fixture.js';

const SIGNAL = new AbortController().signal;
const REQUEST: ModelRequest = { promptId: 'test.prompt', version: 7, instructions: 'Answer the question.', values: 'who is ‹person#1›?' };

describe('a fixture provider', () => {
  it('answers an ok reply with no usage as unknown usage, the fixture model and the prompt record of the request', async () => {
    const provider = createFixtureProvider({ replies: { [replyKey('test.prompt', 7)]: { kind: 'ok', text: 'draft plan' } } });
    const answer = await provider.complete(REQUEST, SIGNAL);
    expect(answer).toMatchObject({ status: 'ok', text: 'draft plan', usage: { kind: 'unknown' }, model: DEFAULT_FIXTURE_MODEL, prompt: { id: 'test.prompt', version: 7 } });
    expect(answer.prompt.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers a refused reply without usage as unknown usage', async () => {
    const provider = createFixtureProvider({ replies: { [replyKey('test.prompt', 7)]: { kind: 'refused' } } });
    expect(await provider.complete(REQUEST, SIGNAL)).toMatchObject({ status: 'refused', usage: { kind: 'unknown' } });
  });

  it('answers known usage, a recorded model name and every failure code as given, with the prompt record and no text', async () => {
    const known = createFixtureProvider({ replies: { [replyKey('test.prompt', 7)]: { kind: 'ok', text: 't', usage: { kind: 'known', inputTokens: 5, outputTokens: 7 }, model: 'claude-sonnet-5-5' } } });
    expect(await known.complete(REQUEST, SIGNAL)).toMatchObject({ usage: { kind: 'known', inputTokens: 5, outputTokens: 7 }, model: 'claude-sonnet-5-5' });
    for (const code of FAILURE_CODES) {
      const failing = createFixtureProvider({ replies: { [replyKey('test.prompt', 7)]: { kind: 'failed', code } } });
      const answer = await failing.complete(REQUEST, SIGNAL);
      expect(answer).toMatchObject({ status: 'failed', code, prompt: { id: 'test.prompt', version: 7 } });
      expect('text' in answer).toBe(false);
    }
  });

  it('answers a failed reply with the usage it was given, or unknown usage when none', async () => {
    const usage = { kind: 'known', inputTokens: 12, outputTokens: 256 } as const;
    const given = createFixtureProvider({ replies: { [replyKey('test.prompt', 7)]: { kind: 'failed', code: 'truncated', usage } } });
    expect(await given.complete(REQUEST, SIGNAL)).toMatchObject({ status: 'failed', code: 'truncated', usage });
    const none = createFixtureProvider({ replies: { [replyKey('test.prompt', 7)]: { kind: 'failed', code: 'truncated' } } });
    expect(await none.complete(REQUEST, SIGNAL)).toMatchObject({ status: 'failed', usage: { kind: 'unknown' } });
  });

  it('uses the model name it is given', async () => {
    const provider = createFixtureProvider({ model: 'stub-model', replies: { [replyKey('test.prompt', 7)]: { kind: 'ok', text: 't' } } });
    expect(await provider.complete(REQUEST, SIGNAL)).toMatchObject({ model: 'stub-model' });
  });

  it('throws a named error naming the id and version when no reply is scripted, and makes none up', async () => {
    const provider = createFixtureProvider({ replies: { [replyKey('other.prompt', 1)]: { kind: 'ok', text: 't' } } });
    await expect(provider.complete(REQUEST, SIGNAL)).rejects.toThrow(new MissingFixtureReplyError('the fixture has no reply for test.prompt@7'));
    await expect(provider.complete(REQUEST, SIGNAL)).rejects.toBeInstanceOf(MissingFixtureReplyError);
  });

  it('holds a different hash for different fixed instructions, and one hash whatever the values', async () => {
    const provider = createFixtureProvider({ replies: { [replyKey('test.prompt', 7)]: { kind: 'ok', text: 't' } } });
    const base = (await provider.complete(REQUEST, SIGNAL)).prompt.sha256;
    expect((await provider.complete({ ...REQUEST, values: 'someone else' }, SIGNAL)).prompt.sha256).toBe(base);
    expect((await provider.complete({ ...REQUEST, instructions: 'Answer differently.' }, SIGNAL)).prompt.sha256).not.toBe(base);
  });

  it('lists the requests it was given, in order, and calls a reply given as a function with the request', async () => {
    const seen: ModelRequest[] = [];
    const replies: FixtureReplies = { [replyKey('test.summary', 1)]: (request) => (seen.push(request), { kind: 'ok', text: `summary of ${request.values}` }) };
    const provider = createFixtureProvider({ replies });
    const first: ModelRequest = { promptId: 'test.summary', version: 1, values: '‹account#1›' };
    const second: ModelRequest = { promptId: 'test.summary', version: 1, values: '‹account#2›' };
    expect(await provider.complete(first, SIGNAL)).toMatchObject({ text: 'summary of ‹account#1›' });
    await provider.complete(second, SIGNAL);
    expect(provider.calls).toEqual([first, second]);
    expect(seen).toEqual([first, second]);
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
      const provider = createFixtureProvider({ replies: { [replyKey('test.prompt', 7)]: { kind: 'ok', text: 'offline' } } });
      expect(await provider.complete(REQUEST, SIGNAL)).toMatchObject({ status: 'ok', text: 'offline' });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = savedFetch;
      for (const spy of spies) spy.mockRestore();
      Object.assign(process.env, savedEnv);
    }
  });
});
