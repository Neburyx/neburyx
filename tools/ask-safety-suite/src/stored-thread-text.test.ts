import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { plainNode } from '../../../services/api/src/testing/normalize-fixtures.js';
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
/** The cell the model writes: the id of the element it cites, the one text a cell may carry here. */
const ANSWER_CELL = 'W-1';

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

describe('the text a thread keeps, through the real application of the assistant', () => {
  it('is in the thread row\'s question and answer only: no audit event, log line, header, run record or export holds the question or a cell of the answer', async () => {
    const rig = await startAssistantRig({ stub, threads: true, respond: (call) => (['entity-load', 'entity-load-many', 'file-query'].includes(call.templateId) ? { status: 'rows', rows: [{ n: plainNode(['Widget'], { widgetId: 'W-1', ownerName: 'Ana Silva' }, '4:s:W-1') }] } : undefined) });
    const answer = await rig.turn(QUESTION, [FORM, READ_VIEW, DONE, JSON.stringify({ columns: ['Element'], rows: [{ cells: [ANSWER_CELL], cites: ['n1'] }] })], { viewElementKeys: [WIDGET_KEY] });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: 'answered', blocks: [{ kind: 'table', table: { rows: [{ cells: [ANSWER_CELL] }] } }] });
    await rig.threadWritten(1);
    // both texts are the thread's own, kept in its question and answer
    expect(rig.threadText()).toContain('SENTINEL-QUESTION-31');
    expect(rig.threadText()).toContain(ANSWER_CELL);
    const exported = await rig.exportText([{ sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }]);
    // a positive control: the export that is searched is the investigation's real export, which names the element
    expect(exported).toContain('W-1');
    expectNoValue([rig.events(), rig.logs, answer.headers, rig.threadRows(), rig.runRows(), exported], ['SENTINEL-QUESTION-31']);
    // the answer's cell is the element's own id here, which a scripted source can give no other value: the export names the element by it, so the cell is looked for where no record may hold it
    expectNoValue([rig.events(), rig.logs, answer.headers, rig.runRows()], [ANSWER_CELL]);
    expect(exported).not.toContain('SENTINEL-QUESTION-31');
    await rig.close();
  });

  it('canary: a planted cell in the text of an event, a run record or an export is found by the same read, so the case above can fail', async () => {
    const rig = await startAssistantRig({ stub, threads: true, respond: () => undefined });
    for (const place of [[{ detail: { text: CELL } }], JSON.stringify({ outcome: CELL }), `{"rows":["${CELL}"]}`]) expect(() => expectNoValue([place, rig.logs], [CELL])).toThrow();
    await rig.close();
  });
});

describe('the clearing of a thread, through the real application of the assistant', () => {
  it('leaves no question, answer or call text of the thread in its rows or its run records, and the clearing’s own answer and the events and log lines of the call hold none', async () => {
    const rig = await startAssistantRig({ stub, threads: true, respond: (call) => (['entity-load', 'entity-load-many', 'file-query'].includes(call.templateId) ? { status: 'rows', rows: [{ n: plainNode(['Widget'], { widgetId: 'W-1', ownerName: 'Ana Silva' }, '4') }] } : undefined) });
    const answer = await rig.turn(QUESTION, [FORM, READ_VIEW, DONE, JSON.stringify({ columns: ['Element'], rows: [{ cells: [ANSWER_CELL], cites: ['n1'] }] })], { viewElementKeys: [WIDGET_KEY] });
    expect(answer.status).toBe(200);
    await rig.threadWritten(1);
    // a positive control: before the clearing the thread and the run records do hold the text
    expect(rig.threadText()).toContain('SENTINEL-QUESTION-31');
    expect(rig.callText()).toContain('SENTINEL-QUESTION-31');
    const eventsBefore = rig.events().length;
    const logsBefore = rig.logs.length;
    const cleared = await rig.clearChat();
    expect([cleared.status, cleared.body]).toEqual([200, { cleared: true }]);
    expect(rig.threadText()).toBe('[]');
    expect(rig.threadRows()).toBe('[]');
    expectNoValue([rig.callText(), rig.threadText()], ['SENTINEL-QUESTION-31', ANSWER_CELL]);
    expect(rig.runRows()).not.toBe('[]');
    // the clearing writes no text anywhere: its answer, headers and the events and log lines it added
    expectNoValue([cleared.body, cleared.headers, rig.events().slice(eventsBefore), rig.logs.slice(logsBefore)], ['SENTINEL-QUESTION-31', ANSWER_CELL]);
    expect((await rig.clearChat()).body).toEqual({ cleared: false });
    await rig.close();
  });

  it('canary: a call text that is still there after a clearing is found by the same read, so the case above can fail', () => {
    expect(() => expectNoValue([JSON.stringify([['SENTINEL-QUESTION-31']])], ['SENTINEL-QUESTION-31'])).toThrow();
  });

  it('refuses a body that is not the empty object and an investigation that is not there, and deletes nothing', async () => {
    const rig = await startAssistantRig({ stub, threads: true, respond: (call) => (['entity-load', 'entity-load-many', 'file-query'].includes(call.templateId) ? { status: 'rows', rows: [{ n: plainNode(['Widget'], { widgetId: 'W-1', ownerName: 'Ana Silva' }, '4') }] } : undefined) });
    await rig.turn(QUESTION, [FORM, READ_VIEW, DONE, JSON.stringify({ columns: ['Element'], rows: [{ cells: [ANSWER_CELL], cites: ['n1'] }] })], { viewElementKeys: [WIDGET_KEY] });
    await rig.threadWritten(1);
    for (const payload of [{ cleared: true }, [], 'x']) expect((await rig.clearChat(rig.investigationId, payload)).status).toBe(400);
    expect((await rig.clearChat('0192f000-0000-7000-8000-00000000ffff')).status).toBe(404);
    expect(rig.threadText()).toContain('SENTINEL-QUESTION-31');
    await rig.close();
  });
});
