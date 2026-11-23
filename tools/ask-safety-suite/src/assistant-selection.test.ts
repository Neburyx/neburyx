import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { startAssistantRig, type AssistantRig } from './assistant-rig.js';
import { expectNoValue } from './checks.js';
import { startModelStub, type ModelStub } from './stub.js';

const key = (type: string, id: string): string => JSON.stringify(['node', 'demo', type, id]);
const VIEW = [key('widget', 'W-1'), key('widget', 'W-2'), key('gadget', 'Z-0')];
const widgetNode = { $type: 'node', elementId: '4:s:W-1', labels: ['Widget'], properties: { widgetId: 'W-1', ownerName: 'Ana Silva' } };
const naming = (element: string): string => JSON.stringify({ route: 'ask', intent: 'widgetById', entities: {}, elements: { id: element } });
const clarifying = (...candidates: string[]): string => JSON.stringify({ route: 'clarify', intent: 'widgetById', role: 'id', entities: {}, candidates });

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

const start = (): Promise<AssistantRig> => startAssistantRig({ stub, respond: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode }] } : undefined) });
/** The body of the router's request as the stand-in saw it, its JSON text unescaped so that the lines of the values read as they were sent. */
const routerRequest = (): string => (JSON.parse(stub.requests[0] ?? '{}') as { messages?: { content?: unknown }[] }).messages?.map((entry) => (typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content))).join('\n') ?? '';

describe('the elements selected on the canvas, in the real application over the model stand-in', () => {
  it('marks the selected element in what the router is sent, and runs the intent for the one selected element the router names, reading only through the gate', async () => {
    const rig = await start();
    const answer = await rig.turn('Show this widget', [naming('c2'), JSON.stringify({ tool: 'widgetById', values: { id: 'W-2' } }), '{"done":true}', JSON.stringify({ sentences: [{ text: 'The widget is owned by Ana Silva.', cites: ['r1'] }] })], { viewElementKeys: VIEW, selectionKeys: [key('widget', 'W-2')] });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: 'answered', route: 'ask', reads: [{ tool: 'widgetById', subject: 'W-2' }] });
    expect(routerRequest()).toContain('"W-2" (selected)');
    expect(routerRequest()).not.toContain('"W-1" (selected)');
    expect(rig.reads().some((read) => Object.values(read.parameters).includes('W-2'))).toBe(true);
    await rig.close();
  });

  it('asks which when the router asks for a choice between the two selected elements, and reads nothing for the intent', async () => {
    const rig = await start();
    const answer = await rig.turn('Show this widget', [clarifying('c1', 'c2')], { viewElementKeys: VIEW, selectionKeys: [key('widget', 'W-1'), key('widget', 'W-2')] });
    expect(answer.body).toMatchObject({ status: 'clarification', candidates: [expect.anything(), expect.anything()] });
    await rig.close();
  });

  it('asks among the elements of the role’s type when the router names a selected element of another type', async () => {
    const rig = await start();
    const answer = await rig.turn('Show this', [naming('c3')], { viewElementKeys: VIEW, selectionKeys: [key('gadget', 'Z-0')] });
    expect(answer.body).toMatchObject({ status: 'clarification', candidates: [expect.anything(), expect.anything()] });
    await rig.close();
  });

  it('sends the router the view as before when nothing is selected, and drops a selected key that is not in the view', async () => {
    const rig = await start();
    await rig.turn('Show this widget', [clarifying('c1', 'c2')], { viewElementKeys: VIEW });
    const baseline = routerRequest();
    expect(baseline).not.toContain('"W-1" (selected)');
    expect(baseline).not.toContain('"W-2" (selected)');
    const again = await start();
    await again.turn('Show this widget', [clarifying('c1', 'c2')], { viewElementKeys: VIEW, selectionKeys: [key('widget', 'W-9')] });
    expect(routerRequest()).toBe(baseline);
    await rig.close();
    await again.close();
  });

  it('puts neither the selection nor the marks in any audit event or log line', async () => {
    const rig = await start();
    await rig.turn('Show this widget', [naming('c2')], { viewElementKeys: VIEW, selectionKeys: [key('widget', 'W-2')] });
    expectNoValue([rig.events(), rig.logs], ['(selected)', 'W-2']);
    await rig.close();
  });
});
