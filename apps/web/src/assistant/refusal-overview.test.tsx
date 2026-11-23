import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSISTANT_REFUSAL_SENTENCES, type AssistantTurnAnswer } from '@neburyx/contracts';
import { AiActionsProvider, createAiActions } from '../ai/ai-actions.js';
import { edge, key, node, ref } from '../state/test-data.js';
import { need } from '../test-utils.js';
import { elementKey } from '../state/keys.js';
import { registerFiltersTool } from '../workspace/filters-tool.js';
import { harness, RECORD, typeAndSend } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const EDGE = edge('a', 'rel-1', 'ent-1', 'ent-2');
const overviewOf = (text = 'ent-1 and ent-2 are linked.'): Extract<AssistantTurnAnswer, { route: 'refuse' }> => ({
  status: 'answered',
  route: 'refuse',
  cause: 'verdict',
  sentence: ASSISTANT_REFUSAL_SENTENCES.verdict,
  overview: {
    sentences: [{ text, cites: ['n1', 'n2', 'e1'] }, { text: 'ent-2 has one relationship.', cites: ['n2'] }],
    citations: [{ key: 'n1', kind: 'entity', ref: A }, { key: 'n2', kind: 'entity', ref: B }, { key: 'e1', kind: 'relationship', ref: EDGE.ref }],
    coverage: { retrieval: '2 shown · ~38 not yet retrieved (estimated)', summary: 'The overview cites 3 of the 3 shown elements.' },
    model: 'stub-model',
  },
});
const PLAIN: AssistantTurnAnswer = { status: 'answered', route: 'refuse', cause: 'verdict', sentence: ASSISTANT_REFUSAL_SENTENCES.verdict };

function setup(answer: AssistantTurnAnswer) {
  const h = harness(async () => ({ ok: true, value: answer }), 1000, undefined, true);
  registerFiltersTool(h.tools, h.state);
  const result = { sourceId: 'a', nodes: [node('a', 'ent-1'), node('a', 'ent-2')], edges: [EDGE] };
  h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A, B], edgeRefs: [EDGE.ref] }, [{ key: key('a'), result }]);
  const actions = createAiActions();
  actions.register('summarize', () => undefined);
  render(<AiActionsProvider value={actions}>{h.tree()}</AiActionsProvider>);
  return h;
}
const before = (first: Node, second: Node): boolean => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('the refusal of a verdict with an overview', () => {
  it('shows the refusal, then what the investigation connects with its tags, cited sentences and coverage, then the line that it is no assessment, then the chips', async () => {
    setup(overviewOf());
    await typeAndSend('is this customer laundering money?');
    const title = await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered });
    const sentence = screen.getByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    const heading = screen.getByRole('heading', { name: ASSISTANT_COPY.overviewHeading });
    const drafted = screen.getByText(ASSISTANT_COPY.drafted);
    expect(screen.getByText('Model: stub-model')).toBeTruthy();
    const first = screen.getByText('ent-1 and ent-2 are linked.');
    const coverage = screen.getByText('2 shown · ~38 not yet retrieved (estimated)');
    expect(screen.getByText('The overview cites 3 of the 3 shown elements.')).toBeTruthy();
    const note = screen.getByText(ASSISTANT_COPY.overviewNote);
    const filters = screen.getByRole('button', { name: ASSISTANT_COPY.openFilters });
    const summarize = screen.getByRole('button', { name: ASSISTANT_COPY.summarizeView });
    const order = [title, sentence, heading, drafted, first, coverage, note, filters, summarize];
    for (let index = 1; index < order.length; index += 1) expect(before(need(order[index - 1]), need(order[index])), `${index}`).toBe(true);
    expect(screen.getAllByRole('button', { name: /^Citation \d+, ent-2,/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Sources · /)).toBeNull();
    expect(Array.from(first.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['[1]', '[2]', '[3]']);
  });

  it('selects a drawn element from a citation, and says why one that is hidden cannot be selected, as the view answer does', async () => {
    const h = setup(overviewOf());
    await typeAndSend('is this customer laundering money?');
    await userEvent.click(need((await screen.findAllByRole('button', { name: /^Citation \d+, ent-1,/ }))[0]));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
    act(() => h.state.hide([elementKey(B)]));
    await userEvent.click(need(screen.getAllByRole('button', { name: /^Citation \d+, ent-2,/ })[0]));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
  });

  it('shows markup in a sentence as text', async () => {
    setup(overviewOf('<img src=x onerror=alert(1)> and <b>ent-2</b> are linked.'));
    await typeAndSend('is this customer laundering money?');
    expect(await screen.findByText('<img src=x onerror=alert(1)> and <b>ent-2</b> are linked.')).toBeTruthy();
    expect(document.querySelector('.assistant-overview img, .assistant-overview b')).toBeNull();
  });

  it('is today’s card for a refusal without an overview: the title, the sentence and the chips, with no heading, tags, coverage or note', async () => {
    setup(PLAIN);
    await typeAndSend('is this customer laundering money?');
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered })).toBeTruthy();
    expect(screen.getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.openFilters })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.overviewHeading })).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.drafted)).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.overviewNote)).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.coverage)).toBeNull();
  });
});
