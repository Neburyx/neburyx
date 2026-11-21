import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classify, loadSource } from './evaluate.js';
import { LiveProviderError, assistantRunSettings, liveAssistantProvider, liveProvider, runSettings } from './live.js';
import { BudgetReached, promptRecordOf, recordingProvider, replayProvider, type ModelProvider, type ReplayAnswer } from '@neburyx/ee-ai-runtime';

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});
const SIGNAL = new AbortController().signal;
const request = (values: string) => ({ promptId: 'ask.classify', version: 1, instructions: 'Choose.', values });

function folderWith(intents: unknown = { byId: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'node', stableId: '$id' } } } }): string {
  const root = mkdtempSync(join(tmpdir(), 'eval-folder-'));
  made.push(root);
  mkdirSync(join(root, 'src1'));
  writeFileSync(join(root, 'src1', 'classification.md'), 'Choose an intent.\n');
  writeFileSync(join(root, 'src1', 'intents.json'), JSON.stringify(intents));
  return root;
}

describe('the replay provider', () => {
  const answers = new Map<string, ReplayAnswer>([['a', { reply: '{"intent":null,"entities":{}}' }], ['b', { declined: true }], ['c', { failure: 'timeout' }]]);

  it('answers with the recorded reply, the recorded refusal and the recorded failure code, as its own prompt record', async () => {
    const provider = replayProvider(answers);
    const ok = await provider.complete(request('a'), SIGNAL);
    expect(ok).toMatchObject({ status: 'ok', text: '{"intent":null,"entities":{}}', prompt: promptRecordOf(request('a')) });
    expect((await provider.complete(request('b'), SIGNAL)).status).toBe('refused');
    expect(await provider.complete(request('c'), SIGNAL)).toMatchObject({ status: 'failed', code: 'timeout' });
  });

  it('answers a question that has no entry as a failed call, never as a reply', async () => {
    expect(await replayProvider(answers).complete(request('zzz'), SIGNAL)).toMatchObject({ status: 'failed' });
  });
});

describe('the recording provider', () => {
  const inner = (script: (values: string) => 'ok' | 'refused' | 'failed'): ModelProvider => ({
    complete: async (given) => {
      const prompt = promptRecordOf(given);
      const kind = script(given.values);
      if (kind === 'ok') return { status: 'ok', text: `reply to ${given.values}`, usage: { kind: 'known', inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 }, model: 'm', prompt };
      if (kind === 'refused') return { status: 'refused', usage: { kind: 'unknown' }, prompt };
      return { status: 'failed', code: 'rate-limited', prompt };
    },
  });

  it('counts each call before it is made, keeps each answer in the replay form, and sums the token counts', async () => {
    const recording = recordingProvider(inner((values) => (values === 'b' ? 'refused' : values === 'c' ? 'failed' : 'ok')), 3);
    for (const values of ['a', 'b', 'c']) await recording.provider.complete(request(values), SIGNAL);
    expect([...recording.answers()]).toEqual([['a', { reply: 'reply to a' }], ['b', { declined: true }], ['c', { failure: 'rate-limited' }]]);
    expect(recording.usage()).toEqual({ calls: 3, failed: 1, inputTokens: 4, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, withoutCounts: 2, medianMs: expect.any(Number), p95Ms: expect.any(Number) });
  });

  it('times each call with the clock it is given, as the median and the 95th percentile by nearest rank, and 0 with no call', async () => {
    const stamps = [0, 10, 10, 30, 30, 60, 60, 100, 100, 1100];
    let read = 0;
    const timed = recordingProvider(inner(() => 'ok'), 10, () => stamps[read++] ?? 0);
    for (const values of ['a', 'b', 'c', 'd', 'e']) await timed.provider.complete(request(values), SIGNAL);
    expect(timed.usage()).toMatchObject({ calls: 5, medianMs: 30, p95Ms: 1000 });
    expect(recordingProvider(inner(() => 'ok'), 1).usage()).toMatchObject({ calls: 0, medianMs: 0, p95Ms: 0 });
  });

  it('times a call that throws too', async () => {
    let clock = 0;
    const recording = recordingProvider({ complete: async () => Promise.reject(new Error('boom')) }, 1, () => (clock += 7));
    await expect(recording.provider.complete(request('a'), SIGNAL)).rejects.toThrow('boom');
    expect(recording.usage()).toMatchObject({ medianMs: 7, p95Ms: 7 });
  });

  it('never makes a call that would pass the budget', async () => {
    let made = 0;
    const recording = recordingProvider(inner(() => (made++, 'ok')), 2);
    await recording.provider.complete(request('a'), SIGNAL);
    await recording.provider.complete(request('b'), SIGNAL);
    await expect(recording.provider.complete(request('c'), SIGNAL)).rejects.toBeInstanceOf(BudgetReached);
    expect(made).toBe(2);
    expect(recording.usage().calls).toBe(2);
  });

  it('counts a call that throws, records it as a failure and rethrows', async () => {
    const recording = recordingProvider({ complete: async () => Promise.reject(new Error('boom')) }, 2);
    await expect(recording.provider.complete(request('a'), SIGNAL)).rejects.toThrow('boom');
    expect(recording.answers().get('a')).toEqual({ failure: 'provider-error' });
    expect(recording.usage()).toMatchObject({ calls: 1, failed: 1 });
  });
});

