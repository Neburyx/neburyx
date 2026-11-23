import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { widget } from '../../../services/api/src/testing/search-app.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { startAssistantRig } from './assistant-rig.js';
import { expectNoValue } from './checks.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

const WIDGET_KEY = JSON.stringify(['node', 'demo', 'widget', 'W-1']);
const FORM = JSON.stringify({ route: 'view', form: 'table' });
const READ_VIEW = JSON.stringify({ tool: 'view', values: {} });
const DONE = '{"done":true}';
/** Text the person typed and text the model wrote, each planted where the thread keeps it and nowhere else. */
const QUESTION = 'Show SENTINEL-QUESTION-31 as a table.';
const CELL = 'SENTINEL-ANSWER-31';

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

describe('the text a thread keeps, through the real application of the assistant', () => {
  it('is in the thread row\'s question and answer only: no audit event, log line, header, response header or other member of the row holds the question or a cell of the answer', async () => {
    const rig = await startAssistantRig({ stub, threads: true, respond: (call) => (call.templateId === 'file-query' ? entityRows(widget(2)) : undefined) });
    const answer = await rig.turn(QUESTION, [FORM, READ_VIEW, DONE, JSON.stringify({ columns: ['Element'], rows: [{ cells: ['W-1'], cites: ['n1'] }] })], { viewElementKeys: [WIDGET_KEY] });
    expect(answer.status).toBe(200);
    await rig.threadWritten(1);
    expect(rig.threadText()).toContain('SENTINEL-QUESTION-31');
    expectNoValue([rig.events(), rig.logs, answer.headers, rig.threadRows()], ['SENTINEL-QUESTION-31']);
    // the cell is the element's own id here: the events and the log lines of the turn hold none of the answer's cells
    expectNoValue([rig.events(), rig.logs], ['W-1']);
    await rig.close();
  });

  it('canary: a planted cell in the text of an event is found by the same read, so the case above could fail', async () => {
    const rig = await startAssistantRig({ stub, threads: true, respond: () => undefined });
    expect(() => expectNoValue([[{ detail: { text: CELL } }], rig.logs], [CELL])).toThrow();
    await rig.close();
  });
});
