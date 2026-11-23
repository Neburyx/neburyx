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
const FORM = JSON.stringify({ route: 'view', form: 'table' });
/** The input of the `answer` tool for a table: its columns and rows. */
const table = (columns: string[], rows: { cells: readonly string[]; cites: readonly string[] }[]): string => JSON.stringify({ columns, rows });
const READ_VIEW = JSON.stringify({ tool: 'view', values: {} });
const DONE = '{"done":true}';

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

const GOOD_ROW = { cells: ['W-1', 'widget'], cites: ['n1'] };

/** A bad row is gone from the body, the good row stays, and the answer counts the one row it dropped. */
function expectDropped(body: Record<string, unknown>, sentinel: string): void {
  expect(JSON.stringify(body)).not.toContain(sentinel);
  expect(body).toMatchObject({ status: 'answered', blocks: [{ kind: 'table', table: { rows: [GOOD_ROW], droppedRows: 1 } }] });
}

const rigOf = (): Promise<AssistantRig> => startAssistantRig({ stub, respond: (call) => (call.templateId === 'file-query' ? entityRows(widget(2)) : undefined) });
const turnOf = (rig: AssistantRig, reply: string) => rig.turn('Show the elements as a table.', [FORM, READ_VIEW, DONE, reply], { viewElementKeys: [WIDGET_KEY] });

describe('a table answer', () => {
  it('accepts a row of cells copied from the element it cites, and no cell, label or title reaches an event or a log line', async () => {
    const rig = await rigOf();
    const answer = await turnOf(rig, table(['Element', 'Type'], [{ cells: ['W-1', 'widget'], cites: ['n1'] }]));
    expect(answer.body).toMatchObject({ status: 'answered', route: 'view', blocks: [{ kind: 'table', table: { columns: ['Element', 'Type'] } }] });
    expectNoValue([rig.events(), rig.logs], ['W-1']);
    await rig.close();
  });

  it.each(HOSTILE_VALUES.map((entry) => [entry.name, entry] as const))('drops a row whose cell is %s and shows nothing of it', async (_name, hostile) => {
    const rig = await rigOf();
    const answer = await turnOf(rig, table(['Element', 'Type'], [GOOD_ROW, { cells: [hostile.value, 'widget'], cites: ['n1'] }]));
    // a cell over the bound of a cell or with a control character is no table, and a cell with a verdict word (the instruction names an intent) ends the answer: the reply is refused whole; any other cell is dropped with its row
    if (hostile.value.length > 80 || /[\u0000-\u001f]/.test(hostile.value) || /intent/.test(hostile.value)) {
      expect(JSON.stringify(answer.body)).not.toContain(hostile.sentinel);
      expect(answer.body).toMatchObject({ status: 'not-answered' });
    } else expectDropped(answer.body, hostile.sentinel);
    expectNoValue([rig.events(), rig.logs], [hostile.sentinel]);
    await rig.close();
  });

  it.each(HOSTILE_VALUES.map((entry) => [entry.name, entry] as const))('refuses a table whose column label is %s and shows nothing of it', async (_name, hostile) => {
    const rig = await rigOf();
    const answer = await turnOf(rig, table([hostile.value, 'Type'], [{ cells: ['W-1', 'widget'], cites: ['n1'] }]));
    expect(JSON.stringify(answer.body)).not.toContain(hostile.sentinel);
    expect(answer.body).toMatchObject({ status: 'not-answered' });
    await rig.close();
  });

  it('refuses a table with a cell that states a verdict, with the fixed sentence', async () => {
    const rig = await rigOf();
    const answer = await turnOf(rig, table(['Element', 'Type'], [{ cells: ['W-1', 'guilty of fraud'], cites: ['n1'] }]));
    expect(JSON.stringify(answer.body)).not.toContain('guilty');
    expect(answer.body).toMatchObject({ status: 'not-answered' });
    await rig.close();
  });

  const KEY_CASES = [
    ['cites a key the model invents', { cells: ['SENTINEL-K1', 'widget'], cites: ['n99'] }, 'SENTINEL-K1'],
    ['writes a key in a cell', { cells: ['n1 SENTINEL-K2', 'widget'], cites: ['n1'] }, 'SENTINEL-K2'],
  ] as const;
  it.each(KEY_CASES)('drops a row that %s and keeps the good row', async (_name, bad, sentinel) => {
    const rig = await rigOf();
    const answer = await turnOf(rig, table(['Element', 'Type'], [GOOD_ROW, bad]));
    expectDropped(answer.body, sentinel);
    await rig.close();
  });

  it('drops a row with a number that the element it cites does not hold, and keeps the row that copies what the element shows', async () => {
    const rig = await rigOf();
    const answer = await turnOf(
      rig,
      table(['Element', 'Type'], [
        { cells: ['W-1', '48291.17'], cites: ['n1'] },
        { cells: ['W-1', 'widget'], cites: ['n1'] },
      ]),
    );
    expectDropped(answer.body, '48291.17');
    await rig.close();
  });

  it.each(['SENTINEL-K1', 'SENTINEL-K2', '48291.17', 'SENTINEL-A7'])('canary: the dropped-row check fails for a body that kept the bad row (%s), as it would if the row check were removed', (sentinel) => {
    const kept = { status: 'answered', blocks: [{ kind: 'table', table: { rows: [GOOD_ROW, { cells: [sentinel, 'widget'], cites: ['n1'] }] } }] };
    expect(() => expectDropped(kept, sentinel)).toThrow();
    const unmarked = { status: 'answered', blocks: [{ kind: 'table', table: { rows: [GOOD_ROW] } }] };
    expect(() => expectDropped(unmarked, sentinel)).toThrow();
  });

  it('canary: a check for a value in a record fails when the record holds it', () => {
    expect(() => expectNoValue([[{ detail: { turn: { cells: ['SENTINEL-T9'] } } }]], ['SENTINEL-T9'])).toThrow();
  });
});
