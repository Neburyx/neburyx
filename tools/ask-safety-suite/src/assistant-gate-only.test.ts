import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { plainNode, plainRelationship } from '../../../services/api/src/testing/normalize-fixtures.js';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import { startAssistantRig, type AssistantRig } from './assistant-rig.js';
import { expectEveryReadHasGateEvent, expectOnlyRegisteredReads, SafetyCheckFailed } from './checks.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

const key = (type: string, id: string): string => JSON.stringify(['node', 'demo', type, id]);
const VIEW = [key('widget', 'W-1')];
const ROUTE = JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: 'W-1' } });
const SHARED = JSON.stringify({ route: 'ask', intent: 'sharedGadget', entities: { id: 'W-1' } });
const HEAVY_STEP = JSON.stringify({ tool: 'sharedGadget', values: { id: 'W-1' } });
const NOTES_STEP = JSON.stringify({ tool: 'ai-notes', values: {} });
const DONE = '{"done":true}';
const ANSWER = JSON.stringify({ sentences: [{ text: 'The second read found matches.', cites: ['s2'] }] });
const VIEW_TABLE = JSON.stringify({ table: { columns: ['Element', 'Type'], rows: [{ cells: ['W-1', 'widget'], cites: ['n1'] }] } });
const MESSAGE = 'Show W-1 and the widgets that share a gadget with it';
const REGISTERED = ['entity-load', 'entity-load-many', 'shared-attribute', 'shared-attribute-count'];

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

const widget = (id: string) => plainNode(['Widget'], { widgetId: id }, `4:s:${id}`);
const gadget = plainNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:GT-1');
const source = (call: ExecuteCall): ExecuteOutcome | undefined => {
  if (call.templateId === 'entity-load') return { status: 'rows', rows: [{ n: widget('W-1') }] };
  if (call.templateId === 'shared-attribute-count') return { status: 'rows', rows: [{ matches: 1_000_000, anchorBounded: false, skipped: false }] };
  if (call.templateId !== 'shared-attribute') return undefined;
  const row = (id: string) => ({ a: widget('W-1'), b: widget(id), xs: [gadget], ras: [plainRelationship('MADE_FROM', widget('W-1'), gadget, { linkId: 'L-1' }, '5:s:L-1')], rbs: [plainRelationship('MADE_FROM', widget(id), gadget, { linkId: `L-${id}` }, `5:s:L-${id}`)] });
  return { status: 'rows', rows: [row('W-2'), row('W-3')] };
};
const start = (): Promise<AssistantRig> => startAssistantRig({ stub, respond: source, stores: true, maxSteps: 4 });

/** Every read the source recorded is a registered template and has a gate event of its own trace. */
function expectGateOnly(rig: AssistantRig): void {
  expectOnlyRegisteredReads(rig.reads(), REGISTERED);
  expectEveryReadHasGateEvent(rig.reads(), rig.events());
}

describe('every route of a turn reads only through the gate, through the real application', () => {
  it('is so for the view route, the ask route, the tool loop, the notes tool, a confirmation and a continue', async () => {
    const view = await start();
    expect((await view.turn('What is in view?', [JSON.stringify({ route: 'view', form: 'table' }), VIEW_TABLE], { viewElementKeys: VIEW })).body).toMatchObject({ status: 'answered', route: 'view' });
    expectGateOnly(view);
    await view.close();

    const ask = await start();
    expect((await ask.turn('Show W-1', [ROUTE, DONE])).body).toMatchObject({ status: 'answered', route: 'ask' });
    expectGateOnly(ask);
    await ask.close();

    const loop = await start();
    const asked = await loop.turn('Show W-1 and look further', [ROUTE, JSON.stringify({ tool: 'widgetById', values: { id: 'W-1' } }), DONE, ANSWER]);
    expect(asked.status).toBe(200);
    expectGateOnly(loop);
    await loop.close();

    const notes = await start();
    expect((await notes.turn('Show W-1 and my notes', [ROUTE, NOTES_STEP, DONE, '{"sentences":[]}'])).status).toBe(200);
    expectGateOnly(notes);
    await notes.close();

    const confirm = await start();
    const waiting = (await confirm.turn(MESSAGE, [ROUTE, HEAVY_STEP])).body as { status: string; pendingId: string; plan: string };
    expect(waiting.status).toBe('confirmation');
    const confirmed = await confirm.turn(MESSAGE, [DONE, ANSWER], { confirmation: { pendingId: waiting.pendingId, plan: waiting.plan, decision: 'confirm' } });
    expect(confirmed.body).toMatchObject({ status: 'answered', route: 'ask' });
    expect(confirm.reads().some((read) => read.templateId === 'shared-attribute')).toBe(true);
    expectGateOnly(confirm);
    await confirm.close();

    const heavy = await start();
    const stopped = await heavy.turn('Show the widgets that share a gadget with W-1', [SHARED]);
    const token = ((stopped.body['answer'] as { answered?: { continueToken?: string } } | undefined)?.answered?.continueToken) ?? '';
    expect(token).not.toBe('');
    const continued = await heavy.post({ sourceId: 'demo', investigationId: heavy.investigationId, viewElementKeys: [], continue: { intent: 'sharedGadget', entities: { id: 'W-1' }, continueToken: token } });
    expect(continued.body).toMatchObject({ status: 'answered', route: 'ask' });
    expectGateOnly(heavy);
    await heavy.close();
  });

  it('canary: a read sent straight to the executor during a turn has no gate event, and the check fails on it', async () => {
    const rig = await start();
    await rig.turn('Show W-1', [ROUTE, DONE]);
    expect(() => expectGateOnly(rig)).not.toThrow();
    const known = rig.reads()[0];
    if (known === undefined) throw new Error('no read to copy');
    await rig.executor.execute({ ...known, traceId: 'tr-around-the-gate', signal: new AbortController().signal });
    expect(rig.reads().some((read) => read.traceId === 'tr-around-the-gate')).toBe(true);
    expect(() => expectEveryReadHasGateEvent(rig.reads(), rig.events())).toThrow(SafetyCheckFailed);
    await rig.close();
  });
});
