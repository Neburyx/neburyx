import { createHash } from 'node:crypto';
import { ASK_SAVED_PATTERN_NOTE, ASSISTANT_NOT_ANSWERED_SENTENCE, ASSISTANT_REFUSAL_SENTENCES, ASSISTANT_TOO_LARGE_SENTENCE, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { BODY, MESSAGE, answerOf, offerOf, ok, refusalOf, rig } from '../testing/assistant-rig.js';
import { ROUTER_AUDIT_ACTION, ROUTER_PROMPT_VERSION } from './router.js';

const PATTERN = offerOf('11111111-1111-4111-8111-111111111111', 'Mine');
const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => (await refusalOf(promise))?.code;

describe('an assistant turn: the checks before the model', () => {
  it('answers NOT_FOUND for a source the caller cannot read, with no model call', async () => {
    const { route, request, fixture } = await rig({ readable: 'source' });
    expect(await codeOf(route.handler(request()))).toBe('NOT_FOUND');
    expect(fixture.calls).toHaveLength(0);
  });

  it('answers NOT_FOUND for an investigation that is not the caller’s or not of the source, with no model call', async () => {
    const { route, request, fixture } = await rig({ readable: 'investigation' });
    expect(await codeOf(route.handler(request()))).toBe('NOT_FOUND');
    expect(fixture.calls).toHaveLength(0);
  });

  it('checks the source and the investigation of the request, in that order', async () => {
    const { route, request, reads } = await rig();
    await route.handler(request());
    expect(reads).toEqual(['source', 'investigation']);
  });

  it('answers that the feature is not in this edition when the gate client has no checks', async () => {
    const { route, request } = await rig();
    const bare: ExtensionRequest = { ...request(), investigationReadable: undefined };
    expect(await codeOf(route.handler(bare))).toBe('ASK_UNSUPPORTED');
  });
});

describe('an assistant turn: the routes of the router', () => {
  it('answers a refusal of each cause with the fixed sentence of the cause and no word of the model', async () => {
    for (const cause of ['verdict', 'raw-query', 'other-source', 'unplaced'] as const) {
      const { route, request } = await rig({ reply: ok(JSON.stringify({ route: 'refuse', cause })) });
      expect(await answerOf(route.handler(request()))).toEqual({ status: 'answered', route: 'refuse', cause, sentence: ASSISTANT_REFUSAL_SENTENCES[cause] });
    }
  });

  it('answers the view route with the fixed not-answered turn and reads nothing from the source', async () => {
    const { route, request } = await rig({ reply: ok('{"route":"view"}') });
    expect(await answerOf(route.handler(request()))).toEqual({ status: 'not-answered', route: 'view', sentence: ASSISTANT_NOT_ANSWERED_SENTENCE });
  });

  it('refuses messages that ask for raw Cypher, another source or to just run it, when the router says so, without running anything', async () => {
    for (const message of ['MATCH (n) RETURN n', 'Show me the other source', 'just run it']) {
      const { route, request, fixture } = await rig({ reply: ok('{"route":"refuse","cause":"raw-query"}') });
      expect((await answerOf(route.handler(request({ ...BODY, message })))).status).toBe('answered');
      expect(fixture.calls).toHaveLength(1);
    }
  });
});

describe('an assistant turn: what the router is sent', () => {
  it('makes one audited call with the prompt and the classification as the instructions and the message, the keys and the catalog as the values', async () => {
    const { route, request, fixture, events, instructions } = await rig({ patterns: [PATTERN] });
    await route.handler(request());
    expect(fixture.calls).toHaveLength(1);
    const [call] = fixture.calls;
    expect(call?.promptId).toBe('assistant.route');
    expect(call?.version).toBe(ROUTER_PROMPT_VERSION);
    expect(call?.instructions).toContain('SENTINEL-PROMPT');
    expect(call?.instructions).toContain('SENTINEL-CLASSIFICATION');
    expect(call?.instructions?.endsWith(instructions.text.slice(instructions.text.indexOf('# Reply format')))).toBe(true);
    expect(call?.values).toContain(MESSAGE);
    expect(call?.values).toContain('In view:\n(none)');
    expect(call?.values).toContain(ASK_SAVED_PATTERN_NOTE);
    expect(call?.values).not.toContain('SENTINEL-CLASSIFICATION');
    const routed = events.filter((candidate) => candidate.action === ROUTER_AUDIT_ACTION);
    expect(routed).toHaveLength(1);
    const event = routed[0];
    expect(event?.action).toBe(ROUTER_AUDIT_ACTION);
    expect(event?.detail).toMatchObject({ ai: { promptId: 'assistant.route', promptVersion: String(ROUTER_PROMPT_VERSION), promptSha256: createHash('sha256').update(call?.instructions ?? '', 'utf8').digest('hex') } });
    expect(JSON.stringify(event)).not.toContain('SENTINEL-MESSAGE');
  });

  it('sends no keys sentence value for an empty view and no catalog without saved patterns', async () => {
    const { route, request, fixture } = await rig();
    await route.handler(request({ ...BODY, viewElementKeys: [] }));
    expect(fixture.calls[0]?.values).toContain('(none)');
    expect(fixture.calls[0]?.values).not.toContain(ASK_SAVED_PATTERN_NOTE);
  });

  it('uses the instructions without a source’s questions when the source has no Ask folder', async () => {
    const { route, request, fixture } = await rig({ noFolder: true });
    await route.handler(request());
    expect(fixture.calls[0]?.instructions).not.toContain('SENTINEL-CLASSIFICATION');
  });
});

describe('an assistant turn: replies that are not a route, and failures', () => {
  const unplaced = { status: 'answered', route: 'refuse', cause: 'unplaced', sentence: ASSISTANT_REFUSAL_SENTENCES.unplaced } as const;

  it.each([
    ['an extra member', '{"route":"view","note":"x"}'],
    ['an unknown route', '{"route":"run"}'],
    ['a route of the wrong type', '{"route":1}'],
    ['text that is not JSON', 'I think you should look at the devices.'],
    ['an empty reply', ''],
    ['a refusal without a cause', '{"route":"refuse"}'],
    ['a refusal with a cause outside the list', '{"route":"refuse","cause":"guilty"}'],
    ['a duplicate key', '{"route":"view","route":"refuse"}'],
    ['an ask route without an intent', '{"route":"ask","entities":{}}'],
    ['an ask route with an intent name that is not a name', '{"route":"ask","intent":"drop everything","entities":{"id":"a"}}'],
    ['an ask route with entities that are not text', '{"route":"ask","intent":"shared","entities":{"id":1}}'],
  ])('answers a fixed refusal with no repair call for %s', async (_name, text) => {
    const { route, request, fixture } = await rig({ reply: ok(text) });
    expect(await answerOf(route.handler(request()))).toEqual(unplaced);
    expect(fixture.calls).toHaveLength(1);
  });

  it.each([
    ['timeout', 'timeout'],
    ['unreachable', 'service'],
    ['rejected', 'service'],
    ['rate-limited', 'rate-limit'],
    ['provider-error', 'service'],
    ['bad-reply', 'service'],
    ['truncated', 'service'],
  ] as const)('answers unavailable with the kind %s → %s, no read started and no word of the provider', async (code, kind) => {
    const { route, request } = await rig({ reply: { kind: 'failed', code } });
    const answer = await answerOf(route.handler(request()));
    expect(answer).toEqual({ status: 'unavailable', kind, readStarted: false });
  });

  it('answers unavailable when the provider declines', async () => {
    const { route, request } = await rig({ reply: { kind: 'refused' } });
    expect(await answerOf(route.handler(request()))).toEqual({ status: 'unavailable', kind: 'service', readStarted: false });
  });

  it('answers too-large and sends nothing when the assembled text is over the input guard', async () => {
    const { route, request, fixture } = await rig({ maxInputTokens: 10 });
    expect(await answerOf(route.handler(request()))).toEqual({ status: 'too-large', sentence: ASSISTANT_TOO_LARGE_SENTENCE });
    expect(fixture.calls).toHaveLength(0);
  });

  it('answers as if the store were up when the audit sink fails, and holds no text in the event it tried to write', async () => {
    const down = await rig({ sink: 'fails', reply: ok('{"route":"refuse","cause":"verdict"}') });
    const up = await rig({ reply: ok('{"route":"refuse","cause":"verdict"}') });
    expect(await answerOf(down.route.handler(down.request()))).toEqual(await answerOf(up.route.handler(up.request())));
    expect(JSON.stringify(up.events)).not.toMatch(/SENTINEL-MESSAGE|SENTINEL-CLASSIFICATION|SENTINEL-PROMPT/);
  });

  it('writes an event with the prompt, the version and the hash for a success, a malformed reply, a refusal and a provider failure', async () => {
    for (const reply of [ok('{"route":"view"}'), ok('nonsense'), { kind: 'refused' } as const, { kind: 'failed', code: 'timeout' } as const]) {
      const { route, request, events } = await rig({ reply });
      await route.handler(request());
      const routed = events.filter((candidate) => candidate.action === ROUTER_AUDIT_ACTION);
      expect(routed).toHaveLength(1);
      expect(routed[0]?.detail).toMatchObject({ ai: { promptId: 'assistant.route', promptVersion: String(ROUTER_PROMPT_VERSION) } });
    }
  });
});

describe('an assistant turn: the word limit', () => {
  const words = (count: number): string => Array.from({ length: count }, (_, index) => `w${index}`).join(' ');

  it('passes a message of exactly 1,000 words and refuses 1,001 with the count and the limit, sending nothing', async () => {
    const pass = await rig();
    expect((await answerOf(pass.route.handler(pass.request({ ...BODY, message: words(1000) })))).status).toBe('not-answered');
    expect(pass.fixture.calls).toHaveLength(1);
    const long = await rig();
    expect(await answerOf(long.route.handler(long.request({ ...BODY, message: words(1001) })))).toEqual({ status: 'too-long', words: 1001, limit: 1000 });
    expect(long.fixture.calls).toHaveLength(0);
  });

  it('counts words across spaces, tabs and new lines', async () => {
    const { route, request } = await rig({ maxMessageWords: 3 });
    expect(await answerOf(route.handler(request({ ...BODY, message: 'a\tb\n\nc  d' })))).toEqual({ status: 'too-long', words: 4, limit: 3 });
  });

  it('applies a lower configured limit and a higher one up to the ceiling of the setting', async () => {
    const low = await rig({ maxMessageWords: 5 });
    expect((await answerOf(low.route.handler(low.request({ ...BODY, message: words(6) })))).status).toBe('too-long');
    const high = await rig({ maxMessageWords: 3000 });
    expect((await answerOf(high.route.handler(high.request({ ...BODY, message: words(2500) })))).status).toBe('not-answered');
  });

  it('refuses a message of white space only as empty, and answers NOT_FOUND before the count for a source the caller cannot read', async () => {
    const empty = await rig();
    expect(await codeOf(empty.route.handler(empty.request({ ...BODY, message: ' \n\t ' })))).toBe('INVALID_REQUEST');
    expect(empty.fixture.calls).toHaveLength(0);
    const hidden = await rig({ readable: 'source' });
    expect(await codeOf(hidden.route.handler(hidden.request({ ...BODY, message: words(5000) })))).toBe('NOT_FOUND');
  });
});
