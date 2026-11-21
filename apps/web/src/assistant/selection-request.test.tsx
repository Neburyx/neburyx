import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { askAnswerSchema, ASSISTANT_REFUSAL_SENTENCES, type AssistantTurnAnswer } from '@neburyx/contracts';
import { edge, key, node, ref } from '../state/test-data.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { heavyRun } from '../patterns/patterns-kit.js';
import { continueOf, harness, RECORD, REFUSE, typeAndSend } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

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
  it('sends none with a follow-up chip', async () => {
    const entity = { ref: { sourceId: 'a', entityType: 'type-a', stableId: 'ent-1' }, display: { title: 'ent-1', type: 'type-a' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
    const withChip: AssistantTurnAnswer = { status: 'answered', route: 'ask', answer: askAnswerSchema.parse({ answered: { intent: 'accounts-paid-by', entities: { targetId: 'ent-1' }, outcome: 'complete', result: { templateId: 'entity', result: entity } } }), followUps: [{ titles: ['ent-1'], choice: choiceFor('ent-1') }] };
    const h = setup((request) => ('choice' in (request as object) ? REFUSE : withChip));
    act(() => h.state.presentation.select([elementKey(A)]));
    await typeAndSend('who paid ent-1?');
    await userEvent.click(await screen.findByRole('button', { name: 'Shared · ent-1' }));
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    expect(sentSelection(h, 0)).toEqual([elementKey(A)]);
    expect(h.sent[1] && 'choice' in h.sent[1]).toBe(true);
    expect(h.sent[1] && 'selectionKeys' in h.sent[1]).toBe(false);
  });

  it('sends none with a continue', async () => {
    const heavy: AssistantTurnAnswer = { status: 'answered', route: 'ask', answer: askAnswerSchema.parse({ answered: { intent: 'shared-devices', entities: { account: 'acc-1' }, outcome: 'complete', continueToken: TOKEN, result: { templateId: 'shared-attribute', result: heavyRun() } } }) };
    const h = setup((request) => (continueOf(request as Parameters<typeof continueOf>[0]) === undefined ? heavy : REFUSE));
    act(() => h.state.presentation.select([elementKey(A)]));
    await typeAndSend('big one');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.continue }));
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    expect(sentSelection(h, 0)).toEqual([elementKey(A)]);
    expect(h.sent[1] && 'continue' in h.sent[1]).toBe(true);
    expect(h.sent[1] && 'selectionKeys' in h.sent[1]).toBe(false);
  });

  it('sends none with the decision of a waiting confirmation', async () => {
    const plan = `${'1'.repeat(10)}.${'a'.repeat(120)}.${'b'.repeat(64)}`;
    const waiting: AssistantTurnAnswer = { status: 'confirmation', pendingId: '0192f000-0000-7000-8000-0000000000a1', plan, step: { tool: 'relationships-of-a-device', kind: 'template', subject: 'DEV-884', count: { quality: 'lowerBound', value: 1200 }, page: 25 }, reads: [] };
    const h = setup((request) => ('confirmation' in (request as object) ? REFUSE : waiting));
    act(() => h.state.presentation.select([elementKey(A)]));
    await typeAndSend('who else uses DEV-884?');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.confirm }));
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    expect(sentSelection(h, 0)).toEqual([elementKey(A)]);
    expect(h.sent[1] && 'confirmation' in h.sent[1]).toBe(true);
    expect(h.sent[1] && 'selectionKeys' in h.sent[1]).toBe(false);
  });
});
