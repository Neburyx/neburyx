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
const NDJSON = { accept: 'application/x-ndjson' };

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

/** Reads the lines of a streamed response until a test is satisfied or the stream ends; the lines read so far are returned. */
async function readUntil(response: Response | undefined, enough: (lines: Record<string, unknown>[]) => boolean): Promise<Record<string, unknown>[]> {
  const reader = response?.body?.getReader();
  const decoder = new TextDecoder();
  const lines: Record<string, unknown>[] = [];
  let rest = '';
  while (reader !== undefined) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += decoder.decode(chunk.value, { stream: true });
    const parts = rest.split('\n');
    rest = parts.pop() ?? '';
    for (const part of parts) if (part !== '') lines.push(JSON.parse(part) as Record<string, unknown>);
    if (enough(lines)) break;
  }
  return lines;
}
const steps = (lines: Record<string, unknown>[]): unknown[] => lines.filter((line) => line['event'] === 'step').map((line) => line['phase']);

describe('closing the stream of an assistant turn is the cancel of the turn', () => {
  it('aborts the read of the step, starts no further read or call, closes the turn once as cancelled, logs no handler failure and leaves what the person has as it was', async () => {
    const before = saved();
    model.replies.push(ROUTE, NEXT, DONE);
    const controller = new AbortController();
    const response = await app.sendTurn('Show W-1 and W-2', controller.signal, {}, NDJSON);
    expect(response?.headers.get('content-type')).toBe('application/x-ndjson');
    const lines = await readUntil(response, (seen) => steps(seen).filter((phase) => phase === 'reading').length >= 2);
    expect(steps(lines)).toEqual(['routing', 'reading', 'read-done', 'reading']);
    await until(() => held.length > 0, 'the read of the step to be pending');
    const atCancel = started();
    controller.abort();
    await until(() => held.every((call) => call.signal?.aborted === true), 'the read to be aborted');
    await pause();
    expectNothingStartedSince(atCancel, started());
    expect(model.requests).toHaveLength(2);
    expect(closing()).toMatchObject([{ result: 'failed', detail: { turn: { outcome: 'cancelled' } } }]);
    expect(app.logs.join('\n')).not.toContain('extension.handler_failed');
    expect(saved()).toBe(before);
  });

  it('starts no read when the stream is closed while the call that chooses the step is pending, even when the model answers afterwards', async () => {
    const before = saved();
    model.replies.push(ROUTE, HOLD);
    const controller = new AbortController();
    const response = await app.sendTurn('Show W-1 and W-2', controller.signal, {}, NDJSON);
    await readUntil(response, (seen) => steps(seen).includes('reading'));
    await until(() => model.held() > 0, 'the step call to be pending');
    const atCancel = started();
    controller.abort();
    await until(() => model.held() === 0, 'the held call to be given up by the application');
    model.release(NEXT);
    await pause();
    expectNothingStartedSince(atCancel, started());
    expect(held).toHaveLength(0);
    expect(closing()).toMatchObject([{ detail: { turn: { outcome: 'cancelled' } } }]);
    expect(saved()).toBe(before);
  });

  it('makes no further call when the stream is closed while the answer after the steps is pending', async () => {
    const before = saved();
    model.replies.push(ROUTE, JSON.stringify({ tool: 'byId', values: { id: 'W-1' } }), DONE, HOLD);
    const controller = new AbortController();
    const response = await app.sendTurn('Show W-1 twice', controller.signal, {}, NDJSON);
    await readUntil(response, (seen) => steps(seen).includes('answering'));
    await until(() => model.held() > 0, 'the answer call to be pending');
    const atCancel = started();
    controller.abort();
    await until(() => model.held() === 0, 'the held call to be given up by the application');
    model.release('{"sentences":[]}');
    await pause();
    expectNothingStartedSince(atCancel, started());
    expect(model.requests).toHaveLength(4);
    expect(closing()).toMatchObject([{ detail: { turn: { outcome: 'cancelled' } } }]);
    expect(saved()).toBe(before);
  });

  it('makes no further call when the stream is closed while the overview beside a verdict refusal is pending, and leaves what the person has as it was', async () => {
    const before = saved();
    model.replies.push(JSON.stringify({ route: 'refuse', cause: 'verdict' }), HOLD);
    const controller = new AbortController();
    const response = await app.sendTurn('Is this customer laundering money?', controller.signal, { viewElementKeys: [JSON.stringify(['node', 'demo', 'widget', 'W-1']), JSON.stringify(['edge', 'demo', 'stored', 'MADE_FROM', 'widget', 'gadget', 'L-1'])] }, NDJSON);
    await readUntil(response, (seen) => steps(seen).includes('answering'));
    await until(() => model.held() > 0, 'the overview call to be pending');
    const atCancel = started();
    controller.abort();
    await until(() => model.held() === 0, 'the held call to be given up by the application');
    model.release('{"sentences":[]}');
    await pause();
    expectNothingStartedSince(atCancel, started());
    expect(model.requests).toHaveLength(2);
    expect(closing()).toMatchObject([{ detail: { turn: { outcome: 'cancelled' } } }]);
    expect(saved()).toBe(before);
  });

  it('closes the turn as cancelled when the stream is closed before its first line, and a later turn on the same application is read as usual', async () => {
    model.replies.push(HOLD);
    const controller = new AbortController();
    const sent = app.sendTurn('Show W-1', controller.signal, {}, NDJSON);
    await until(() => model.held() > 0, 'the router call to be pending');
    controller.abort();
    await sent;
    await until(() => model.held() === 0, 'the held call to be given up by the application');
    await pause();
    expect(closing()).toMatchObject([{ detail: { turn: { outcome: 'cancelled' } } }]);
    model.replies.push(ROUTE, DONE);
    const next = new AbortController();
    const response = await app.sendTurn('Show W-1', next.signal, {}, NDJSON);
    const lines = await readUntil(response, () => false);
    expect(lines.at(-1)).toMatchObject({ event: 'answer' });
  });

  it('leaves the turn as answered when the stream is closed after its last line', async () => {
    model.replies.push(ROUTE, DONE);
    const controller = new AbortController();
    const response = await app.sendTurn('Show W-1', controller.signal, {}, NDJSON);
    const lines = await readUntil(response, (seen) => seen.some((line) => line['event'] === 'answer'));
    expect(lines.at(-1)).toMatchObject({ event: 'answer' });
    expect(steps(lines).slice(0, 2)).toEqual(['routing', 'reading']);
    controller.abort();
    await pause();
    expect(closing()).toMatchObject([{ detail: { turn: { outcome: 'answered' } } }]);
    expect(app.logs.join('\n')).not.toContain('extension.handler_failed');
  });
});
