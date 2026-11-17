import { createHash } from 'node:crypto';
import { ASK_SAVED_PATTERN_NOTE, type AskClassifyInput, type AskFolder, type AuditEvent, type AuditSink } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createAuditedModelCall } from '@neburyx/ee-ai-runtime';
import type { ModelProvider } from '@neburyx/ee-ai-runtime';
import { createFixtureProvider, replyKey, type FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';
import { CLASSIFY_AUDIT_ACTION, CLASSIFY_PROMPT_ID, CLASSIFY_PROMPT_VERSION, createAskClassifier } from './classifier.js';

const SIGNAL = new AbortController().signal;
const CLASSIFICATION = 'You classify questions. Answer with one JSON object with the keys intent and entities.';
const SHA = createHash('sha256').update(CLASSIFICATION, 'utf8').digest('hex');
const folder: AskFolder = {
  sourceIds: ['demo'],
  source: (id) => (id === 'demo' ? { classification: { text: CLASSIFICATION, sha256: SHA }, intents: [{ name: 'byId', parameters: ['id'], kind: 'query', query: { text: 'MATCH (n) WHERE n.id = $id RETURN n', sha256: 'x' } }, { name: 'shared', parameters: ['ref'], kind: 'template', template: 'shared-attribute', settings: {} }] } : undefined),
  intent: () => undefined,
};
const QUESTION = 'Who shares a thing with SENTINEL-QUESTION-TEXT?';
const input = (over: Partial<AskClassifyInput> = {}): AskClassifyInput => ({ sourceId: 'demo', question: QUESTION, actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator', traceId: 'tr-1', ...over });

function rig(reply: FixtureReply | ((request: unknown) => FixtureReply), options: { failure?: Error; provider?: ModelProvider } = {}) {
  const events: AuditEvent[] = [];
  const sink: AuditSink = { record: (event) => (options.failure === undefined ? (events.push(event), Promise.resolve()) : Promise.reject(options.failure)) };
  const fixture = createFixtureProvider({ replies: { [replyKey(CLASSIFY_PROMPT_ID, CLASSIFY_PROMPT_VERSION)]: reply as FixtureReply } });
  const model = createAuditedModelCall({ provider: options.provider ?? fixture, configuration: { model: 'configured-model' }, sink });
  return { classifier: createAskClassifier({ model, folder: () => folder }), fixture, events };
}

const ok = (text: string): FixtureReply => ({ kind: 'ok', text, usage: { kind: 'known', inputTokens: 20, outputTokens: 10 } });

describe('the classifier of Ask', () => {
  it('turns a recorded reply of the right shape into an intent and entities, with the classification text as the instructions and the question as the values', async () => {
    const { classifier, fixture, events } = rig(ok('{"intent":"byId","entities":{"id":"A-1"}}'));
    expect(await classifier.classify(input(), SIGNAL)).toEqual({ ok: true, intent: 'byId', entities: { id: 'A-1' } });
    expect(fixture.calls).toEqual([{ promptId: 'ask.classify', version: 1, instructions: CLASSIFICATION, values: QUESTION }]);
    expect(events).toHaveLength(1);
  });

  it('sends the question alone without a catalog, and with one the question, the note and the catalog and nothing else, and may then answer saved-pattern', async () => {
    const catalog = 'pat_1, named "My ring": anchor maker, asked\n\n';
    const { classifier, fixture } = rig(ok('{"intent":"saved-pattern","entities":{"pattern":"pat_1"}}'));
    expect(await classifier.classify(input({ patternCatalog: catalog }), SIGNAL)).toEqual({ ok: true, intent: 'saved-pattern', entities: { pattern: 'pat_1' } });
    expect(fixture.calls).toEqual([{ promptId: 'ask.classify', version: 1, instructions: CLASSIFICATION, values: `${QUESTION}\n\n${ASK_SAVED_PATTERN_NOTE}\n${catalog}` }]);
    expect(await rig(ok('{"intent":"saved-pattern","entities":{"pattern":"pat_1"}}')).classifier.classify(input(), SIGNAL)).toEqual({ ok: false, cause: 'unknown-intent' });
  });

  it('is available', () => {
    expect(rig(ok('{}')).classifier.availability()).toEqual({ available: true });
  });

  it('answers no intent for null, and an unknown intent for a name the folder lacks', async () => {
    expect(await rig(ok('{"intent":null,"entities":{}}')).classifier.classify(input(), SIGNAL)).toEqual({ ok: false, cause: 'no-intent' });
    expect(await rig(ok('{"intent":"wipe","entities":{}}')).classifier.classify(input(), SIGNAL)).toEqual({ ok: false, cause: 'unknown-intent' });
  });

  it.each([
    ['an extra key', '{"intent":"byId","entities":{},"x":1}'],
    ['a missing key', '{"intent":"byId"}'],
    ['text around the object', 'Sure! {"intent":"byId","entities":{}}'],
    ['no object', 'I do not know'],
  ])('refuses a reply that does not fit (%s) with the cause bad-reply and the one event of the call', async (_name, text) => {
    const { classifier, events } = rig(ok(text));
    expect(await classifier.classify(input(), SIGNAL)).toEqual({ ok: false, cause: 'bad-reply' });
    expect(events).toHaveLength(1);
  });

  it('refuses a provider that declines and one that fails, each with one event and no word of the provider', async () => {
    const declined = rig({ kind: 'refused' });
    expect(await declined.classifier.classify(input(), SIGNAL)).toEqual({ ok: false, cause: 'model-declined' });
    expect(declined.events).toMatchObject([{ result: 'refused' }]);
    for (const code of ['timeout', 'unreachable', 'rejected', 'rate-limited', 'provider-error', 'bad-reply', 'truncated'] as const) {
      const failed = rig({ kind: 'failed', code });
      expect(await failed.classifier.classify(input(), SIGNAL), code).toEqual({ ok: false, cause: 'model-failed' });
      expect(failed.events, code).toMatchObject([{ result: 'failed' }]);
    }
  });

  it('refuses a provider that throws as model-failed, with its failed event, and makes no second call', async () => {
    let calls = 0;
    const provider: ModelProvider = { complete: () => { calls += 1; return Promise.reject(new Error('SENTINEL-PROVIDER-TEXT')); } };
    const { classifier, events } = rig(ok('{}'), { provider });
    expect(await classifier.classify(input(), SIGNAL)).toEqual({ ok: false, cause: 'model-failed' });
    expect(calls).toBe(1);
    expect(events).toMatchObject([{ result: 'failed' }]);
  });

  it('makes no call and writes no event for a source with no folder', async () => {
    const { classifier, fixture, events } = rig(ok('{}'));
    expect(await classifier.classify(input({ sourceId: 'other' }), SIGNAL)).toEqual({ ok: false, cause: 'no-ask-for-source' });
    expect(fixture.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it.each([['a blank question', ' \n '], ['an empty question', ''], ['a question over 1,000 code points', 'x'.repeat(1001)]])('throws a range error for %s before anything is called', async (_name, question) => {
    const { classifier, fixture } = rig(ok('{}'));
    await expect(classifier.classify(input({ question }), SIGNAL)).rejects.toBeInstanceOf(RangeError);
    expect(fixture.calls).toEqual([]);
  });

  it('counts the limit in code points, not in UTF-16 units', async () => {
    const { classifier } = rig(ok('{"intent":null,"entities":{}}'));
    expect(await classifier.classify(input({ question: '😀'.repeat(1000) }), SIGNAL)).toEqual({ ok: false, cause: 'no-intent' });
  });

  it('rejects when the audit cannot be written, and answers nothing', async () => {
    const { classifier } = rig(ok('{"intent":"byId","entities":{}}'), { failure: new Error('sink down') });
    await expect(classifier.classify(input(), SIGNAL)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  });

  it('passes the abort signal to the provider, and a provider that fails on the abort is a model-failed with its event', async () => {
    const controller = new AbortController();
    const provider: ModelProvider = {
      complete: (_request, signal) => Promise.resolve(signal.aborted ? { status: 'failed' as const, code: 'timeout' as const, usage: { kind: 'unknown' as const }, prompt: { id: CLASSIFY_PROMPT_ID, version: CLASSIFY_PROMPT_VERSION, sha256: SHA } } : { status: 'ok' as const, text: '', usage: { kind: 'unknown' as const }, model: 'm', prompt: { id: CLASSIFY_PROMPT_ID, version: CLASSIFY_PROMPT_VERSION, sha256: SHA } }),
    };
    controller.abort();
    const { classifier, events } = rig(ok('{}'), { provider });
    expect(await classifier.classify(input(), controller.signal)).toEqual({ ok: false, cause: 'model-failed' });
    expect(events).toMatchObject([{ result: 'failed' }]);
  });

  it('writes events that hold the prompt id, version, the hash of classification.md and the tokens, and never the question or the reply', async () => {
    const cases: readonly (readonly [string, FixtureReply])[] = [
      ['a good reply', ok('{"intent":"byId","entities":{"id":"SENTINEL-ENTITY"}}')],
      ['a reply that does not fit', ok('SENTINEL-REPLY-TEXT')],
      ['an unknown intent', ok('{"intent":"SENTINEL-INTENT","entities":{"SENTINEL":"SENTINEL"}}')],
      ['no intent', ok('{"intent":null,"entities":{}}')],
      ['an extra key', ok('{"intent":"byId","entities":{},"SENTINEL":1}')],
      ['a missing key', ok('{"intent":"byId"}')],
      ['text around the object', ok('SENTINEL {"intent":"byId","entities":{}} SENTINEL')],
      ['a decline', { kind: 'refused' }],
      ['a failure', { kind: 'failed', code: 'provider-error' }],
    ];
    for (const [name, reply] of cases) {
      const { classifier, events } = rig(reply);
      await classifier.classify(input(), SIGNAL);
      expect(events, name).toHaveLength(1);
      expect(events[0], name).toMatchObject({ action: CLASSIFY_AUDIT_ACTION, sourceId: 'demo', detail: { ai: { promptId: 'ask.classify', promptVersion: '1', promptSha256: SHA } } });
      expect(JSON.stringify(events[0]), name).not.toMatch(/SENTINEL|Who shares/);
    }
    const { classifier, events } = rig(ok('{"intent":null,"entities":{}}'));
    await classifier.classify(input(), SIGNAL);
    expect(events[0]?.detail).toMatchObject({ ai: { tokensIn: 20, tokensOut: 10 } });
  });
});
