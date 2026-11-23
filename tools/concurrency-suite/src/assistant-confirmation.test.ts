import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { plainNode, plainRelationship } from '../../../services/api/src/testing/normalize-fixtures.js';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import { startAssistantApp, type AssistantApp } from '../../../services/api/src/testing/assistant-turns.js';
import { startModelStub, type ModelStub } from '../../ask-safety-suite/src/stub.js';

const MESSAGE = 'Show W-1 and the widgets that share a gadget with it';
const ROUTE = JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: 'W-1' } });
const HEAVY_STEP = JSON.stringify({ tool: 'sharedGadget', values: { id: 'W-1' } });
const DONE = '{"done":true}';
const ANSWER = JSON.stringify({ sentences: [{ text: 'The second read found matches.', cites: ['s2'] }] });

const widget = (id: string) => plainNode(['Widget'], { widgetId: id }, `4:s:${id}`);
const gadget = plainNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:GT-1');
const source = (call: ExecuteCall): ExecuteOutcome | undefined => {
  if (call.templateId === 'shared-attribute-count') return { status: 'rows', rows: [{ matches: 1_000_000, anchorBounded: false, skipped: false }] };
  if (call.templateId !== 'shared-attribute') return undefined;
  const row = (id: string) => ({ a: widget('W-1'), b: widget(id), xs: [gadget], ras: [plainRelationship('MADE_FROM', widget('W-1'), gadget, { linkId: 'L-1' }, '5:s:L-1')], rbs: [plainRelationship('MADE_FROM', widget(id), gadget, { linkId: `L-${id}` }, `5:s:L-${id}`)] });
  return { status: 'rows', rows: [row('W-2')] };
};

let model: ModelStub;
let app: AssistantApp;
beforeEach(async () => {
  model = await startModelStub();
  app = await startAssistantApp({ model, respond: source, stores: true });
});
afterEach(async () => {
  await app.close();
  await model.close();
  removeAskFolders();
});

const pages = (): number => app.reads().filter((call) => call.templateId === 'shared-attribute').length;
const waiting = async (): Promise<{ pendingId: string; plan: string }> => {
  model.replies.push(ROUTE, HEAVY_STEP);
  const first = await app.turn(MESSAGE);
  if (first.body['status'] !== 'confirmation') throw new Error('not waiting');
  return first.body as { pendingId: string; plan: string };
};
const decide = (held: { pendingId: string; plan: string }, decision: string) => app.turn(MESSAGE, { confirmation: { pendingId: held.pendingId, plan: held.plan, decision } });

describe('deciding a confirmation of a heavy step at the same time', () => {
  it('runs a plan sent twice at once exactly once, and tells the other it is no longer valid', async () => {
    const held = await waiting();
    model.reset();
    model.replies.push(DONE, ANSWER, DONE, ANSWER);
    const [one, two] = await Promise.all([decide(held, 'confirm'), decide(held, 'confirm')]);
    expect([one.body['status'], two.body['status']].sort()).toEqual(['answered', 'confirmation-invalid']);
    expect(pages()).toBe(1);
  });

  it('keeps one waiting confirmation for a person: a second one replaces the first, which can then not be decided', async () => {
    const first = await waiting();
    const second = await waiting();
    expect((await decide(first, 'confirm')).body).toMatchObject({ status: 'confirmation-invalid' });
    expect(pages()).toBe(0);
    model.replies.push(DONE, ANSWER);
    expect((await decide(second, 'confirm')).body).toMatchObject({ status: 'answered' });
    expect(pages()).toBe(1);
  });

  it('audits a confirmation that waits as one event, with the tool and no value', async () => {
    const mine = await waiting();
    expect(typeof mine.pendingId).toBe('string');
    const events = app.events().filter((event) => event.action === 'assistant.confirmation').map((event) => (event.detail as { turn: { cause: string } }).turn.cause);
    expect(events).toEqual(['shown']);
    expect(JSON.stringify(app.events().filter((event) => event.action === 'assistant.confirmation'))).not.toMatch(/W-1|Show W-1/);
  });
});
