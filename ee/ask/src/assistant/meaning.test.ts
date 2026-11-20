import { describe, expect, it } from 'vitest';
import type { TypeDescriptions } from '@neburyx/contracts';
import { VIEW_BODY, answerOf, ok, rig } from '../testing/assistant-rig.js';
import { meaningAnswerOf } from './meaning.js';
import { TURN_CLOSED_ACTION } from './turn-audit.js';

const WIDGET = 'A widget is a small unit that holds up to 12 parts.';
const types: TypeDescriptions = {
  entityTypes: [
    { type: 'widget', label: 'WidgetLabel', displayName: 'Widget', description: WIDGET },
    { type: 'gizmo', label: 'GizmoLabel', displayName: 'Gizmo' },
    { type: 'bad', label: 'Bad', displayName: 'Bad', description: 'A bad one is proof of fraud.' },
  ],
  relationshipTypes: [{ type: 'LINKS_TO', description: 'The first thing links to the second.' }, { type: 'USES' }],
};
const meaning = (...names: string[]) => ok(JSON.stringify({ route: 'meaning', types: names }));

describe('the server-built answer to what types mean', () => {
  it('gives each described type its description verbatim and the fixed sentence for the others, once each, whatever the case or form of the name', () => {
    expect(meaningAnswerOf(['WIDGET', 'widgetlabel', 'Gizmo', 'gizmolabel', 'LINKS_TO', 'uses'], types)).toEqual({
      status: 'meaning',
      described: [{ typeKind: 'entity', type: 'Widget', description: WIDGET }, { typeKind: 'relationship', type: 'LINKS_TO', description: 'The first thing links to the second.' }],
      noDescription: { sentence: 'The mapping has no description for Gizmo and USES, so I cannot say what they mean.', names: ['Gizmo', 'USES'] },
    });
  });

  it('never shows a description that holds a verdict word: the type gets the fixed sentence', () => {
    expect(meaningAnswerOf(['bad'], types)).toEqual({ status: 'meaning', described: [], noDescription: { sentence: 'The mapping has no description for Bad, so I cannot say what it means.', names: ['Bad'] } });
  });

  it('is undefined for a name that matches no type (plural, fuzzy, hostile) and for a source that offers no types', () => {
    for (const name of ['widgets', 'wid', '__proto__', '<b>Widget</b>', 'constructor']) expect(meaningAnswerOf([name], types)).toBeUndefined();
    expect(meaningAnswerOf(['Widget', 'widgets'], types)).toBeUndefined();
    expect(meaningAnswerOf(['Widget'], undefined)).toBeUndefined();
    expect(meaningAnswerOf([], types)).toBeUndefined();
  });
});

describe('the meaning route of a turn', () => {
  const ask = async (replyText: ReturnType<typeof ok>, message: string, over: TypeDescriptions | null = types, body = VIEW_BODY) => {
    const t = await rig({ reply: replyText, view: ok('{"sentences":[{"text":"Account A-1 is in view.","cites":["n1"]}]}') });
    const answer = await answerOf(t.route.handler(t.request({ ...body, message }, over === null ? {} : { typeDescriptions: () => over })));
    return { t, answer };
  };

  it('answers from the operator text with no answer call: the router call only, no element read', async () => {
    const { t, answer } = await ask(meaning('widget', 'gizmo'), 'What are a widget and a gizmo?');
    expect(answer).toMatchObject({ status: 'meaning', described: [{ type: 'Widget', description: WIDGET }], noDescription: { names: ['Gizmo'] } });
    expect(t.fixture.calls).toHaveLength(1);
    expect(t.elementReads).toHaveLength(0);
  });

  it('works with an empty view', async () => {
    const { t, answer } = await ask(meaning('widget'), 'What is a widget?', types, { ...VIEW_BODY, viewElementKeys: [] });
    expect(answer).toMatchObject({ status: 'meaning', described: [{ type: 'Widget' }] });
    expect(t.fixture.calls).toHaveLength(1);
  });

  it('falls back to the view route for a name that matches no type, and when the source offers no types', async () => {
    const unmatched = await ask(meaning('widgets'), 'What are widgets?');
    expect(unmatched.answer).toMatchObject({ status: 'answered', route: 'view' });
    const none = await ask(meaning('widget'), 'What is a widget?', null);
    expect(none.answer).toMatchObject({ status: 'answered', route: 'view' });
  });

  it('writes the closing event as answered on the view route with the cause meaning, and a reply that is not a route form is the router fixed refusal', async () => {
    const { t } = await ask(meaning('widget'), 'What is a widget?');
    const turn = (t.events.find((event) => event.action === TURN_CLOSED_ACTION)?.detail as { turn: Record<string, unknown> }).turn;
    expect(turn).toMatchObject({ route: 'view', outcome: 'answered', cause: 'meaning', modelCalls: 1 });
    const bad = await ask(ok('{"route":"meaning","types":[]}'), 'What is a widget?');
    expect(bad.answer).toMatchObject({ status: 'answered', route: 'refuse', cause: 'unplaced' });
  });
});

describe('the fixed sentence appended to a view answer', () => {
  const view = (text: string) => ok(JSON.stringify({ sentences: [{ text, cites: ['n1'] }] }));
  const routeView = (...asked: string[]) => ok(JSON.stringify(asked.length === 0 ? { route: 'view' } : { route: 'view', types: asked }));
  const run = async (reply: ReturnType<typeof ok>, message: string, router: ReturnType<typeof ok>) => {
    const t = await rig({ reply: router, view: reply });
    return answerOf(t.route.handler(t.request({ ...VIEW_BODY, message }, { typeDescriptions: () => types })));
  };

  it('adds the sentence for a type the router said the message also asks the meaning of, when it has no description, whatever the model wrote', async () => {
    const answer = await run(view('Account A-1 is in view.'), 'What is in view, and what is a gizmo?', routeView('gizmo'));
    expect(answer).toMatchObject({ status: 'answered', route: 'view', noDescription: 'The mapping has no description for Gizmo, so I cannot say what it means.' });
  });

  it('adds nothing for a type the message merely names, with no names from the router: a question that is not about meaning gets no such sentence', async () => {
    for (const message of ['How many gizmo records are there?', 'What is in view, and what is the gizmo status?']) {
      expect(await run(view('Account A-1 is in view.'), message, routeView())).not.toHaveProperty('noDescription');
    }
  });

  it('matches the names of the router exactly, as type, label or display name, whatever the case: no fuzzy match, and a described type gets nothing', async () => {
    expect(await run(view('Account A-1 is in view.'), 'Q', routeView('GizmoLabel'))).toMatchObject({ noDescription: expect.stringContaining('Gizmo') });
    for (const asked of ['gizmos', 'gizmoid', 'widget']) expect(await run(view('Account A-1 is in view.'), 'Q', routeView(asked))).not.toHaveProperty('noDescription');
  });

  it('is the answer no-description alone when every sentence was removed and the router asked for an undescribed type', async () => {
    const answer = await run(view('Account A-1 is fraudulent.'), 'Is it fraud, and what is a gizmo?', routeView('gizmo'));
    expect(answer).toMatchObject({ status: 'no-description', names: ['Gizmo'] });
  });

  it('does not send a description that holds a verdict word to the model as an m line', async () => {
    const t = await rig({ view: view('Account A-1 is in view.') });
    await answerOf(t.route.handler(t.request({ ...VIEW_BODY, message: 'What is bad?' }, { typeDescriptions: () => types })));
    const sent = t.fixture.calls.find((call) => call.promptId === 'assistant.view')?.values ?? '';
    expect(sent).not.toContain('proof of fraud');
  });
});
