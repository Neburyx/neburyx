import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { plainNode, plainRelationship } from '../../../services/api/src/testing/normalize-fixtures.js';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import { startAssistantRig, type AssistantRig } from './assistant-rig.js';
import { startModelStub, type ModelStub } from './stub.js';

const ROUTE = JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: 'W-1' } });
const HEAVY_STEP = JSON.stringify({ tool: 'sharedGadget', values: { id: 'W-1' } });
const DONE = '{"done":true}';
const ANSWER = JSON.stringify({ sentences: [{ text: 'The second read found matches.', cites: ['s2'] }] });
const MESSAGE = 'Show W-1 and the widgets that share a gadget with it';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

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
  if (call.templateId === 'shared-attribute-count') return { status: 'rows', rows: [{ matches: 1_000_000, anchorBounded: false, skipped: false }] };
  if (call.templateId !== 'shared-attribute') return undefined;
  const row = (id: string) => ({ a: widget('W-1'), b: widget(id), xs: [gadget], ras: [plainRelationship('MADE_FROM', widget('W-1'), gadget, { linkId: 'L-1' }, '5:s:L-1')], rbs: [plainRelationship('MADE_FROM', widget(id), gadget, { linkId: `L-${id}` }, `5:s:L-${id}`)] });
  return { status: 'rows', rows: [row('W-2'), row('W-3')] };
};
const pagesOf = (rig: AssistantRig): number => rig.reads().filter((call) => call.templateId === 'shared-attribute').length;

async function waitingTurn(rig: AssistantRig, replies: readonly string[] = [ROUTE, HEAVY_STEP]) {
  const answer = await rig.turn(MESSAGE, replies);
  if (answer.body['status'] !== 'confirmation') throw new Error(`not waiting: ${JSON.stringify(answer.body).slice(0, 160)}`);
  return answer.body as { pendingId: string; plan: string };
}

const decide = (rig: AssistantRig, waiting: { pendingId: string; plan: string }, decision: 'confirm' | 'skip' | 'cancel', replies: readonly string[]) =>
  rig.turn(MESSAGE, replies, { confirmation: { pendingId: waiting.pendingId, plan: waiting.plan, decision } });

describe('a heavy step of the loop runs only after the analyst confirms', () => {
  it('reads no page of the step before a decision, and no answer of the turn holds a token to read it by', async () => {
    const rig = await startAssistantRig({ stub, respond: source, stores: true });
    const waiting = await waitingTurn(rig);
    expect(pagesOf(rig)).toBe(0);
    expect(JSON.stringify(waiting)).not.toMatch(/continueToken|"result"/);
    expect(await decide(rig, waiting, 'cancel', [])).toMatchObject({ body: { status: 'cancelled' } });
    expect(pagesOf(rig)).toBe(0);
    await rig.close();
  });

  it('reads exactly one page after Confirm, and refuses the same plan again with nothing read', async () => {
    const rig = await startAssistantRig({ stub, respond: source, stores: true });
    const waiting = await waitingTurn(rig);
    const confirmed = await decide(rig, waiting, 'confirm', [DONE, ANSWER]);
    expect(confirmed.body).toMatchObject({ status: 'answered', route: 'ask' });
    expect(pagesOf(rig)).toBe(1);
    for (const decision of ['confirm', 'skip', 'cancel'] as const) expect((await decide(rig, waiting, decision, [])).body).toMatchObject({ status: 'confirmation-invalid' });
    expect(pagesOf(rig)).toBe(1);
    expect(JSON.stringify(confirmed.body)).not.toMatch(/continueToken/);
    await rig.close();
  });

  it('reads nothing of the step after Skip, and the plan cannot then be confirmed', async () => {
    const rig = await startAssistantRig({ stub, respond: source, stores: true });
    const waiting = await waitingTurn(rig);
    expect((await decide(rig, waiting, 'skip', [DONE, ANSWER])).body).toMatchObject({ status: 'answered', route: 'ask' });
    expect(pagesOf(rig)).toBe(0);
    expect((await decide(rig, waiting, 'confirm', [])).body).toMatchObject({ status: 'confirmation-invalid' });
    expect(pagesOf(rig)).toBe(0);
    await rig.close();
  });

  it('never lifts a limit: a turn that may make two reads makes no third, whatever the model asks for after the confirmation', async () => {
    const rig = await startAssistantRig({ stub, respond: source, maxSteps: 2, stores: true });
    const waiting = await waitingTurn(rig);
    const reads = rig.reads().length;
    const confirmed = await decide(rig, waiting, 'confirm', [JSON.stringify({ tool: 'widgetById', values: { id: 'W-9' } }), ANSWER]);
    expect(confirmed.body).toMatchObject({ status: 'answered', stoppedAt: 'steps' });
    expect(pagesOf(rig)).toBe(1);
    expect(rig.reads().filter((call) => call.templateId === 'entity-load').length).toBeLessThanOrEqual(reads);
    await rig.close();
  });

  it('is refused for a plan another person sends, a plan whose message was changed, and a plan altered, each with nothing read', async () => {
    const rig = await startAssistantRig({ stub, respond: source, stores: true });
    const waiting = await waitingTurn(rig);
    const changed = await rig.turn('another message', [], { confirmation: { pendingId: waiting.pendingId, plan: waiting.plan, decision: 'confirm' } });
    expect(changed.body).toMatchObject({ status: 'confirmation-invalid' });
    const [expiry = '', payload = '', signature = ''] = waiting.plan.split('.');
    const altered = `${expiry}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), wait: { tool: 'byId', values: { id: 'W-1' } } })).toString('base64url')}.${signature}`;
    expect((await decide(rig, { ...waiting, plan: altered }, 'confirm', [])).body).toMatchObject({ status: 'confirmation-invalid' });
    expect(pagesOf(rig)).toBe(0);
    await rig.close();
  });
});

