import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { plainNode, plainRelationship } from '../../../services/api/src/testing/normalize-fixtures.js';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import { startAssistantRig } from './assistant-rig.js';
import { SafetyCheckFailed } from './checks.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

const ROUTE = JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: 'W-1' } });
const ANSWER = JSON.stringify({ sentences: [{ text: 'The widget W-1 was read.', cites: ['r1'] }] });
const widgetNode = { $type: 'node', elementId: '4:s:W-1', labels: ['Widget'], properties: { widgetId: 'W-1' } };
let asked = 0;

/** A model that keeps asking for another read, whatever it is asked, and answers when it is asked for the answer. */
const hungry = (body: string): string => {
  if (body.includes('Instructions for answering from the view')) return ANSWER;
  if (body.includes('"content":"Message:')) return ROUTE;
  asked += 1;
  return JSON.stringify({ tool: 'widgetById', values: { id: `W-${asked + 1}` } });
};

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub(hungry);
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Turn {
  readonly body: Record<string, unknown>;
  /** The reads of the intent the turn made. */
  readonly reads: number;
  /** The calls to the provider the turn made. */
  readonly calls: number;
  readonly events: { action: string; detail?: unknown }[];
}

async function turnWith(options: { maxSteps?: number; maxCalls?: number; settings?: Record<string, string>; delayMs?: number }): Promise<Turn> {
  asked = 0;
  const rig = await startAssistantRig({
    stub,
    maxSteps: options.maxSteps ?? 8,
    ...(options.maxCalls === undefined ? { maxCalls: 10 } : { maxCalls: options.maxCalls }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    respond: (call: ExecuteCall): Promise<ExecuteOutcome> | undefined => {
      if (call.templateId !== 'entity-load') return undefined;
      return sleep(options.delayMs ?? 0).then((): ExecuteOutcome => ({ status: 'rows', rows: [{ n: widgetNode }] }));
    },
  });
  const before = rig.reads().length;
  const answer = await rig.turn('Show W-1 and keep looking', []);
  const turn: Turn = { body: answer.body, reads: rig.reads().slice(before).filter((read) => read.templateId === 'entity-load').length, calls: stub.requests.length, events: rig.events() };
  await rig.close();
  return turn;
}

const expectAtMost = (what: string, value: number, limit: number): void => {
  if (value > limit) throw new SafetyCheckFailed(`${what} ${value} is over the limit ${limit}`);
};
const closingCause = (turn: Turn): string | undefined => {
  const event = turn.events.find((entry) => entry.action === 'assistant.turn.closed');
  return ((event?.detail as { turn?: { cause?: string } } | undefined)?.turn?.cause);
};

describe('a turn that would run past a limit is stopped, through the real application', () => {
  it('stops at the steps setting: no more reads than steps, the answer is over what was read, and the closing event names the limit', async () => {
    const turn = await turnWith({ maxSteps: 2 });
    expectAtMost('reads', turn.reads, 2);
    expect(turn.body).toMatchObject({ status: 'answered', stoppedAt: 'steps' });
    expect(closingCause(turn)).toBe('limit-steps');
  });

  it('stops at the calls setting: no more calls to the provider than calls', async () => {
    const turn = await turnWith({ maxCalls: 3 });
    expectAtMost('calls', turn.calls, 3);
    expect(turn.body).toMatchObject({ status: 'answered', stoppedAt: 'calls' });
    expect(closingCause(turn)).toBe('limit-calls');
  });

  it('stops at the rows setting: once the reads hold the rows allowed, no further read is made', async () => {
    const turn = await turnWith({ settings: { NEBURYX_ASSISTANT_MAX_ROWS: '1' } });
    expectAtMost('reads', turn.reads, 1);
    expect(turn.body).toMatchObject({ status: 'answered', stoppedAt: 'rows' });
    expect(closingCause(turn)).toBe('limit-rows');
  });

  it('stops at the time of the turn: the reads that were slow leave fewer reads than steps, and the answer is over what was read', async () => {
    const turn = await turnWith({ delayMs: 450, settings: { NEBURYX_ASSISTANT_TOTAL_TIMEOUT_MS: '1000', NEBURYX_ASSISTANT_TIMEOUT_MS: '1000' } });
    expectAtMost('reads', turn.reads, 4);
    expect(turn.body).toMatchObject({ status: 'limit', limit: 'time' });
    expect(closingCause(turn)).toBe('limit-time');
  });

  it('stops before the call that would pass the input guard: nothing is sent, and the turn is refused as too large', async () => {
    const turn = await turnWith({ settings: { NEBURYX_ASSISTANT_MAX_INPUT_TOKENS: '1' } });
    expectAtMost('calls', turn.calls, 0);
    expect(turn.body).toMatchObject({ status: 'too-large' });
    expect(closingCause(turn)).toBe('too-large');
  });

  it('canary: with the limit raised the same turn goes past it, so each assertion above fails', async () => {
    const steps = await turnWith({ maxSteps: 6 });
    expect(() => expectAtMost('reads', steps.reads, 2)).toThrow(SafetyCheckFailed);
    const calls = await turnWith({ maxCalls: 9 });
    expect(() => expectAtMost('calls', calls.calls, 3)).toThrow(SafetyCheckFailed);
    const rows = await turnWith({ settings: { NEBURYX_ASSISTANT_MAX_ROWS: '100' } });
    expect(() => expectAtMost('reads', rows.reads, 1)).toThrow(SafetyCheckFailed);
    const time = await turnWith({ delayMs: 450, settings: { NEBURYX_ASSISTANT_TOTAL_TIMEOUT_MS: '60000', NEBURYX_ASSISTANT_TIMEOUT_MS: '60000' } });
    expect(time.body['limit']).not.toBe('time');
    const input = await turnWith({ settings: { NEBURYX_ASSISTANT_MAX_INPUT_TOKENS: '100000' } });
    expect(() => expectAtMost('calls', input.calls, 0)).toThrow(SafetyCheckFailed);
  }, 60_000);
});

describe('the turns that start without a typed message are bound too, through the real application', () => {
  const widget = (id: string) => plainNode(['Widget'], { widgetId: id }, `4:s:${id}`);
  const gadget = plainNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:GT-1');
  const SHARED = JSON.stringify({ route: 'ask', intent: 'sharedGadget', entities: { id: 'W-1' } });
  const HEAVY_STEP = JSON.stringify({ tool: 'sharedGadget', values: { id: 'W-1' } });
  const source = (call: ExecuteCall): ExecuteOutcome | undefined => {
    if (call.templateId === 'entity-load') return { status: 'rows', rows: [{ n: widget('W-1') }] };
    if (call.templateId === 'shared-attribute-count') return { status: 'rows', rows: [{ matches: 1_000_000, anchorBounded: false, skipped: false }] };
    if (call.templateId !== 'shared-attribute') return undefined;
    const row = (id: string) => ({ a: widget('W-1'), b: widget(id), xs: [gadget], ras: [plainRelationship('MADE_FROM', widget('W-1'), gadget, { linkId: 'L-1' }, '5:s:L-1')], rbs: [plainRelationship('MADE_FROM', widget(id), gadget, { linkId: `L-${id}` }, `5:s:L-${id}`)] });
    return { status: 'rows', rows: [row('W-2'), row('W-3')] };
  };
  const pages = (rig: Awaited<ReturnType<typeof startAssistantRig>>): number => rig.reads().filter((call) => call.templateId === 'shared-attribute').length;
  const TIGHT = { NEBURYX_ASSISTANT_MAX_ROWS: '1', NEBURYX_ASSISTANT_TOTAL_TIMEOUT_MS: '1000', NEBURYX_ASSISTANT_TIMEOUT_MS: '1000' };

  it('makes exactly one read and no model call for a continue, whatever the settings of the loop say', async () => {
    const plain = await startModelStub();
    const rig = await startAssistantRig({ stub: plain, respond: source, settings: TIGHT });
    const heavy = await rig.turn('Show the widgets that share a gadget with W-1', [SHARED]);
    const token = ((heavy.body['answer'] as { answered?: { continueToken?: string } } | undefined)?.answered?.continueToken) ?? '';
    expect(pages(rig)).toBe(0);
    const calls = plain.requests.length;
    const continued = await rig.post({ sourceId: 'demo', investigationId: rig.investigationId, viewElementKeys: [], continue: { intent: 'sharedGadget', entities: { id: 'W-1' }, continueToken: token } });
    expect(continued.body).toMatchObject({ status: 'answered', route: 'ask' });
    expect(pages(rig)).toBe(1);
    expect(plain.requests.length).toBe(calls);
    await rig.close();
    await plain.close();
  });

  it('makes exactly one read and no model call for a pressed follow-up, whatever the settings of the loop say', async () => {
    const plain = await startModelStub();
    const rig = await startAssistantRig({ stub: plain, respond: (call) => (call.templateId === 'shared-attribute-count' ? { status: 'rows', rows: [{ matches: 2, anchorBounded: false, skipped: false }] } : source(call)), settings: TIGHT, threads: true, maxSteps: 1, principalId: () => '0192f000-0000-7000-8000-000000000001' });
    const first = await rig.turn('Show W-1', [JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: 'W-1' } })]);
    const chip = ((first.body['followUps'] as { choice: unknown }[] | undefined) ?? [])[0]?.choice;
    expect(chip).toBeDefined();
    await rig.threadWritten(1);
    const calls = plain.requests.length;
    const before = rig.reads().length;
    const pressed = await rig.post({ sourceId: 'demo', investigationId: rig.investigationId, viewElementKeys: [], choice: chip });
    expect(pressed.body).toMatchObject({ status: 'answered', route: 'ask' });
    expect(plain.requests.length).toBe(calls);
    expect(pages(rig)).toBe(1);
    expect(rig.reads().slice(before).filter((call) => call.templateId === 'shared-attribute')).toHaveLength(1);
    await rig.close();
    await plain.close();
  });

  it('keeps a confirmed step inside the calls setting: the model calls of the turn and of its confirmation together never pass it', async () => {
    const plain = await startModelStub();
    const rig = await startAssistantRig({ stub: plain, respond: source, stores: true, maxSteps: 4, maxCalls: 3 });
    const message = 'Show W-1 and the widgets that share a gadget with it';
    const waiting = (await rig.turn(message, [ROUTE, HEAVY_STEP])).body as { status: string; pendingId: string; plan: string };
    expect(waiting.status).toBe('confirmation');
    const confirmed = await rig.turn(message, ['{"tool":"widgetById","values":{"id":"W-9"}}', '{"tool":"widgetById","values":{"id":"W-8"}}', ANSWER], { confirmation: { pendingId: waiting.pendingId, plan: waiting.plan, decision: 'confirm' } });
    expect(confirmed.status).toBe(200);
    expectAtMost('calls', plain.requests.length, 3);
    await rig.close();
    await plain.close();
  });

  it('canary: a loop with a higher calls setting makes more calls than that, so the check on the confirmed step could fail', async () => {
    const plain = await startModelStub();
    const rig = await startAssistantRig({ stub: plain, respond: source, stores: true, maxSteps: 4, maxCalls: 8 });
    const message = 'Show W-1 and the widgets that share a gadget with it';
    const waiting = (await rig.turn(message, [ROUTE, HEAVY_STEP])).body as { status: string; pendingId: string; plan: string };
    await rig.turn(message, ['{"tool":"widgetById","values":{"id":"W-9"}}', '{"tool":"widgetById","values":{"id":"W-8"}}', ANSWER], { confirmation: { pendingId: waiting.pendingId, plan: waiting.plan, decision: 'confirm' } });
    expect(() => expectAtMost('calls', plain.requests.length, 3)).toThrow(SafetyCheckFailed);
    await rig.close();
    await plain.close();
  });
});