describe('the classifier over a loaded folder', () => {
  it('loads the folder the way the product does and gives the intents with their parameters and the hash of the text', async () => {
    const loaded = await loadSource(folderWith(), 'src1');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.source.intents).toEqual([{ name: 'byId', parameters: ['id'] }]);
    expect(loaded.source.classificationSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports the problems of a folder that fails the start-up checks, and of a source the folder does not have', async () => {
    const bad = await loadSource(folderWith({ byId: { parameters: ['id'], query: 'CREATE (n) RETURN n' } }), 'src1');
    expect(bad.ok).toBe(false);
    const missing = await loadSource(folderWith(), 'other');
    expect(missing.ok).toBe(false);
  });

  it('reads a recorded reply with the product\'s reader: an intent, an unknown intent, a reply that does not fit, and none', async () => {
    const loaded = await loadSource(folderWith(), 'src1');
    if (!loaded.ok) throw new Error('not loaded');
    const ask = (reply: string) => classify(loaded.source, replayProvider(new Map([['q', { reply }]])), 'replay', 'q');
    expect(await ask('{"intent":"byId","entities":{"id":"X-1"}}')).toEqual({ ok: true, intent: 'byId', entities: { id: 'X-1' } });
    expect(await ask('{"intent":"nope","entities":{}}')).toEqual({ ok: false, cause: 'unknown-intent' });
    expect(await ask('prose')).toEqual({ ok: false, cause: 'bad-reply' });
    expect(await ask('{"intent":null,"entities":{}}')).toEqual({ ok: false, cause: 'no-intent' });
  });

  it('makes exactly one call for a question, even when the reply does not fit', async () => {
    const loaded = await loadSource(folderWith(), 'src1');
    if (!loaded.ok) throw new Error('not loaded');
    let calls = 0;
    const counting: ModelProvider = { complete: async (given) => (calls++, { status: 'ok', text: 'prose', usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(given) }) };
    await classify(loaded.source, counting, 'm', 'q');
    expect(calls).toBe(1);
  });
});

