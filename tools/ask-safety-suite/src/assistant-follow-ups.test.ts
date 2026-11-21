import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import type { ExecuteCall } from '../../../services/api/src/gate/executor.js';
import { startAssistantRig, type AssistantRig } from './assistant-rig.js';
import { expectNoValue } from './checks.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

const FIRST = '0192f000-0000-7000-8000-000000000001';
const SECOND = '0192f000-0000-7000-8000-000000000002';
const key = (type: string, id: string): string => JSON.stringify(['node', 'demo', type, id]);
const EDGE = JSON.stringify(['edge', 'demo', 'stored', 'MADE_FROM', 'widget', 'gadget', 'L-1']);
const VIEW = [key('widget', 'W-1'), EDGE];
const widgetNode = { $type: 'node', elementId: '4:s:W-1', labels: ['Widget'], properties: { widgetId: 'W-1', ownerName: 'Ana Silva' } };
const ASK = JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: 'W-1' } });
const naming = (element: string): string => JSON.stringify({ route: 'ask', intent: 'widgetById', entities: {}, elements: { id: element } });
const ASK_SHARED = JSON.stringify({ route: 'ask', intent: 'sharedGadget', entities: { id: 'W-1' } });
const MILLISECONDS_A_MINUTE = 60_000;

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

/** The reads of the intent: the entity template the intent runs; the gate's reads of elements (the context's or the candidates') are not. */
const intentReads = (reads: readonly ExecuteCall[]): ExecuteCall[] => reads.filter((call) => call.templateId === 'entity-load' || call.templateId.startsWith('shared-attribute'));
const expectIntentRan = (reads: readonly ExecuteCall[]): void => {
  if (intentReads(reads).length === 0) throw new Error('the intent ran no read');
};
const expectNoIntentRead = (reads: readonly ExecuteCall[]): void => {
  if (intentReads(reads).length > 0) throw new Error(`the intent ran: ${intentReads(reads).map((call) => call.templateId).join(', ')}`);
};

interface Setup {
  readonly rig: AssistantRig;
  readonly person: { current: string };
  readonly clock: { now: number };
}

async function start(): Promise<Setup> {
  const person = { current: FIRST };
  const clock = { now: Date.now() };
  const rig = await startAssistantRig({
    stub,
    threads: true,
    principalId: () => person.current,
    now: () => clock.now,
    respond: (call) => {
      if (call.templateId === 'entity-load') return { status: 'rows', rows: [{ n: widgetNode }] };
      if (call.templateId === 'shared-attribute-count') return { status: 'rows', rows: [{ matches: 1_000_000, anchorBounded: false, skipped: false }] };
      return undefined;
    },
  });
  return { rig, person, clock };
}

/** A first turn that ran the intent for W-1, so the thread holds an element by the key c1. */
async function earlierTurn(setup: Setup): Promise<void> {
  const first = await setup.rig.turn('Show W-1', [ASK, '{"done":true}'], { viewElementKeys: VIEW });
  expect(first.body).toMatchObject({ status: 'answered', route: 'ask' });
  await setup.rig.threadWritten(1);
}

const asksOrRefuses = (body: Record<string, unknown>): boolean => body['status'] === 'clarification' || (body['status'] === 'answered' && body['route'] === 'refuse');
const closing = (rig: AssistantRig) => rig.events().filter((event) => event.action === 'assistant.turn.closed');

describe('a hostile key in the reply of the router, through the real application', () => {
  const HOSTILE = [
    ['an invented key', 'c9'],
    ['a key past the elements given', 'c99'],
    ['a stable id where a key stands', 'W-1'],
    ['query text where a key stands', 'MATCH (n) DETACH DELETE n RETURN n'],
    ['a key of a relationship under a role', 'e1'],
  ] as const;

  it.each(HOSTILE)('runs nothing for %s: no read of the intent, at most the router’s call and its one repeat, and the value reaches no log or record', async (_name, forged) => {
    const setup = await start();
    await earlierTurn(setup);
    const before = setup.rig.reads().length;
    const calls = stub.requests.length;
    const answer = await setup.rig.turn('and what else about it?', [naming(forged), naming(forged)], { viewElementKeys: VIEW });
    expect(answer.status).toBe(200);
    expect(asksOrRefuses(answer.body), JSON.stringify(answer.body).slice(0, 200)).toBe(true);
    expectNoIntentRead(setup.rig.reads().slice(before));
    expect(stub.requests.length - calls).toBeLessThanOrEqual(2);
    expectNoValue([setup.rig.events(), setup.rig.logs], ['DETACH DELETE']);
    await setup.rig.close();
  });

  it('canary: the same request with the key the thread gave runs the intent, so the check that the intent ran no read fails on it', async () => {
    const setup = await start();
    await earlierTurn(setup);
    const before = setup.rig.reads().length;
    const answer = await setup.rig.turn('and what else about it?', [naming('c1'), '{"done":true}'], { viewElementKeys: VIEW });
    expect(answer.body).toMatchObject({ status: 'answered', route: 'ask' });
    expect(() => expectNoIntentRead(setup.rig.reads().slice(before))).toThrow(/the intent ran/);
    expectIntentRan(setup.rig.reads().slice(before));
    await setup.rig.close();
  });
});