describe('the number of earlier turns the router is shown is the setting, through the real application', () => {
  const countOfEarlier = (plain: ModelStub): number => {
    const body = JSON.parse(plain.requests.at(-1) ?? '{}') as { messages?: { content?: unknown }[] };
    const text = body.messages?.map((entry) => (typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content))).join('\n') ?? '';
    return (text.match(/ask "widgetById"/g) ?? []).length;
  };
  const earlierTurns = async (turns: number, contextTurns: string) => {
    const plain = await startModelStub();
    const rig = await startAssistantRig({ stub: plain, threads: true, settings: { NEBURYX_ASSISTANT_CONTEXT_TURNS: contextTurns }, respond: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode }] } : undefined) });
    for (let at = 1; at <= turns; at += 1) {
      await rig.turn(`Show W-${at}`, [JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: `W-${at}` } }), '{"done":true}']);
      await rig.threadWritten(at);
    }
    await rig.turn('and what else about it?', ['{"route":"refuse","cause":"unplaced"}']);
    const count = countOfEarlier(plain);
    await rig.close();
    await plain.close();
    return count;
  };

  it('shows the router at most the number of earlier turns the setting names, and a higher setting shows more, so the check can fail', async () => {
    const limited = await earlierTurns(3, '1');
    expectAtMost('earlier turns', limited, 1);
    expect(limited).toBeGreaterThan(0);
    const wider = await earlierTurns(3, '3');
    expect(() => expectAtMost('earlier turns', wider, 1)).toThrow(SafetyCheckFailed);
  });
});
