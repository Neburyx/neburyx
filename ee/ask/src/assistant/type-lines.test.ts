import { sentencesOfBlocks, tablesOfBlocks, type AssistantBlocks } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { TypeDescriptions } from '@neburyx/contracts';
import { VIEW_BODY, answerOf, ok, rig } from '../testing/assistant-rig.js';
import { typeLinesOf } from './type-lines.js';

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
    if (answer.status !== 'answered' || answer.route !== 'view' || !('blocks' in answer)) throw new Error('not a view answer');
    expect(sentencesOfBlocks(answer.blocks)).toHaveLength(2);
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

describe('a question about a type the mapping does not describe', () => {
  const mixed: TypeDescriptions = {
    entityTypes: [
      { type: 'widget', label: 'Widget', displayName: 'Widget', description: WIDGET },
      { type: 'gizmo', label: 'GizmoLabel', displayName: 'Gizmo' },
      { type: 'sprocket', label: 'Sprocket', displayName: 'Sprocket' },
    ],
    relationshipTypes: [{ type: 'LINKS_TO' }],
  };
  const ask = (message: string, replyText: string, over: TypeDescriptions = mixed) =>
    rig({ view: ok(replyText) }).then(async (t) => ({ t, answer: await answerOf(t.route.handler(t.request({ ...VIEW_BODY, message }, { typeDescriptions: () => over }))) }));

  it('answers the fixed sentence for one name, built from the profile name whatever the form or case of the reply', async () => {
    for (const named of ['gizmo', 'GIZMO', 'gizmolabel', 'Gizmo']) {
      const { answer } = await ask('What is a gizmo?', JSON.stringify({ noDescription: [named] }));
      expect(answer).toEqual({ status: 'no-description', route: 'view', sentence: 'The mapping has no description for Gizmo, so I cannot say what it means.', names: ['Gizmo'] });
    }
  });

  it('names two and three types once each, with the plural wording', async () => {
    const two = await ask('What are a gizmo and a sprocket?', JSON.stringify({ noDescription: ['Gizmo', 'sprocket', 'GIZMO'] }));
    expect(two.answer).toMatchObject({ sentence: 'The mapping has no description for Gizmo and Sprocket, so I cannot say what they mean.', names: ['Gizmo', 'Sprocket'] });
    const three = await ask('What do gizmo, sprocket and LINKS_TO mean?', JSON.stringify({ noDescription: ['Gizmo', 'Sprocket', 'LINKS_TO'] }));
    expect(three.answer).toMatchObject({ sentence: 'The mapping has no description for Gizmo, Sprocket and LINKS_TO, so I cannot say what they mean.' });
  });

  it('answers the described type in sentences and the other in the fixed sentence, beside each other', async () => {
    const { answer } = await ask('What are a widget and a gizmo?', JSON.stringify({ sentences: [{ text: 'A widget is a small unit that holds up to 12 parts.', cites: ['m1'] }], noDescription: ['Gizmo'] }));
    expect(answer).toMatchObject({ status: 'answered', route: 'view', noDescription: 'The mapping has no description for Gizmo, so I cannot say what it means.' });
  });

  it('keeps the fixed sentence alone when every sentence is removed by the checks', async () => {
    const { answer } = await ask('What are a widget and a gizmo?', JSON.stringify({ sentences: [{ text: 'A widget holds up to 99 parts.', cites: ['m1'] }], noDescription: ['Gizmo'] }));
    expect(answer).toMatchObject({ status: 'no-description', names: ['Gizmo'] });
  });

  it('is a reply that does not fit when it names a described type, a type that is not in play or a hostile name: repeated once, then the fixed refusal, with no name shown', async () => {
    for (const named of ['Widget', 'sprocket', '__proto__', '<b>Gizmo</b>', 'constructor']) {
      const { t, answer } = await ask('What is a gizmo?', JSON.stringify({ noDescription: [named] }));
      expect(answer).toMatchObject({ status: 'not-answered', route: 'view' });
      expect(JSON.stringify(answer)).not.toContain(named);
      expect(t.fixture.calls.filter((call) => call.promptId === 'assistant.view')).toHaveLength(2);
    }
  });

  it('gives the type asked about the sentence when the source has no description at all', async () => {
    const none: TypeDescriptions = { entityTypes: mixed.entityTypes.map(({ description: _description, ...rest }) => rest), relationshipTypes: [] };
    const asked = await ask('What is a gizmo?', JSON.stringify({ noDescription: ['Gizmo'] }), none);
    expect(asked.answer).toMatchObject({ status: 'no-description', names: ['Gizmo'] });
  });

  it('writes the closing event as answered with the cause no-description', async () => {
    const { t } = await ask('What is a gizmo?', JSON.stringify({ noDescription: ['Gizmo'] }));
    const closing = t.events.find((event) => event.action === 'assistant.turn.closed');
    expect(JSON.stringify(closing)).toContain('no-description');
    expect(JSON.stringify(closing)).toContain('"outcome":"answered"');
  });
});

describe('the types in play for a call', () => {
  it('include the entity types of the thread the router named, once each, beside those of the elements, and a described type that is in neither is left out', () => {
    const offered: TypeDescriptions = { entityTypes: [{ type: 'widget', label: 'Widget', displayName: 'Widget', description: WIDGET }, { type: 'gadget', label: 'Gadget', displayName: 'Gadget', description: 'A gadget is a tool.' }], relationshipTypes: [] };
    const lines = typeLinesOf(offered, undefined, 'what does it mean?', [], ['widget', 'widget']);
    expect([...lines.lines.values()]).toEqual([`m1: entity type Widget: ${JSON.stringify(WIDGET)}`]);
    expect(typeLinesOf(offered, undefined, 'what does it mean?').lines.size).toBe(0);
  });
});

