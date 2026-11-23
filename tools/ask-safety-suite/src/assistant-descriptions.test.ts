import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { widget } from '../../../services/api/src/testing/search-app.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { startAssistantRig, type AssistantRig } from './assistant-rig.js';
import { expectNoValue, expectOnlyRegisteredReads } from './checks.js';
import { HOSTILE_VALUES } from './hostile.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

const OPERATOR_TEXT = 'A widget is a small unit that holds up to 12 parts.';
const WIDGET_KEY = JSON.stringify(['node', 'demo', 'widget', 'W-1']);
const meaning = (...types: string[]): string => JSON.stringify({ route: 'meaning', types });
const sentences = (text: string, cites: string[]): string => JSON.stringify({ sentences: [{ text, cites }] });

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

const rigOf = (): Promise<AssistantRig> => startAssistantRig({ stub, descriptions: { widget: OPERATOR_TEXT }, respond: (call) => (call.templateId === 'file-query' ? entityRows(widget(2)) : undefined) });

describe('the meaning of a type, written by the server from the operator’s text', () => {
  it('answers a question about a described type with the operator’s text, makes one model call and reads nothing from the source', async () => {
    const rig = await rigOf();
    const before = rig.reads().length;
    const answer = await rig.turn('What is a widget?', [meaning('widget')]);
    expect(answer.body).toMatchObject({ status: 'meaning', described: [{ type: 'Widget', description: OPERATOR_TEXT }] });
    expect(stub.requests).toHaveLength(1);
    expect(rig.reads()).toHaveLength(before);
    await rig.close();
  });

  it.each(HOSTILE_VALUES.map((entry) => [entry.name, entry] as const))('never shows a type name that is %s, and reads nothing but what the registered reads allow', async (_name, hostile) => {
    const rig = await rigOf();
    const answer = await rig.turn('What is that?', [meaning(hostile.value), sentences('Nothing is shown.', ['n1'])], { viewElementKeys: [WIDGET_KEY] });
    expect(JSON.stringify(answer.body)).not.toContain(hostile.sentinel);
    expectOnlyRegisteredReads(rig.reads(), ['entity-load', 'entity-load-many']);
    expectNoValue([rig.events(), rig.logs], [hostile.sentinel]);
    await rig.close();
  });
});

describe('an m line sent to the model for a view question', () => {
  it('holds the operator’s text as a quoted string and no value of the graph, and an m key the model invents is dropped with the sentence', async () => {
    const rig = await rigOf();
    const answer = await rig.turn('What is a widget here?', [JSON.stringify({ route: 'view' }), JSON.stringify({ tool: 'view', values: {} }), '{"done":true}', sentences('A widget is a thing.', ['m9'])], { viewElementKeys: [WIDGET_KEY] });
    const blockText = (block: unknown): string => {
      if (typeof block !== 'object' || block === null) return '';
      if ('text' in block) return String(block.text);
      return 'content' in block ? (typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(blockText).join('') : '') : '';
    };
    const textOf = (body: string): string => {
      const messages = (JSON.parse(body) as { messages?: { content?: unknown }[] }).messages ?? [];
      return messages.map((message) => (typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(blockText).join('') : '')).join('\n');
    };
    const sent = stub.requests.map(textOf).find((text) => text.includes('What the types mean')) ?? '';
    expect(sent).toContain(`m1: entity type Widget: ${JSON.stringify(OPERATOR_TEXT)}`);
    const section = sent.slice(sent.indexOf('What the types mean'));
    expect(section).not.toContain('W-1');
    expect(answer.body).not.toMatchObject({ status: 'answered', sentences: expect.anything() });
    await rig.close();
  });

  it('never shows a reply that says a described type has no description: the call is repeated once and then the turn is the fixed refusal', async () => {
    const rig = await rigOf();
    const reply = JSON.stringify({ noDescription: ['widget'] });
    const answer = await rig.turn('What is a widget here?', [JSON.stringify({ route: 'view' }), reply, reply], { viewElementKeys: [WIDGET_KEY] });
    expect(JSON.stringify(answer.body)).not.toContain('no description');
    expect(answer.body).toMatchObject({ status: 'not-answered' });
    await rig.close();
  });
});
