import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promptRecordOf, type ModelAnswer, type ModelRequest } from '@neburyx/ee-ai-runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, ok, rig, type RigOptions } from '../testing/assistant-rig.js';
import { ROUTER_PREAMBLE_MAX_CHARACTERS, readRouterReply } from './router-reply.js';
import { createMemoryAssistantRunStore } from './run-store.js';

afterAll(removeAskFolders);

const REASONING = 'SENTINEL-REASONING: no listed question counts this.';
const ROUTE = JSON.stringify({ route: 'ask', intent: 'shared', entities: { id: 'A-1' } });
const OTHER = JSON.stringify({ route: 'refuse', cause: 'verdict' });
const ACCEPTED = `${REASONING}\n\n${ROUTE}`;

/** Every reply that is not a route although a route can be seen in it. */
const REJECTED: readonly (readonly [string, string])[] = [
  ['two objects, each on a line of its own', `${REASONING}\n${OTHER}\n\n${ROUTE}`],
  ['two objects on the last line', `${REASONING}\n${OTHER} ${ROUTE}`],
  ['a route quoted inside the reasoning', `The message quotes ${OTHER} as an example.\n\n${ROUTE}`],
  ['a route-like object quoted from a line of the source', `The line reads:\n  "note": {"route":"ask","intent":"shared","entities":{"id":"A-9"}}\n\n${ROUTE}`],
  ['an opening brace in the reasoning', `A { in the text.\n\n${ROUTE}`],
  ['a closing brace in the reasoning', `A } in the text.\n\n${ROUTE}`],
  ['an object that is not the last line', `${REASONING}\n${ROUTE}\nThat is my route.`],
  ['text after the object on its line', `${REASONING}\n${ROUTE} is the route.`],
  ['the object on the line of the text', `${REASONING} ${ROUTE}`],
  ['an object over several lines', `${REASONING}\n\n{"route":"refuse",\n"cause":"verdict"}`],
  ['a last line that does not start with the brace', `${REASONING}\n\n  ${ROUTE}`],
  ['a code fence', `${REASONING}\n\n\`\`\`json\n${ROUTE}\n\`\`\``],
  ['a route with a field the strict reader refuses', `${REASONING}\n\n{"route":"view","extra":1}`],
  ['a route with a key given twice', `${REASONING}\n\n{"route":"view","route":"view"}`],
  ['reasoning over the limit', `${'a'.repeat(ROUTER_PREAMBLE_MAX_CHARACTERS + 1)}\n\n${ROUTE}`],
  ['a reply over the reader\'s limit', `${REASONING}\n\n${' '.repeat(100_000)}\n${ROUTE}`],
];