describe('what a confirmation holds', () => {
  const OWNER = 'SECRET-OWNER-NAME';
  const withRows = (call: ExecuteCall): ExecuteOutcome | undefined => {
    if (call.templateId === 'entity-load') return { status: 'rows', rows: [{ n: plainNode(['Widget'], { widgetId: 'W-1', ownerName: OWNER }, '4:s:W-1') }] };
    return source(call);
  };

  it('holds, for a masked turn, the tools and values the gate accepted, the counters and two hashes, and no row content; and is valid only under that masking', async () => {
    const rig = await startAssistantRig({ stub, respond: withRows, stores: true });
    const answer = await rig.turn(MESSAGE, [ROUTE, HEAVY_STEP], { mask: true });
    if (answer.body['status'] !== 'confirmation') throw new Error('not waiting');
    const held = answer.body as { pendingId: string; plan: string };
    const [, payload = ''] = held.plan.split('.');
    const plan = Buffer.from(payload, 'base64url').toString('utf8');
    expect(Object.keys(JSON.parse(plan) as object).filter((key) => key !== 'runId').sort()).toEqual(['counters', 'fromView', 'messageHash', 'steps', 'viewHash', 'wait']);
    expect(plan).not.toContain(OWNER);
    expect(JSON.stringify(answer.body)).not.toContain(OWNER);
    // a plan made for a masked turn is no plan for an unmasked one
    expect((await rig.turn(MESSAGE, [], { confirmation: { pendingId: held.pendingId, plan: held.plan, decision: 'confirm' } })).body).toMatchObject({ status: 'confirmation-invalid' });
    expect((await rig.turn(MESSAGE, [DONE, ANSWER], { mask: true, confirmation: { pendingId: held.pendingId, plan: held.plan, decision: 'confirm' } })).body).toMatchObject({ status: 'answered' });
    await rig.close();
  });

  it('shows a value the model gave a step as Ask shows it, because the gate accepted it as a parameter, and it reaches the source as a parameter only, never inside a statement', async () => {
    const hostile = 'x; MATCH (n) DETACH DELETE n';
    const rig = await startAssistantRig({ stub, respond: withRows, stores: true });
    const answer = await rig.turn(MESSAGE, [ROUTE, JSON.stringify({ tool: 'sharedGadget', values: { id: hostile } })]);
    expect(answer.body['status']).toBe('confirmation');
    const step = (answer.body as { step: { subject?: string } }).step;
    expect(step.subject).toBe(hostile);
    expect(rig.reads().every((call) => !call.cypher.includes('DETACH'))).toBe(true);
    expect(rig.reads().some((call) => Object.values(call.parameters).includes(hostile))).toBe(true);
    await rig.close();
  });
});