describe('the live provider', () => {
  const folder = '/somewhere/absolute';
  it.each([
    ['a key in the environment', { NEBURYX_ASK_API_KEY: 'x' }, /NEBURYX_ASK_API_KEY_FILE/],
    ['another folder than the one given', { NEBURYX_ASK_MAPPING_FOLDER: '/elsewhere', NEBURYX_ASK_API_KEY_FILE: '/nowhere' }, /another folder/],
    ['custom headers', { ANTHROPIC_CUSTOM_HEADERS: 'x: y', NEBURYX_ASK_API_KEY_FILE: '/nowhere' }, /ANTHROPIC_CUSTOM_HEADERS/],
    ['a key file that is not there', { NEBURYX_ASK_API_KEY_FILE: '/nowhere/key' }, /does not exist/],
    ['no key at all', {}, /KEY/],
  ])('refuses %s, before any call and without a key in the message', async (_name, env, message) => {
    await expect(liveProvider(env, folder)).rejects.toThrow(LiveProviderError);
    await expect(liveProvider(env, folder)).rejects.toThrow(message);
  });

  it('reads the key from its file only, forces retries to 0 and names no ANTHROPIC variable but the refused one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-key-'));
    made.push(root);
    const key = join(root, 'key');
    writeFileSync(key, 'sk-test-not-a-real-key\n', { mode: 0o600 });
    const built = await liveProvider({ NEBURYX_ASK_API_KEY_FILE: key, NEBURYX_ASK_MAX_RETRIES: '3', ANTHROPIC_API_KEY: 'ignored', ANTHROPIC_BASE_URL: 'http://ignored' }, folder);
    expect(built.model).toBe('claude-haiku-5-5');
    expect(built.effort).toBe('medium');
    expect(built.maxRetries).toBe(0);
  });

  it('settles the model and the effort without a key', () => {
    expect(runSettings({})).toEqual({ model: 'claude-haiku-5-5', effort: 'medium' });
    expect(runSettings({ NEBURYX_ASK_CLASSIFICATION_MODEL: 'other-model', NEBURYX_ASK_EFFORT: 'low' })).toEqual({ model: 'other-model', effort: 'low' });
  });
});

describe('the live provider of the assistant', () => {
  const folder = '/somewhere/absolute';
  const keyFile = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'eval-key-'));
    made.push(root);
    const key = join(root, 'key');
    writeFileSync(key, 'sk-test-not-a-real-key\n', { mode: 0o600 });
    return key;
  };

  it('refuses a key in the environment and a missing key file, before any call', async () => {
    await expect(liveAssistantProvider({ NEBURYX_ASK_API_KEY: 'x' }, folder)).rejects.toThrow(/NEBURYX_ASK_API_KEY_FILE/);
    await expect(liveAssistantProvider({}, folder)).rejects.toThrow(LiveProviderError);
  });

  it('uses the assistant\'s own model and output limit, never Ask\'s, forces retries to 0 and takes the model of a flag over the setting', async () => {
    const env = { NEBURYX_ASK_API_KEY_FILE: keyFile(), NEBURYX_ASK_CLASSIFICATION_MODEL: 'ask-model', NEBURYX_ASK_MAX_RETRIES: '3', NEBURYX_ASSISTANT_MODEL: 'assistant-model', NEBURYX_ASSISTANT_MAX_OUTPUT_TOKENS: '1234' };
    const built = await liveAssistantProvider(env, folder);
    expect(built).toMatchObject({ model: 'assistant-model', outputLimit: 1234, maxRetries: 0 });
    expect((await liveAssistantProvider(env, folder, 'flag-model')).model).toBe('flag-model');
  });

  it('settles the model, the effort and the output limit without a key, with the assistant\'s defaults', () => {
    expect(assistantRunSettings({})).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium', outputLimit: 4000 });
    expect(assistantRunSettings({ NEBURYX_ASSISTANT_MODEL: 'other' }, 'flag')).toMatchObject({ model: 'flag' });
  });

  it('refuses a setting of the assistant that is out of range, naming the setting and never its value', async () => {
    await expect(liveAssistantProvider({ NEBURYX_ASK_API_KEY_FILE: keyFile(), NEBURYX_ASSISTANT_MAX_CALLS: '99' }, folder)).rejects.toThrow(/NEBURYX_ASSISTANT_MAX_CALLS/);
  });
});