describe('the reading of a router reply', () => {
  it('reads a bare route as it is', () => {
    expect(readRouterReply(` ${ROUTE}\n`)).toEqual({ ok: true, reply: { route: 'ask', intent: 'shared', entities: { id: 'A-1' } }, kept: ` ${ROUTE}\n` });
  });

  it.each([
    ['a blank line between', ACCEPTED],
    ['one line break', `${REASONING}\n${ROUTE}`],
    ['trailing white space', `${ACCEPTED}\n \n`],
    ['Windows line breaks', `${REASONING}\r\n\r\n${ROUTE}\r\n`],
    ['reasoning of exactly the limit', `${'a'.repeat(ROUTER_PREAMBLE_MAX_CHARACTERS)}\n\n${ROUTE}`],
    ['a limit counted in characters, not code units', `${'\u{1F600}'.repeat(ROUTER_PREAMBLE_MAX_CHARACTERS)}\n\n${ROUTE}`],
  ])('reads the route after the reasoning, with %s, and keeps the route alone', (_name, text) => {
    const read = readRouterReply(text);
    expect(read).toMatchObject({ ok: true, reply: { route: 'ask', intent: 'shared' } });
    expect(read.ok && read.kept.trimEnd()).toBe(ROUTE);
  });

  it.each(REJECTED)('refuses %s', (_name, text) => {
    expect(readRouterReply(text)).toEqual({ ok: false });
  });

  it.each(['banking-fraud', 'insurance-claims'])('reads the route after the reasoning for every intent of the %s pack', (pack) => {
    const intents = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../domain-packs/${pack}/ask/intents.json`, import.meta.url)), 'utf8')) as Record<string, { readonly parameters: readonly string[] }>;
    expect(Object.keys(intents).length).toBeGreaterThan(0);
    for (const [intent, { parameters }] of Object.entries(intents)) {
      const route = { route: 'ask', intent, entities: Object.fromEntries(parameters.map((role) => [role, 'X-1'])) };
      expect(readRouterReply(`${REASONING}\n\n${JSON.stringify(route)}`)).toMatchObject({ ok: true, reply: route });
    }
  });

  it('reads the 13 prose first replies of the committed Sonnet recording as the route each ends with', () => {
    const recording = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../tools/ask-eval/data/assistant/claude-sonnet-5-5/replay.json', import.meta.url)), 'utf8')) as { readonly answers: Record<string, { readonly reply?: string }> };
    const prose = Object.entries(recording.answers).flatMap(([asked, { reply }]) => (asked.includes('Your last reply was not a route') || reply === undefined || reply.startsWith('{') ? [] : [reply]));
    expect(prose).toHaveLength(13);
    for (const reply of prose) {
      const last = reply.slice(reply.lastIndexOf('\n') + 1);
      expect(readRouterReply(reply)).toMatchObject({ ok: true, reply: JSON.parse(last) as object, kept: last });
    }
  });
});

async function turn(reply: string, options: RigOptions = {}) {
  const store = createMemoryAssistantRunStore({});
  const logs: NonNullable<RigOptions['logs']> = [];
  const r = await rig({ reply: ok(reply), routerMaxCalls: 3, runStore: store, logs, ...options });
  const settle = async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
  };
  const answer = async () => {
    const result = await r.route.handler(r.request(BODY)).then((value) => ({ value }), (error: unknown) => ({ error }));
    await settle();
    return result;
  };
  const recorded = () => store.runs[0]?.callEnds ?? [];
  /** All the product shows, stores, logs and sends on: everything but what the model itself returned. */
  const everything = (result: unknown) => JSON.stringify([result, recorded(), store.runs.map((run) => [run.callStarts, run.start]), r.events, logs, r.fixture.calls]);
  return { r, answer, recorded, everything };
}

describe('a turn whose router writes its reasoning before the route', () => {
  it('takes the route in one call, does not mark the call, and keeps the reasoning nowhere', async () => {
    const t = await turn(ACCEPTED);
    const result = await t.answer();
    expect(t.r.fixture.calls).toHaveLength(1);
    expect(t.r.runs).toHaveLength(1);
    expect(t.recorded()).toHaveLength(1);
    expect(t.recorded()[0]).toMatchObject({ status: 'answered', replyText: ROUTE });
    expect(t.everything(result)).not.toContain('SENTINEL-REASONING');
  });

  it.each(REJECTED.filter(([name]) => !name.startsWith('a reply over')))('asks again for %s, then does not place the message', async (_name, reply) => {
    const t = await turn(reply);
    await t.answer();
    expect(t.r.fixture.calls).toHaveLength(2);
    expect(t.r.runs).toHaveLength(0);
    expect(t.recorded().map((call) => call.status)).toEqual(['failed', 'failed']);
    expect(t.recorded()[0]).toMatchObject({ failureKind: 'not-a-route', replyText: reply });
  });

  it('asks again for a route the turn does not accept, and still keeps no reasoning', async () => {
    const clarify = JSON.stringify({ route: 'clarify', intent: 'shared', role: 'id', entities: {}, candidates: ['c8', 'c9'] });
    const t = await turn(`${REASONING}\n\n${clarify}`);
    const result = await t.answer();
    expect(t.r.fixture.calls).toHaveLength(2);
    expect(t.r.runs).toHaveLength(0);
    expect(t.recorded()[0]).toMatchObject({ status: 'failed', failureKind: 'not-a-route', replyText: clarify });
    expect(t.everything(result)).not.toContain('SENTINEL-REASONING');
  });

  it.each([
    ['fails the audit after the reply arrived', (request: ModelRequest): ModelAnswer => ({ status: 'ok', text: ACCEPTED, usage: { kind: 'unknown' }, model: 'm', prompt: { ...promptRecordOf(request), id: 'another' } })],
    ['is refused with the reply', (request: ModelRequest): ModelAnswer => ({ status: 'refused', usage: { kind: 'unknown' }, prompt: promptRecordOf(request), received: ACCEPTED })],
    ['is cut off with the reply', (request: ModelRequest): ModelAnswer => ({ status: 'failed', code: 'truncated', usage: { kind: 'unknown' }, prompt: promptRecordOf(request), received: ACCEPTED })],
  ])('keeps the route alone when the call %s', async (_name, answerOf) => {
    const t = await turn(ACCEPTED);
    Object.assign(t.r.fixture, { complete: async (request: ModelRequest) => answerOf(request) });
    const result = await t.answer();
    expect(t.recorded()[0]).toMatchObject({ replyText: ROUTE });
    expect(t.everything(result)).not.toContain('SENTINEL-REASONING');
  });
});
