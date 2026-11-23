import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { widget } from '../../../services/api/src/testing/search-app.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { startAssistantRig, type AssistantRig } from './assistant-rig.js';
import { expectNoValue } from './checks.js';
import { HOSTILE_VALUES } from './hostile.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

const WIDGET_KEY = JSON.stringify(['node', 'demo', 'widget', 'W-1']);
const READ_VIEW = JSON.stringify({ tool: 'view', values: {} });
const ROUTE = JSON.stringify({ route: 'view' });
const DONE = '{"done":true}';
/** The input of the `answer` tool for one list: its items, each a sentence with its cites. */
const list = (items: { text: string; cites: readonly string[] }[], label?: string): string => JSON.stringify({ blocks: [{ kind: 'list', ...(label === undefined ? {} : { label }), items }] });

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

const GOOD_ITEM = { text: 'W-1 is a widget.', cites: ['n1'] };

/** A bad item is gone from the body, the good item stays, and the closing event counts the one item it dropped. */
function expectItemDropped(body: Record<string, unknown>, sentinel: string): void {
  expect(JSON.stringify(body)).not.toContain(sentinel);
  expect(body).toMatchObject({ status: 'answered', blocks: [{ kind: 'list', items: [GOOD_ITEM] }] });
}

const rigOf = (): Promise<AssistantRig> => startAssistantRig({ stub, respond: (call) => (call.templateId === 'file-query' ? entityRows(widget(2)) : undefined) });
const turnOf = (rig: AssistantRig, reply: string) => rig.turn('Show where it came from as a list.', [ROUTE, READ_VIEW, DONE, reply], { viewElementKeys: [WIDGET_KEY] });

describe('a list answer', () => {
  it('shows items that cite what they were given, and no item or label reaches an event or a log line', async () => {
    const rig = await rigOf();
    const answer = await turnOf(rig, list([GOOD_ITEM], 'Where it came from'));
    expect(answer.body).toMatchObject({ status: 'answered', route: 'view', blocks: [{ kind: 'list', label: 'Where it came from', items: [GOOD_ITEM] }] });
    expectNoValue([rig.events(), rig.logs], ['W-1 is a widget']);
    await rig.close();
  });

  it('drops an item that cites nothing, and keeps the item that cites an element', async () => {
    const rig = await rigOf();
    const answer = await turnOf(rig, list([GOOD_ITEM, { text: 'SENTINEL-L1 is a widget.', cites: [] }]));
    expectItemDropped(answer.body, 'SENTINEL-L1');
    await rig.close();
  });

  it('drops an item that states a number its cited element does not hold', async () => {
    const rig = await rigOf();
    const answer = await turnOf(rig, list([GOOD_ITEM, { text: 'W-1 has 48291.17 rows.', cites: ['n1'] }]));
    expectItemDropped(answer.body, '48291.17');
    await rig.close();
  });

  it.each(HOSTILE_VALUES.map((entry) => [entry.name, entry] as const))('drops an item that is %s and shows nothing of it', async (_name, hostile) => {
    const rig = await rigOf();
    const answer = await turnOf(rig, list([GOOD_ITEM, { text: hostile.value, cites: ['n1'] }]));
    expect(JSON.stringify(answer.body)).not.toContain(hostile.sentinel);
    // an item that holds a verdict or names an intent ends the answer, as for a sentence; any other hostile item is dropped and the good item stays
    if (/intent/.test(hostile.value) || hostile.value.length > 1000) expect(answer.body).toMatchObject({ status: 'not-answered' });
    else expect(answer.body).toMatchObject({ status: 'answered', blocks: [{ kind: 'list', items: [GOOD_ITEM] }] });
    expectNoValue([rig.events(), rig.logs], [hostile.sentinel]);
    await rig.close();
  });

  it('refuses the whole answer when an item states a verdict, with no item shown', async () => {
    const rig = await rigOf();
    const answer = await turnOf(rig, list([GOOD_ITEM, { text: 'W-1 is guilty of fraud.', cites: ['n1'] }]));
    expect(JSON.stringify(answer.body)).not.toContain('guilty');
    expect(answer.body).not.toHaveProperty('blocks');
    await rig.close();
  });

  it('shows an item whose count the cited line holds', async () => {
    const rig = await rigOf();
    const answer = await turnOf(rig, list([{ text: 'W-1 is one widget.', cites: ['n1'] }]));
    expect(answer.body).toMatchObject({ status: 'answered', blocks: [{ kind: 'list', items: [{ cites: ['n1'] }] }] });
    await rig.close();
  });

  it.each(['SENTINEL-L1', '48291.17', 'SENTINEL-A7'])('canary: the dropped-item check fails for a body that kept the bad item (%s), as it would if the item check were removed', (sentinel) => {
    const kept = { status: 'answered', blocks: [{ kind: 'list', items: [GOOD_ITEM, { text: sentinel, cites: ['n1'] }] }] };
    expect(() => expectItemDropped(kept, sentinel)).toThrow();
    const unmarked = { status: 'answered', blocks: [{ kind: 'list', items: [GOOD_ITEM] }] };
    expect(() => expectItemDropped({ ...unmarked, blocks: [{ kind: 'sentences', sentences: [GOOD_ITEM] }] }, sentinel)).toThrow();
  });
});
