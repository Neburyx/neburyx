import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { widget } from '../../../services/api/src/testing/search-app.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import { HOLD, startAssistantApp, startTurnModel, type AssistantApp, type TurnModel } from '../../../services/api/src/testing/assistant-turns.js';
import { expectNothingStartedSince, type Started } from './assistant-checks.js';
import { until } from './rig.js';

const ROUTE = JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: 'W-1' } });
const NEXT = JSON.stringify({ tool: 'widgetById', values: { id: 'W-2' } });
const DONE = '{"done":true}';
const QUIET_MS = 300;

let model: TurnModel;
let app: AssistantApp;
/** The reads of W-2 that are pending at the source: the tool step's read, held until the turn is cancelled. */
let held: ExecuteCall[];

const respond = (call: ExecuteCall): Promise<ExecuteOutcome> | undefined => {
  if (call.templateId !== 'entity-load' || call.parameters['stableId'] !== 'W-2') return call.templateId === 'entity-load' ? Promise.resolve(entityRows(widget(1))) : undefined;
  held.push(call);
  return new Promise<ExecuteOutcome>((resolve) => call.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
};

beforeEach(async () => {
  held = [];
  model = await startTurnModel();
  app = await startAssistantApp({ model, respond });
});
afterEach(async () => {
  await app.close();
  await model.close();
  removeAskFolders();
});

const started = (): Started => ({ reads: app.reads().length, modelCalls: model.requests.length });
const saved = (): string => JSON.stringify({ investigations: app.store.investigations, drafts: app.store.drafts });
const closing = () => app.events().filter((event) => event.action === 'assistant.turn.closed');
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

describe('cancelling an assistant turn during a tool step', () => {
  it('aborts the read of the step, starts no further read or call, closes the turn once as cancelled, and leaves what the person has as it was', async () => {
    const before = saved();
    model.replies.push(ROUTE, NEXT, DONE);
    const controller = new AbortController();
    const sent = app.sendTurn('Show W-1 and W-2', controller.signal);
    await until(() => held.length > 0, 'the read of the step to be pending');
    const atCancel = started();
    controller.abort();
    await sent;
    await until(() => held.every((call) => call.signal?.aborted === true), 'the read to be aborted');
    await pause();
    expectNothingStartedSince(atCancel, started());
    expect(model.requests).toHaveLength(2);
    expect(closing()).toMatchObject([{ result: 'failed', detail: { turn: { outcome: 'cancelled' } } }]);
    expect(saved()).toBe(before);
  });

  it('starts no read when the person cancels while the call that chooses the step is pending, even when the model answers afterwards', async () => {
    const before = saved();
    model.replies.push(ROUTE, HOLD);
    const controller = new AbortController();
    const sent = app.sendTurn('Show W-1 and W-2', controller.signal);
    await until(() => model.held() > 0, 'the step call to be pending');
    const atCancel = started();
    controller.abort();
    await sent;
    await until(() => model.held() === 0, 'the held call to be given up by the application');
    model.release(NEXT);
    await pause();
    expectNothingStartedSince(atCancel, started());
    expect(held).toHaveLength(0);
    expect(closing()).toMatchObject([{ detail: { turn: { outcome: 'cancelled' } } }]);
    expect(saved()).toBe(before);
  });

  it('makes no further call when the person cancels while the answer after the steps is pending', async () => {
    const before = saved();
    model.replies.push(ROUTE, JSON.stringify({ tool: 'byId', values: { id: 'W-1' } }), DONE, HOLD);
    const controller = new AbortController();
    const sent = app.sendTurn('Show W-1 twice', controller.signal);
    await until(() => model.held() > 0, 'the answer call to be pending');
    const atCancel = started();
    controller.abort();
    await sent;
    await until(() => model.held() === 0, 'the held call to be given up by the application');
    model.release('{"sentences":[]}');
    await pause();
    expectNothingStartedSince(atCancel, started());
    expect(model.requests).toHaveLength(4);
    expect(closing()).toMatchObject([{ detail: { turn: { outcome: 'cancelled' } } }]);
    expect(saved()).toBe(before);
  });
});

describe('cancelling the decision on a heavy step of the loop', () => {
  const MESSAGE = 'Show W-1 and the widgets that share a gadget with it';
  const HEAVY_STEP = JSON.stringify({ tool: 'sharedGadget', values: { id: 'W-1' } });
  let pausing = false;
  let replayed: ExecuteCall[];
  let local: AssistantApp;
  let localModel: TurnModel;

  const sourceOf = (call: ExecuteCall): Promise<ExecuteOutcome> | ExecuteOutcome | undefined => {
    if (call.templateId === 'shared-attribute-count') return { status: 'rows', rows: [{ matches: 1_000_000, anchorBounded: false, skipped: false }] };
    if (call.templateId === 'entity-load' && pausing) {
      replayed.push(call);
      return new Promise<ExecuteOutcome>((resolve) => call.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
    }
    return undefined;
  };

  beforeEach(async () => {
    pausing = false;
    replayed = [];
    localModel = await startTurnModel();
    local = await startAssistantApp({ model: localModel, respond: sourceOf, stores: true });
  });
  afterEach(async () => {
    await local.close();
    await localModel.close();
  });

  const waiting = async (): Promise<{ pendingId: string; plan: string }> => {
    localModel.replies.push(ROUTE, HEAVY_STEP);
    const first = await local.turn(MESSAGE);
    if (first.body['status'] !== 'confirmation') throw new Error('not waiting');
    return first.body as { pendingId: string; plan: string };
  };
  const decision = (held: { pendingId: string; plan: string }, decide: string) => ({ message: MESSAGE, confirmation: { pendingId: held.pendingId, plan: held.plan, decision: decide } });
  const closings = () => local.events().filter((event) => event.action === 'assistant.turn.closed').map((event) => (event.detail as { turn: { outcome: string } }).turn.outcome);

  it('starts no further read or call when the person cancels while the earlier reads are read again, closes that turn as cancelled, and the plan cannot be used again', async () => {
    const held = await waiting();
    pausing = true;
    const controller = new AbortController();
    const sent = local.sendTurn(MESSAGE, controller.signal, { confirmation: decision(held, 'confirm').confirmation });
    await until(() => replayed.length > 0, 'the read that is made again to be pending');
    const readsAtCancel = local.reads().length;
    const callsAtCancel = localModel.requests.length;
    controller.abort();
    await sent;
    await until(() => replayed.every((call) => call.signal?.aborted === true), 'the read to be aborted');
    await pause();
    expect(local.reads().length).toBe(readsAtCancel);
    expect(localModel.requests.length).toBe(callsAtCancel);
    expect(closings()).toEqual(['confirmation', 'cancelled']);
    pausing = false;
    expect((await local.turn(MESSAGE, decision(held, 'confirm'))).body).toMatchObject({ status: 'confirmation-invalid' });
    expect(local.reads().filter((call) => call.templateId === 'shared-attribute')).toHaveLength(0);
  });

  it('drops the confirmation when the person cancels it, reads nothing, and closes the turn as cancelled', async () => {
    const held = await waiting();
    const readsBefore = local.reads().length;
    expect((await local.turn(MESSAGE, decision(held, 'cancel'))).body).toEqual({ status: 'cancelled' });
    expect(local.reads().length).toBe(readsBefore);
    expect(closings()).toEqual(['confirmation', 'cancelled']);
    expect((await local.turn(MESSAGE, decision(held, 'confirm'))).body).toMatchObject({ status: 'confirmation-invalid' });
  });
});
