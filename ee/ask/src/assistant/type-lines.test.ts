import { describe, expect, it } from 'vitest';
import type { TypeDescriptions } from '@neburyx/contracts';
import { VIEW_BODY, answerOf, ok, rig } from '../testing/assistant-rig.js';

const reply = (sentences: readonly { text: string; cites: readonly string[] }[]) => ok(JSON.stringify({ sentences }));
const WIDGET = 'A widget is a small unit that holds up to 12 parts.';
const descriptions: TypeDescriptions = {
  entityTypes: [
    { type: 'widget', label: 'Widget', displayName: 'Widget', description: WIDGET },
    { type: 'gadget', label: 'Gadget', displayName: 'Gadget', description: 'A gadget is a tool.' },
  ],
  relationshipTypes: [],
};
const viewCall = (t: Awaited<ReturnType<typeof rig>>) => t.fixture.calls.filter((call) => call.promptId === 'assistant.view')[0];

describe('the meaning lines of the view call', () => {
  it('sends the description of a type of the elements as an m line, and not the description of a type that is absent', async () => {
    const t = await rig({ view: reply([{ text: 'Account A-1 is in view.', cites: ['n1'] }]) });
    await answerOf(t.route.handler(t.request(VIEW_BODY, { typeDescriptions: () => descriptions })));
    const values = viewCall(t)?.values ?? '';
    expect(values).toContain(`m1: entity type Widget: ${JSON.stringify(WIDGET)}`);
    expect(values).not.toContain('A gadget is a tool.');
  });

  it('leaves the values exactly as they were when the mapping has no description', async () => {
    const without = await rig({ view: reply([{ text: 'Account A-1 is in view.', cites: ['n1'] }]) });
    await answerOf(without.route.handler(without.request(VIEW_BODY)));
    const empty = await rig({ view: reply([{ text: 'Account A-1 is in view.', cites: ['n1'] }]) });
    await answerOf(empty.route.handler(empty.request(VIEW_BODY, { typeDescriptions: () => ({ entityTypes: [], relationshipTypes: [] }) })));
    expect(viewCall(empty)?.values).toBe(viewCall(without)?.values);
  });

  it('keeps a sentence that cites an m line, with a description citation beside the element citations', async () => {
    const t = await rig({ view: reply([{ text: 'A widget is a small unit that holds up to 12 parts.', cites: ['m1'] }, { text: 'Account A-1 is in view.', cites: ['n1'] }]) });
    const answer = await answerOf(t.route.handler(t.request(VIEW_BODY, { typeDescriptions: () => descriptions })));
    if (answer.status !== 'answered' || answer.route !== 'view') throw new Error('not a view answer');
    expect(answer.sentences).toHaveLength(2);
    expect(answer.citations.map((citation) => [citation.key, citation.kind])).toEqual([['n1', 'entity'], ['m1', 'description']]);
    expect(answer.citations[1]).toMatchObject({ typeKind: 'entity', type: 'Widget', description: WIDGET });
  });

  it('removes a sentence that cites an m line and states a figure or a name the line does not hold', async () => {
    const t = await rig({ view: reply([{ text: 'A widget holds up to 20 parts.', cites: ['m1'] }]) });
    expect(await answerOf(t.route.handler(t.request(VIEW_BODY, { typeDescriptions: () => descriptions })))).toMatchObject({ status: 'not-answered' });
  });

  it('holds a number about an element to the element lines: a figure of the description does not support it', async () => {
    const t = await rig({ view: reply([{ text: 'Account A-1 holds 12 parts.', cites: ['n1', 'm1'] }]) });
    expect(await answerOf(t.route.handler(t.request(VIEW_BODY, { typeDescriptions: () => descriptions })))).toMatchObject({ status: 'not-answered' });
  });

  it('rejects a verdict word even when the description holds it', async () => {
    const withVerdict: TypeDescriptions = { entityTypes: [{ type: 'widget', label: 'Widget', displayName: 'Widget', description: 'A widget is proof of fraud.' }], relationshipTypes: [] };
    const t = await rig({ view: reply([{ text: 'A widget is proof of fraud.', cites: ['m1'] }]) });
    expect(await answerOf(t.route.handler(t.request(VIEW_BODY, { typeDescriptions: () => withVerdict })))).toMatchObject({ status: 'not-answered' });
  });

  it('sends the description of a type the message names even when no element has it', async () => {
    const t = await rig({ view: reply([{ text: 'A gadget is a tool.', cites: ['m1'] }]) });
    const answer = await answerOf(t.route.handler(t.request({ ...VIEW_BODY, message: 'What is a gadget?' }, { typeDescriptions: () => ({ ...descriptions, entityTypes: descriptions.entityTypes.slice(1) }) })));
    expect(viewCall(t)?.values).toContain('m1: entity type Gadget:');
    expect(answer).toMatchObject({ status: 'answered' });
  });
});
