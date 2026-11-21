import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { VIEW_BODY, VIEW_KEYS, answerOf, ok, rig, type RigOptions } from '../testing/assistant-rig.js';
import { selectedSectionOf } from './selected-section.js';
import type { AssembledText } from '../case-summary/assemble.js';

afterAll(removeAskFolders);

const GOOD = ok(JSON.stringify({ sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] }));
const viewCall = (t: Awaited<ReturnType<typeof rig>>) => t.fixture.calls.find((call) => call.promptId === 'assistant.view');
const turn = async (selectionKeys?: readonly string[], over: Partial<RigOptions> = {}) => {
  const t = await rig({ reply: ok('{"route":"view"}'), view: GOOD, ...over });
  await answerOf(t.route.handler(t.request({ ...VIEW_BODY, ...(selectionKeys === undefined ? {} : { selectionKeys }) })));
  return t;
};

describe('the answer from the view and the elements the person has selected', () => {
  it('lists the selected elements by their keys in the call’s text, after the elements', async () => {
    const t = await turn([VIEW_KEYS[1] ?? '']);
    const values = viewCall(t)?.values ?? '';
    expect(values).toContain('The person has selected these elements in view, by key: n2.');
    expect(values.indexOf('Elements in view:')).toBeLessThan(values.indexOf('The person has selected'));
    expect(values).not.toContain('selected these elements in view, by key: n1');
  });

  it('gives the call the values it had before when nothing is selected, an empty list is sent, or no key is a key of the view', async () => {
    const baseline = viewCall(await turn())?.values ?? '';
    expect(baseline).not.toContain('selected these elements');
    for (const selection of [[], [JSON.stringify(['node', 'demo', 'widget', 'A-9'])]]) expect(viewCall(await turn(selection))?.values, JSON.stringify(selection)).toBe(baseline);
  });

  it('leaves out of the section a selected element that is not in the call’s text, and says nothing when none is', () => {
    const assembled = { keys: new Map([['n1', { kind: 'entity', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' } }]]) } as unknown as AssembledText;
    const key = (id: string) => JSON.stringify(['node', 'demo', 'widget', id]);
    expect(selectedSectionOf([key('A-1'), key('A-9')], 'demo', assembled)).toBe('\n\nThe person has selected these elements in view, by key: n1.');
    expect(selectedSectionOf([key('A-9')], 'demo', assembled)).toBe('');
    expect(selectedSectionOf(undefined, 'demo', assembled)).toBe('');
    expect(selectedSectionOf(['not a key'], 'demo', assembled)).toBe('');
  });

  it('is told by the shipped prompt: it names the selected elements, says what this and it mean, and forbids citing an element for being in the section', async () => {
    const { readFileSync } = await import('node:fs');
    const prompt = readFileSync(new URL('../../prompts/assistant-view.md', import.meta.url), 'utf8');
    for (const phrase of ['says which of them the person has selected on the canvas', '"this", "it" and "the selected one" mean those elements', 'cites a selected element only when it rests on that element\'s own line', 'being in that section is never a reason to cite an element and never a fact to state', 'When there is no such section, the question is about the elements in view']) expect(prompt).toContain(phrase);
  });
});
