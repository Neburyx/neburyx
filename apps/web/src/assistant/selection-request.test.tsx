import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSISTANT_REFUSAL_SENTENCES, type AssistantTurnAnswer } from '@neburyx/contracts';
import { edge, key, node, ref } from '../state/test-data.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { harness, RECORD, REFUSE, typeAndSend } from './assistant-kit.js';

afterEach(cleanup);

const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const C = ref('a', 'type-a', 'ent-3');
const EDGE = edge('a', 'rel-1', 'ent-1', 'ent-2');
const TOKEN = `${'1'.repeat(10)}.${'a'.repeat(64)}`;
const choiceFor = (stableId: string) => ({ intent: 'shared', roles: ['id'], entities: { id: stableId }, choiceToken: TOKEN });
const CLARIFICATION: AssistantTurnAnswer = { status: 'clarification', question: 'Which widget do you mean?', candidates: [{ title: 'W-884', type: 'widget', choice: choiceFor('W-884') }, { title: 'W-217', type: 'widget', choice: choiceFor('W-217') }] };

function setup(answer: (request: unknown) => AssistantTurnAnswer = () => REFUSE) {
  const h = harness(async (request) => ({ ok: true as const, value: answer(request) }));
  const result = { sourceId: 'a', nodes: [node('a', 'ent-1'), node('a', 'ent-2'), node('a', 'ent-3')], edges: [EDGE] };
  h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A, B, C], edgeRefs: [EDGE.ref] }, [{ key: key('a'), result }]);
  render(h.tree());
  return h;
}
const sentSelection = (h: ReturnType<typeof setup>, index = 0): readonly string[] | undefined => (h.sent[index] as { selectionKeys?: readonly string[] } | undefined)?.selectionKeys;

describe('the selection the Assistant panel sends with a typed message', () => {
  it('sends the drawn selected keys, nodes and a relationship, in the order of the view’s keys', async () => {
    const h = setup();
    act(() => h.state.presentation.select([elementKey(C), edgeKey(EDGE.ref), elementKey(A)]));
    await typeAndSend('what is this?');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    const view = (h.sent[0]?.viewElementKeys ?? []) as readonly string[];
    expect(sentSelection(h)).toEqual(view.filter((viewKey) => [elementKey(C), edgeKey(EDGE.ref), elementKey(A)].includes(viewKey)));
    expect(sentSelection(h)).toHaveLength(3);
  });

  it('sends no member when nothing is selected', async () => {
    const h = setup();
    await typeAndSend('what is this?');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    expect(h.sent[0] && 'selectionKeys' in h.sent[0]).toBe(false);
  });

  it('does not send the key of an element that was hidden after it was selected', async () => {
    const h = setup();
    act(() => h.state.presentation.select([elementKey(A), elementKey(B)]));
    act(() => h.state.hide([elementKey(B)]));
    await typeAndSend('what is this?');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    expect(sentSelection(h)).toEqual([elementKey(A)]);
  });

  it('sends the selection each message was typed with', async () => {
    const h = setup();
    act(() => h.state.presentation.select([elementKey(A)]));
    await typeAndSend('what is this?');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    act(() => h.state.presentation.select([elementKey(B)]));
    await typeAndSend('and this one?');
    await act(async () => undefined);
    expect(sentSelection(h, 0)).toEqual([elementKey(A)]);
    expect(sentSelection(h, 1)).toEqual([elementKey(B)]);
  });

  it('sends none with the choice of a candidate', async () => {
    const h = setup((request) => ('choice' in (request as object) ? REFUSE : CLARIFICATION));
    act(() => h.state.presentation.select([elementKey(A)]));
    await typeAndSend('and the other widget?');
    await userEvent.click(await screen.findByRole('button', { name: /W-217/ }));
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    expect(sentSelection(h, 0)).toEqual([elementKey(A)]);
    expect(h.sent[1] && 'choice' in h.sent[1]).toBe(true);
    expect(h.sent[1] && 'selectionKeys' in h.sent[1]).toBe(false);
  });
});
