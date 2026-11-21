import { assistantStepMembersSchema, assistantTurnAnswerSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';
import { removeAskFolders } from '../testing/ask-folder.js';
import { VIEW_BODY, answerOf, ok, okResult, rig, routeAsk, type Rig, type RigOptions } from '../testing/assistant-rig.js';

afterAll(removeAskFolders);

const SHARED = routeAsk('shared', { id: 'A-1' });
const TOOL = ok(JSON.stringify({ tool: 'byId', values: { id: 'A-2' } }));
const DONE = ok('{"done":true}');
const sentences = (...list: { text: string; cites: string[] }[]) => ok(JSON.stringify({ sentences: list }));
const sequence = (...replies: FixtureReply[]) => {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? DONE;
};
const LABELLED = {
  byId: { label: 'Account by id', parameters: ['id'], query: 'MATCH (n) WHERE n.id = $id RETURN n LIMIT 5' },
  shared: { label: 'Accounts at the same bank', parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'shape', via: 'USES_SHAPE' } },
};

/** One turn through the route with `emit`, and the events it sent, in order. */
async function streamed(options: RigOptions, body: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  const t = await rig(options);
  const events: { name: string; members: Record<string, unknown> }[] = [];
  const answer = await answerOf(t.route.handler(t.request({ ...VIEW_BODY, ...body }, { emit: (name: string, members: unknown) => events.push({ name, members: members as Record<string, unknown> }), ...over })));
  return { t, events, answer };
}
const phases = (events: { members: Record<string, unknown> }[]): unknown[] => events.map((event) => event.members['phase']);
const loopOptions = (over: Partial<RigOptions> = {}): RigOptions => ({ reply: SHARED, step: sequence(TOOL, DONE), answer: sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }), run: () => ({ status: 'ok', result: okResult() }), ...over });