describe('a changed choice, chip or token, through the real application', () => {
  /** A clarification of the second turn and the choice its first candidate carries. */
  async function clarification(setup: Setup) {
    await earlierTurn(setup);
    const asked = await setup.rig.turn('and what else about it?', [naming('c9'), naming('c9')], { viewElementKeys: VIEW });
    if (asked.body['status'] !== 'clarification') throw new Error(`not a clarification: ${JSON.stringify(asked.body).slice(0, 200)}`);
    const candidates = asked.body['candidates'] as { choice: Record<string, unknown> }[];
    const choice = candidates[0]?.choice;
    if (choice === undefined) throw new Error('no candidate');
    return choice;
  }
  const choiceRequest = (setup: Setup, choice: unknown, over: Record<string, unknown> = {}) => setup.rig.post({ sourceId: 'demo', investigationId: setup.rig.investigationId, viewElementKeys: VIEW, choice, ...over });
  const tampered = (choice: Record<string, unknown>, change: Record<string, unknown>) => ({ ...choice, ...change });

  const CHANGES = [
    ['a changed value', (choice: Record<string, unknown>) => tampered(choice, { entities: { id: 'W-2' } })],
    ['a changed role', (choice: Record<string, unknown>) => tampered(choice, { roles: ['other'] })],
    ['a changed intent', (choice: Record<string, unknown>) => tampered(choice, { intent: 'byId' })],
    ['a changed token', (choice: Record<string, unknown>) => tampered(choice, { choiceToken: `${String(choice['choiceToken']).slice(0, -1)}${String(choice['choiceToken']).endsWith('a') ? 'b' : 'a'}` })],
  ] as const;

  it.each(CHANGES)('refuses %s as an invalid choice, with no model call and no read of the intent', async (_name, change) => {
    const setup = await start();
    const choice = await clarification(setup);
    const before = setup.rig.reads().length;
    const calls = stub.requests.length;
    const refused = await choiceRequest(setup, change(choice));
    expect(refused.body).toMatchObject({ status: 'choice-invalid' });
    expect(stub.requests.length).toBe(calls);
    expectNoIntentRead(setup.rig.reads().slice(before));
    expect(closing(setup.rig).some((event) => JSON.stringify(event.detail).includes('choice-invalid'))).toBe(true);
    await setup.rig.close();
  });

  it('refuses a choice sent under another masking, one sent after its lifetime and one sent for another investigation of the same person, as invalid, reading nothing of the intent', async () => {
    const setup = await start();
    const choice = await clarification(setup);
    const other = await setup.rig.openInvestigation();
    const before = setup.rig.reads().length;
    expect((await choiceRequest(setup, choice, { investigationId: other })).body).toMatchObject({ status: 'choice-invalid' });
    const masked = await choiceRequest(setup, choice, { mask: true });
    expect(masked.body).toMatchObject({ status: 'choice-invalid' });
    setup.clock.now += 16 * MILLISECONDS_A_MINUTE;
    const late = await choiceRequest(setup, choice);
    expect(late.body).toMatchObject({ status: 'choice-invalid' });
    expectNoIntentRead(setup.rig.reads().slice(before));
    await setup.rig.close();
  });

  it('answers 404 for a choice sent by another person and for a source the person cannot read, with no model call', async () => {
    const setup = await start();
    const choice = await clarification(setup);
    const calls = stub.requests.length;
    const before = setup.rig.reads().length;
    setup.person.current = SECOND;
    expect((await choiceRequest(setup, choice)).status).toBe(404);
    setup.person.current = FIRST;
    expect((await choiceRequest(setup, choice, { sourceId: 'elsewhere' })).status).toBe(404);
    expect(stub.requests.length).toBe(calls);
    expectNoIntentRead(setup.rig.reads().slice(before));
    await setup.rig.close();
  });

  it('canary: the same choice, untouched, runs the intent through the gate with no model call, so the check that the intent ran no read fails on it', async () => {
    const setup = await start();
    const choice = await clarification(setup);
    const before = setup.rig.reads().length;
    const calls = stub.requests.length;
    const picked = await choiceRequest(setup, choice);
    expect(picked.body).toMatchObject({ status: 'answered', route: 'ask' });
    expect(stub.requests.length).toBe(calls);
    expect(() => expectNoIntentRead(setup.rig.reads().slice(before))).toThrow(/the intent ran/);
    await setup.rig.close();
  });

  it('refuses a Continue token offered as a choice as an invalid choice, and a choice token offered as a continue as an invalid continue, reading nothing', async () => {
    const setup = await start();
    const heavy = await setup.rig.turn('Show the widgets that share a gadget with W-1', [ASK_SHARED], { viewElementKeys: VIEW });
    const continueToken = ((heavy.body['answer'] as { answered?: { continueToken?: string } } | undefined)?.answered?.continueToken) ?? '';
    expect(continueToken).not.toBe('');
    const choice = await clarification(setup);
    const before = setup.rig.reads().length;
    const asChoice = await choiceRequest(setup, { ...choice, choiceToken: continueToken });
    expect(asChoice.body).toMatchObject({ status: 'choice-invalid' });
    const asContinue = await setup.rig.post({ sourceId: 'demo', investigationId: setup.rig.investigationId, viewElementKeys: VIEW, continue: { intent: 'sharedGadget', entities: { id: 'W-1' }, continueToken: String(choice['choiceToken']) } });
    expect(asContinue.body).toMatchObject({ status: 'continue-invalid' });
    expectNoIntentRead(setup.rig.reads().slice(before));
    await setup.rig.close();
  });
});
