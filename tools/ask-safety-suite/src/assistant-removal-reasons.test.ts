import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { widget } from '../../../services/api/src/testing/search-app.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { startAssistantRig, type AssistantRig } from './assistant-rig.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

const WIDGET_KEY = JSON.stringify(['node', 'demo', 'widget', 'W-1']);
const VIEW = JSON.stringify({ route: 'view' });
const READ_VIEW = JSON.stringify({ tool: 'view', values: {} });
const DONE = '{"done":true}';
const sentences = (...each: { text: string; cites: string[] }[]): string => JSON.stringify({ sentences: each });

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

const rigOf = (): Promise<AssistantRig> => startAssistantRig({ stub, respond: (call) => (call.templateId === 'file-query' ? entityRows(widget(2)) : undefined) });

const textsOf = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(textsOf);
  return [];
};

/** What the `answer` tool told the model, as the last request to the model holds it. */
const toldOf = (): string[] => textsOf(JSON.parse(stub.requests.at(-1) ?? '{}')).filter((text) => text.startsWith('Checked:'));

describe('what the model is told when the check removes a sentence', () => {
  it('holds the removed sentence as the model wrote it and fixed words, and nothing of the source that the text sent did not hold', async () => {
    const rig = await rigOf();
    const invented = 'Account Zed-9 is in view.';
    const answer = await rig.turn('What is in view?', [VIEW, READ_VIEW, DONE, sentences({ text: invented, cites: ['n1'] })], { viewElementKeys: [WIDGET_KEY] });
    const told = toldOf().join('\n');
    expect(told).toMatch(/^Checked: 0 sentences kept, 1 removed\. Call answer again with sentences that cite elements, or reply "Done\."\.\nRemoved: "Account Zed-9 is in view\." \([^"]+\)\.$/);
    expect(told).not.toContain('W-1');
    expect(JSON.stringify(answer.body)).not.toContain('Removed:');
    expect(JSON.stringify(answer.body)).not.toContain('Zed-9');
    await rig.close();
  });

  it('names a number the lines do not hold the same way, and shows the person none of it', async () => {
    const rig = await rigOf();
    const answer = await rig.turn('What is in view?', [VIEW, READ_VIEW, DONE, sentences({ text: 'The element in view has 7311 rows.', cites: ['n1'] })], { viewElementKeys: [WIDGET_KEY] });
    expect(toldOf().join('\n')).toMatch(/\nRemoved: "The element in view has 7311 rows\." \(a number in it is not on the lines it cites[^"]+\)\.$/);
    expect(JSON.stringify(answer.body)).not.toContain('Removed:');
    expect(JSON.stringify(answer.body)).not.toContain('7311');
    await rig.close();
  });

  it('canary: a turn that removes nothing tells the model nothing of a removal, so the assertions above fail on it', async () => {
    const rig = await rigOf();
    await rig.turn('What is in view?', [VIEW, READ_VIEW, DONE, sentences({ text: 'This element is in view.', cites: ['n1'] })], { viewElementKeys: [WIDGET_KEY] });
    expect(toldOf()).toEqual([]);
    await rig.close();
  });
});