describe('the steps a streamed turn reports', () => {
  it('says routing, reading the view and answering, in that order, before each starts, for a message on the view', async () => {
    const { events, answer } = await streamed({ view: sentences({ text: 'Account A-1 is in view.', cites: ['n1'] }) });
    expect(events.map((event) => event.name)).toEqual(['step', 'step', 'step']);
    expect(phases(events)).toEqual(['routing', 'reading-view', 'answering']);
    expect(events.map((event) => event.members['n'])).toEqual([1, 2, 3]);
    expect(answer).toMatchObject({ status: 'answered', route: 'view' });
  });

  it('ends with the same answer the JSON route gives for the same turn, and every event fits the contract', async () => {
    const options: RigOptions = { view: sentences({ text: 'Account A-1 is in view.', cites: ['n1'] }) };
    const withEvents = await streamed(options);
    const plain = await rig(options);
    const plainAnswer = await answerOf(plain.route.handler(plain.request(VIEW_BODY)));
    expect(assistantTurnAnswerSchema.safeParse(withEvents.answer).success).toBe(true);
    expect(withEvents.answer).toEqual(plainAnswer);
    for (const event of withEvents.events) expect(assistantStepMembersSchema.safeParse(event.members).success).toBe(true);
  });

  it('sends nothing for a request that is not streamed', async () => {
    const t = await rig({ view: sentences({ text: 'Account A-1 is in view.', cites: ['n1'] }) });
    expect(t.request(VIEW_BODY).emit).toBeUndefined();
    expect(await answerOf(t.route.handler(t.request(VIEW_BODY)))).toMatchObject({ status: 'answered' });
  });

  it('gives each read of the loop its tool, its label when the intent has one, and its subject, then answering', async () => {
    const { events } = await streamed(loopOptions({ intents: LABELLED }), { message: 'Show A-1 and A-2' });
    const reads = events.filter((event) => event.members['phase'] === 'reading').map((event) => event.members);
    expect(reads).toEqual([
      { n: 2, phase: 'reading', tool: 'shared', label: 'Accounts at the same bank', subject: 'A-1', kind: 'intent' },
      { n: 4, phase: 'reading', tool: 'byId', label: 'Account by id', subject: 'A-2', kind: 'intent' },
    ]);
    expect(phases(events)).toEqual(['routing', 'reading', 'read-done', 'reading', 'read-done', 'answering']);
  });

  it('shows the id as the tool and no label for an intent without one', async () => {
    const { events } = await streamed(loopOptions(), { message: 'Show A-1 and A-2' });
    const first = events.find((event) => event.members['phase'] === 'reading');
    expect(first?.members).toMatchObject({ tool: 'shared' });
    expect(first?.members).not.toHaveProperty('label');
  });

  it('shows a label with markup as text and keeps a long subject within the limit of the event', async () => {
    const longId = 'A'.repeat(150);
    const { events } = await streamed(loopOptions({ reply: routeAsk('shared', { id: longId }), intents: { ...LABELLED, shared: { ...LABELLED.shared, label: '<b>Accounts</b>' } } }), { message: 'Show it' });
    const first = events.find((event) => event.members['phase'] === 'reading')?.members;
    expect(first?.['label']).toBe('<b>Accounts</b>');
    expect(String(first?.['subject']).length).toBeLessThanOrEqual(400);
    for (const event of events) expect(assistantStepMembersSchema.safeParse(event.members).success).toBe(true);
  });

  it('shows what the analyst typed as the subject of a masked turn: the accepted values and no value read from a result', async () => {
    const { events } = await streamed(loopOptions({ reply: routeAsk('shared', { id: 'Ana Silva' }) }), { message: 'Show Ana Silva', mask: true });
    const first = events.find((event) => event.members['phase'] === 'reading')?.members;
    expect(first?.['subject']).toBe('Ana Silva');
    expect(JSON.stringify(events)).not.toContain('Account A-1');
  });

  it('puts nothing a model wrote in any event: a canary in the router reply, the step reply and the answer, each sent by the model and none in an event', async () => {
    const CANARY = 'zzcanaryzz';
    const given: string[] = [];
    const say = (text: string): FixtureReply => {
      if (text.includes(CANARY)) given.push(text);
      return ok(text);
    };
    const bareView = JSON.stringify({ route: 'view' });
    // the router: a reply with the canary around the route is asked for again; the answer carries the canary too
    let routed = 0;
    const viewed = await streamed({ routerMaxCalls: 3, maxCalls: 6, reply: () => say(routed++ === 0 ? `${CANARY} ${bareView}` : bareView), view: sentences({ text: `Account A-1 is in view ${CANARY}.`, cites: ['n1'] }) });
    expect(given.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(viewed.answer)).toContain(CANARY);
    expect(viewed.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(viewed.events)).not.toContain(CANARY);
    // the step reply: a reply with the canary around the request is asked for again; the answer carries the canary
    given.length = 0;
    let stepped = 0;
    const step = () => say(stepped++ === 0 ? `${CANARY} ${JSON.stringify({ tool: 'byId', values: { id: 'A-2' } })}` : stepped === 2 ? JSON.stringify({ tool: 'byId', values: { id: 'A-2' } }) : '{"done":true}');
    const looped = await streamed(loopOptions({ step, answer: sentences({ text: `Account A-1 is listed ${CANARY}.`, cites: ['r1'] }) }), { message: 'Show A-1 and A-2' });
    expect(given.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(looped.answer)).toContain(CANARY);
    expect(looped.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(looped.events)).not.toContain(CANARY);
  });

  it('says that a view call that asks for a read has already said answering: the order is pinned, routing, the view, answering, the view read, the read, its read, answering', async () => {
    const asksRead = ok(JSON.stringify({ tool: 'byId', values: { id: 'A-2' } }));
    const { events } = await streamed(loopOptions({ reply: ok(JSON.stringify({ route: 'view' })), view: asksRead, step: sequence(DONE), intents: LABELLED }), { message: 'What is in view, and read A-2' });
    expect(phases(events)).toEqual(['routing', 'reading-view', 'answering', 'read-done', 'reading', 'read-done', 'answering']);
  });

  it('tells the first read of an Ask turn once when the loop is on and the model has nothing more to read, and what it tells is what the answer lists', async () => {
    const { events, answer } = await streamed(loopOptions({ step: sequence(DONE) }), { message: 'Show A-1' });
    expect(phases(events)).toEqual(['routing', 'reading', 'read-done']);
    if (answer.status !== 'answered' || answer.route !== 'ask' || answer.reads === undefined) throw new Error('not an answer of the ask route with reads');
    expect(events.at(-1)?.members['read']).toEqual(answer.reads[0]);
  });

  it('sends at most twice maxSteps + 4 events in a turn that reads as often as it may', async () => {
    const many = sequence(...Array.from({ length: 12 }, (_unused, index) => ok(JSON.stringify({ tool: 'byId', values: { id: `A-${index + 2}` } }))));
    const { events } = await streamed(loopOptions({ step: many, loopSteps: 4 }), { message: 'Show A-1 and everything' });
    expect(events.length).toBeLessThanOrEqual(2 * 4 + 4);
    expect(phases(events).at(-1)).toBe('answering');
  });

  it('ends a turn whose model call failed with the unavailable answer after its steps, and writes the closing event once', async () => {
    const { t, events, answer } = await streamed({ view: { kind: 'failed', code: 'timeout' } });
    expect(phases(events)).toEqual(['routing', 'reading-view', 'answering']);
    expect(answer).toMatchObject({ status: 'unavailable' });
    expect(t.events.filter((event) => event.action === 'assistant.turn.closed')).toHaveLength(1);
  });

  it('ends a refused turn with its answer and no read step', async () => {
    const { events, answer } = await streamed({ reply: ok(JSON.stringify({ route: 'refuse', cause: 'verdict' })) }, { message: 'Is it fraud?' });
    expect(phases(events)).toEqual(['routing']);
    expect(answer).toMatchObject({ status: 'answered', route: 'refuse', cause: 'verdict' });
  });

  it('says only routing for a meaning question, which makes no read', async () => {
    const meaning = ok(JSON.stringify({ route: 'meaning', types: ['widget'] }));
    const { events, answer } = await streamed({ reply: meaning }, { message: 'What is a widget?' }, { typeDescriptions: () => ({ entityTypes: [{ type: 'widget', label: 'Widget', displayName: 'Widget', description: 'A widget is a unit.' }], relationshipTypes: [] }) });
    expect(phases(events)).toEqual(['routing']);
    expect(answer).toMatchObject({ status: 'meaning' });
  });
});

export type { Rig };
