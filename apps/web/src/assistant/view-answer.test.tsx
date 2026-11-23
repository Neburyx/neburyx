import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSISTANT_REFUSAL_SENTENCES, type AssistantTurnAnswer } from '@neburyx/contracts';
import { edge, key, node, ref } from '../state/test-data.js';
import { need } from '../test-utils.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { harness, RECORD, REFUSE, typeAndSend } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const EDGE = edge('a', 'rel-1', 'ent-1', 'ent-2');
const ANSWER: AssistantTurnAnswer = {
  status: 'answered',
  route: 'view',
  sentences: [
    { text: 'ent-1 and ent-2 are linked.', cites: ['n1', 'n2'] },
    { text: 'ent-2 has one relationship.', cites: ['e1', 'n2'] },
  ],
  citations: [
    { key: 'n1', kind: 'entity', ref: A },
    { key: 'n2', kind: 'entity', ref: B },
    { key: 'e1', kind: 'relationship', ref: EDGE.ref },
  ],
  coverage: { retrieval: '2 shown · ~38 not yet retrieved (estimated)', summary: 'The draft cites 3 of the 3 shown elements.' },
  model: 'stub-model',
  calls: 2,
};
const ok = (value: AssistantTurnAnswer) => ({ ok: true as const, value });

function shown(h: ReturnType<typeof harness>): void {
  const result = { sourceId: 'a', nodes: [node('a', 'ent-1'), node('a', 'ent-2')], edges: [EDGE] };
  h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A, B], edgeRefs: [EDGE.ref] }, [{ key: key('a'), result }]);
}

describe('the Assistant panel: an answer from the view', () => {
  it('shows the tags, each sentence with numbered markers, the sources and the two lines the server wrote', async () => {
    const h = harness(async () => ok(ANSWER));
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    expect(await screen.findByText('AI-drafted')).toBeTruthy();
    expect(screen.getByText('Model: stub-model')).toBeTruthy();
    expect(screen.getByText('ent-1 and ent-2 are linked.')).toBeTruthy();
    expect(screen.getByText('Sources · 3')).toBeTruthy();
    expect(screen.getByText('2 shown · ~38 not yet retrieved (estimated)')).toBeTruthy();
    expect(screen.getByText('The draft cites 3 of the 3 shown elements.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Citation \d+, ent-2,/ }).length).toBeGreaterThan(0);
    expect(h.sent[0]?.viewElementKeys).toEqual(expect.arrayContaining([elementKey(A), elementKey(B)]));
  });

  it('selects a drawn element from a marker and says why a hidden one cannot be selected', async () => {
    const h = harness(async () => ok(ANSWER));
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    await userEvent.click(need((await screen.findAllByRole('button', { name: /^Citation \d+, ent-1,/ }))[0]));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
    act(() => h.state.hide([elementKey(B)]));
    await userEvent.click(need(screen.getAllByRole('button', { name: /^Citation \d+, ent-2,/ })[0]));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
    expect(screen.getAllByText('Outside the current view').length).toBeGreaterThan(0);
  });

  it('keeps the other cases as they were: a refusal still shows its fixed sentence', async () => {
    const h = harness(async () => ok(REFUSE));
    shown(h);
    render(h.tree());
    await typeAndSend('is this fraud?');
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    expect(screen.queryByText('AI-drafted')).toBeNull();
  });

  it('keeps the answer when the panel is closed and opened again in the same session', async () => {
    const h = harness(async () => ok(ANSWER));
    shown(h);
    const view = render(h.tree());
    await typeAndSend('what is linked?');
    await screen.findByText('AI-drafted');
    view.rerender(h.tree(false));
    view.rerender(h.tree(true));
    expect(await screen.findByText('Sources · 3')).toBeTruthy();
  });

  it('drops an answer that arrives after the thread was cleared and shows one that arrives with no clearing before it', async () => {
    let release: () => void = () => undefined;
    const h = harness(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok(ANSWER));
        }),
    );
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    act(() => h.session.clear({}));
    await act(async () => release());
    expect(screen.queryByText('AI-drafted')).toBeNull();
    await typeAndSend('and now?');
    await act(async () => release());
    expect(await screen.findByText('AI-drafted')).toBeTruthy();
  });

  function bound(turn: Parameters<typeof harness>[0]) {
    const h = harness(turn);
    shown(h);
    return { ...h, stop: bindAssistantPanel(h.state, createPanelRegistry(), h.session) };
  }

  it('clears the answer when the masking changes and drops the late answer of a request sent before', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const h = bound(() => (++calls === 1 ? Promise.resolve(ok(ANSWER)) : new Promise((resolve) => void (release = () => resolve(ok(ANSWER))))));
    render(h.tree());
    await typeAndSend('what is linked?');
    await screen.findByText('AI-drafted');
    await typeAndSend('and again?');
    act(() => h.state.setMask(true));
    expect(screen.queryByText('AI-drafted')).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.maskingTitle)).toBeTruthy();
    await act(async () => release());
    expect(screen.queryByText('AI-drafted')).toBeNull();
    h.stop();
  });

  it('clears the answer when the source has changed and when another investigation is shown', async () => {
    const h = bound(async () => ok(ANSWER));
    render(h.tree());
    await typeAndSend('what is linked?');
    await screen.findByText('AI-drafted');
    act(() => h.state.describeInvestigation({ ...RECORD, sourceState: 'removed' }));
    expect(screen.queryByText('AI-drafted')).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.sourceChanged)).toBeTruthy();
    h.stop();
    const other = bound(async () => ok(ANSWER));
    cleanup();
    render(other.tree());
    await typeAndSend('what is linked?');
    await screen.findByText('AI-drafted');
    act(() => other.state.show({ id: 'inv-9', sourceId: 'a', record: RECORD, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []));
    expect(screen.queryByText('AI-drafted')).toBeNull();
    other.stop();
  });

  it('clears the answer when a turn is refused because the access is lost, and when another person opens the panel', async () => {
    let calls = 0;
    const h = harness(async () => (++calls === 1 ? ok(ANSWER) : { ok: false, failure: { code: 'NOT_FOUND', message: 'x', retryable: false, traceId: 't' } }));
    shown(h);
    const view = render(h.tree());
    await typeAndSend('what is linked?');
    await screen.findByText('AI-drafted');
    await typeAndSend('again');
    expect(await screen.findByText(ASSISTANT_COPY.accessLost)).toBeTruthy();
    expect(screen.queryByText('AI-drafted')).toBeNull();
    const another = harness(async () => ok(ANSWER));
    shown(another);
    view.unmount();
    const second = render(another.tree());
    await typeAndSend('what is linked?');
    await screen.findByText('AI-drafted');
    second.rerender(another.tree(false));
    another.session.store.setState({ ...another.session.store.getState(), principalId: 'someone-else' });
    second.rerender(another.tree(true));
    expect(screen.queryByText('AI-drafted')).toBeNull();
  });

  it('moves focus to the new turn, operates a marker by keyboard and says an element that is not on the graph any more is gone', async () => {
    const h = harness(async () => ok(ANSWER));
    h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A], edgeRefs: [] }, [{ key: key('a'), result: { sourceId: 'a', nodes: [node('a', 'ent-1')], edges: [] } }]);
    render(h.tree());
    await typeAndSend('what is linked?');
    const heading = await screen.findByRole('heading', { name: 'Answer from the view' });
    await act(async () => undefined);
    expect(document.activeElement).toBe(heading);
    const marker = need(screen.getAllByRole('button', { name: /^Citation \d+, ent-1,/ })[0]);
    marker.focus();
    await userEvent.keyboard('{Enter}');
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
    await userEvent.click(need(screen.getAllByRole('button', { name: /^Citation \d+, Entity n2, no longer on the graph/ })[0]));
    expect(screen.getAllByText('No longer on the graph').length).toBeGreaterThan(0);
  });

  it('names the action of each source in its accessible name and shows a status in words only when the element cannot be selected', async () => {
    const h = harness(async () => ok(ANSWER));
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    await userEvent.click(await screen.findByRole('button', { name: 'Sources · 3' }));
    expect(screen.getAllByRole('button', { name: /^Sources: \d+, .*\. Select on graph$/ })).toHaveLength(3);
    expect(screen.queryByText('Select on graph')).toBeNull();
  });

  it.each([
    [false, 'The assistant’s service took too long. Nothing was asked and nothing was read.'],
    [true, 'The read took too long and was stopped. It may have started.'],
  ])('says in words whether a read had started when the time of a view turn was spent (readStarted %s)', async (readStarted, words) => {
    const h = harness(async () => ok({ status: 'unavailable', kind: 'timeout', readStarted }));
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    expect(await screen.findByText(words)).toBeTruthy();
  });
});

describe('the Assistant panel: what a type means', () => {
  const MEANING = { key: 'm1', kind: 'description' as const, typeKind: 'entity' as const, type: 'Widget', description: 'A widget that <script>holds</script> a balance, in a_very_long_word_'.concat('x'.repeat(120)) };
  const WITH_MEANING: AssistantTurnAnswer = {
    ...ANSWER,
    sentences: [{ text: 'A widget holds a balance.', cites: ['m1'] }, { text: 'ent-2 has one relationship.', cites: ['n2'] }],
    citations: [{ key: 'n2', kind: 'entity', ref: B }, MEANING],
    noDescription: 'The mapping has no description for Gizmo, so I cannot say what it means.',
  };

  it('shows an About chip that opens the operator description as text, marks it, and selects nothing', async () => {
    const h = harness(async () => ok(WITH_MEANING));
    shown(h);
    render(h.tree());
    await typeAndSend('what is a widget?');
    const chip = await screen.findByRole('button', { name: /^About Widget:/ });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(ASSISTANT_COPY.operatorDescription)).toBeNull();
    await userEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(ASSISTANT_COPY.operatorDescription)).toBeTruthy();
    // markup in a description is text, and a very long word stays inside the panel's text
    expect(screen.getByText(MEANING.description)).toBeTruthy();
    expect(document.querySelector('.assistant-description script')).toBeNull();
    expect([...h.state.presentation.view.getState().selection]).toEqual([]);
    expect(screen.getByText('The mapping has no description for Gizmo, so I cannot say what it means.')).toBeTruthy();
    // the sources list holds elements only
    expect(screen.getByText('Sources · 1')).toBeTruthy();
  });

  it('shows the answer no-description as a plain card: the fixed sentence, no AI-drafted tag and no sources', async () => {
    const sentence = 'The mapping has no description for Gizmo, so I cannot say what it means.';
    const h = harness(async () => ok({ status: 'no-description', route: 'view', sentence, names: ['Gizmo'] }));
    shown(h);
    render(h.tree());
    await typeAndSend('what is a gizmo?');
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(screen.getByText('what is a gizmo?')).toBeTruthy();
    expect(screen.queryByText('AI-drafted')).toBeNull();
    expect(screen.queryByText(/^Sources/)).toBeNull();
  });

  it('shows the answer meaning as the operator text with its mark and the fixed sentence: no AI-drafted tag, no sources, markup as text', async () => {
    const description = 'A widget <script>holds</script> parts, in a_very_long_word_'.concat('x'.repeat(120));
    const sentence = 'The mapping has no description for Gizmo, so I cannot say what it means.';
    const h = harness(async () => ok({ status: 'meaning', described: [{ typeKind: 'entity', type: 'Widget', description }], noDescription: { sentence, names: ['Gizmo'] } }));
    shown(h);
    render(h.tree());
    await typeAndSend('what are a widget and a gizmo?');
    expect(await screen.findByText('About Widget')).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.operatorDescription)).toBeTruthy();
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(screen.queryByText('AI-drafted')).toBeNull();
    expect(screen.queryByText(/^Sources/)).toBeNull();
    expect(document.querySelector('.assistant-meaning script')).toBeNull();
  });
});


describe('the Assistant panel: markers and the Sources control', () => {
  const SOURCES = /^Sources · \d+/;

  async function answered(answer: AssistantTurnAnswer = ANSWER) {
    const h = harness(async () => ok(answer));
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    await screen.findByText('AI-drafted');
    return h;
  }

  it('draws number-only markers inside the sentence, in the number of the list', async () => {
    await answered();
    const sentence = need(screen.getByText('ent-1 and ent-2 are linked.'));
    const markers = Array.from(sentence.querySelectorAll('button')).map((button) => button.textContent);
    expect(markers).toEqual(['[1]', '[2]']);
    expect(Array.from(need(screen.getByText('ent-2 has one relationship.')).querySelectorAll('button')).map((button) => button.textContent)).toEqual(['[3]', '[2]']);
    await userEvent.click(screen.getByRole('button', { name: SOURCES }));
    const rows = screen.getAllByRole('button', { name: /^Sources: / }).map((row) => row.querySelector('.assistant-marker')?.textContent);
    expect(rows).toEqual(['[1]', '[2]', '[3]']);
  });

  it('keeps the list closed by default, opens it and closes it with the control following aria-expanded, and leaves the answer text as it was', async () => {
    await answered();
    const control = screen.getByRole('button', { name: SOURCES });
    const textOf = () => document.querySelector('.assistant-view-answer')?.textContent ?? '';
    const withoutList = (text: string) => text.replace(document.querySelector('.assistant-sources')?.textContent ?? '', '');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /^Sources: / })).toBeNull();
    const closed = withoutList(textOf());
    await userEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('3 sources')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Sources: / }).length).toBe(3);
    expect(withoutList(textOf())).toBe(closed);
    await userEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /^Sources: / })).toBeNull();
  });

  it('selects a drawn element from its row and says why one outside the view or gone is not selected', async () => {
    const h = harness(async () => ok(ANSWER));
    h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A], edgeRefs: [] }, [{ key: key('a'), result: { sourceId: 'a', nodes: [node('a', 'ent-1')], edges: [] } }]);
    render(h.tree());
    await typeAndSend('what is linked?');
    await userEvent.click(await screen.findByRole('button', { name: SOURCES }));
    await userEvent.click(need(screen.getAllByRole('button', { name: /^Sources: \d+, ent-1/ })[0]));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
    await userEvent.click(need(screen.getAllByRole('button', { name: /^Sources: \d+, Entity n2/ })[0]));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
    expect(screen.getAllByText('No longer on the graph').length).toBeGreaterThan(0);
  });

  it('draws no marker for a cited key that has no entry, and no Sources control for an answer that cites nothing', async () => {
    await answered({ ...ANSWER, sentences: [{ text: 'Nothing here is cited.', cites: [] }, { text: 'One is.', cites: ['n1', 'unknown'] }], citations: [{ key: 'n1', kind: 'entity', ref: A }] });
    expect(Array.from(need(screen.getByText('One is.')).querySelectorAll('button')).map((button) => button.textContent)).toEqual(['[1]']);
    expect(need(screen.getByText('Nothing here is cited.')).querySelector('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sources · 1' })).toBeTruthy();
  });

  it('shows no marker and no Sources control for an answer in which no sentence cites anything', async () => {
    await answered({ ...ANSWER, sentences: [{ text: 'Nothing here is cited.', cites: [] }], citations: [] });
    expect(screen.getByText('Nothing here is cited.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Citation / })).toBeNull();
    expect(screen.queryByRole('button', { name: SOURCES })).toBeNull();
  });

  it('keeps the description of a relationship type usable, with no number, a marker or a Sources control', async () => {
    const meaning = { key: 'm1', kind: 'description' as const, typeKind: 'relationship' as const, type: 'LINK', description: 'A link between two things.' };
    await answered({ ...ANSWER, sentences: [{ text: 'A link joins two things.', cites: ['m1'] }], citations: [meaning] });
    const chip = screen.getByRole('button', { name: /^About LINK:/ });
    await userEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('A link between two things.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Citation / })).toBeNull();
    expect(screen.queryByRole('button', { name: SOURCES })).toBeNull();
  });

  it('names a row by its number, its label and its status', async () => {
    await answered();
    await userEvent.click(screen.getByRole('button', { name: SOURCES }));
    expect(screen.getAllByRole('button', { name: /^Sources: \d+, .*\. Select on graph$/ }).map((row) => row.getAttribute('aria-label')?.split(',')[0])).toEqual(['Sources: 1', 'Sources: 2', 'Sources: 3']);
  });

  it('shows the descriptions of types without a number, a marker or a Sources control', async () => {
    const meaning = { key: 'm1', kind: 'description' as const, typeKind: 'entity' as const, type: 'Widget', description: 'A widget.' };
    await answered({ ...ANSWER, sentences: [{ text: 'A widget holds a balance.', cites: ['m1'] }], citations: [meaning] });
    expect(screen.getByRole('button', { name: /^About Widget:/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Citation / })).toBeNull();
    expect(screen.queryByRole('button', { name: SOURCES })).toBeNull();
  });

  it('opens the list folded again when the answer is drawn again', async () => {
    const h = await answered();
    await userEvent.click(screen.getByRole('button', { name: SOURCES }));
    await typeAndSend('and again?');
    await act(async () => undefined);
    expect(h.sent.length).toBe(2);
    const controls = screen.getAllByRole('button', { name: SOURCES });
    expect(controls.at(-1)?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the Assistant panel: repeated shapes in the Sources list', () => {
  const TXNS = Array.from({ length: 25 }, (_, index) => `tx-${index + 1}`);
  const link = (stableId: string, from: string, to: string, type: string) => ({ ...edge('a', stableId, from, to), type, ref: { sourceId: 'a', type, from: 'type-a', to: 'type-a', stableId } });
  const OWNS = link('own-1', 'acc-1', 'cu-1', 'OWNS');
  const HELD = link('held-1', 'acc-1', 'bk-1', 'HELD_AT');
  const RECEIVED = TXNS.map((id) => link(`rec-${id}`, id, 'acc-1', 'RECEIVED_BY'));
  const EDGES = [OWNS, HELD, ...RECEIVED];
  const GROUPED: AssistantTurnAnswer = {
    ...ANSWER,
    sentences: [
      { text: 'The account is owned and held.', cites: ['own-1', 'held-1'] },
      { text: '25 transactions were received.', cites: RECEIVED.map((held) => held.ref.stableId) },
    ],
    citations: EDGES.map((held) => ({ key: held.ref.stableId, kind: 'relationship' as const, ref: held.ref })),
  };

  async function openList() {
    const h = harness(async () => ok(GROUPED));
    const nodes = ['acc-1', 'cu-1', 'bk-1', ...TXNS].map((id) => node('a', id));
    h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: nodes.map((held) => held.ref), edgeRefs: EDGES.map((held) => held.ref) }, [{ key: key('a'), result: { sourceId: 'a', nodes, edges: EDGES } }]);
    render(h.tree());
    await typeAndSend('what is linked?');
    await userEvent.click(await screen.findByRole('button', { name: 'Sources · 27' }));
    return h;
  }

  it('shows two single rows and one folded group of 25 under the grouped title', async () => {
    await openList();
    expect(screen.getByText('27 sources, grouped by shape')).toBeTruthy();
    const group = screen.getByRole('button', { name: /^25 type-a → .*RECEIVED_BY, \[3–27\]$/ });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByRole('button', { name: /^Sources: / })).toHaveLength(2);
  });

  it('expands to five members and the count of the rest, shows all on request, and folds again', async () => {
    const h = await openList();
    const group = screen.getByRole('button', { name: /RECEIVED_BY, \[3–27\]$/ });
    await userEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('(hide)')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Sources: / })).toHaveLength(2 + 5);
    expect(screen.getByText('20 more in this group')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getAllByRole('button', { name: /^Sources: / })).toHaveLength(2 + 25);
    expect(screen.getByRole('button', { name: /^Sources: 4, tx-2 → / })).toBeTruthy();
    await userEvent.click(need(screen.getAllByRole('button', { name: /^Sources: \d+, tx-4/ })[0]));
    expect(h.state.presentation.view.getState().selection.size).toBe(1);
    await userEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByRole('button', { name: /^Sources: / })).toHaveLength(2);
  });

  it('draws the 25 citations of one sentence as one range marker that opens the list with focus on the group line', async () => {
    await openList();
    await userEvent.click(screen.getByRole('button', { name: 'Sources · 27' }));
    const sentence = need(screen.getByText('25 transactions were received.'));
    expect(Array.from(sentence.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['[3–27]']);
    await userEvent.click(need(sentence.querySelector('button')));
    const group = screen.getByRole('button', { name: /RECEIVED_BY, \[3–27\]$/ });
    expect(screen.getByRole('button', { name: 'Sources · 27' }).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(group);
  });

  it('opens a closed list from a range marker and puts focus on the row of the first number when the run is not grouped', async () => {
    const h = harness(async () => ok({ ...ANSWER, sentences: [{ text: 'Three are cited.', cites: ['n1', 'n2', 'e1'] }] }));
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    const marker = await screen.findByRole('button', { name: 'Citations 1 to 3: show in Sources' });
    expect(marker.textContent).toBe('[1–3]');
    await userEvent.click(marker);
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Sources: 1, /);
  });

  it('leaves focus on the Sources control when the list is closed and opened again after a range marker was pressed', async () => {
    const h = harness(async () => ok({ ...ANSWER, sentences: [{ text: 'Three are cited.', cites: ['n1', 'n2', 'e1'] }] }));
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    await userEvent.click(await screen.findByRole('button', { name: 'Citations 1 to 3: show in Sources' }));
    const control = screen.getByRole('button', { name: 'Sources · 3' });
    await userEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(control);
  });

  it('keeps a repeated citation inside a run apart: only the runs of three or more consecutive numbers fold', async () => {
    const h = harness(async () => ok({ ...ANSWER, sentences: [{ text: 'Mixed.', cites: ['n1', 'n2', 'e1', 'n1'] }] }));
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    await screen.findByText('Mixed.');
    expect(Array.from(need(screen.getByText('Mixed.')).querySelectorAll('button')).map((button) => button.textContent)).toEqual(['[1–3]', '[1]']);
  });

  it('opens folded again when the list is closed and opened', async () => {
    await openList();
    await userEvent.click(screen.getByRole('button', { name: /RECEIVED_BY, \[3–27\]$/ }));
    const control = screen.getByRole('button', { name: 'Sources · 27' });
    await userEvent.click(control);
    await userEvent.click(control);
    expect(screen.getByRole('button', { name: /RECEIVED_BY, \[3–27\]$/ }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the Assistant panel: the keyboard path of the answer sources', () => {
  it('reaches the markers, the Sources control and the rows in reading order, and opens and closes the list with Space and Enter', async () => {
    const h = harness(async () => ok(ANSWER));
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    const control = await screen.findByRole('button', { name: 'Sources · 3' });
    const markers = screen.getAllByRole('button', { name: /^Citation / });
    markers[0]?.focus();
    const order: (string | null)[] = [];
    for (let step = 0; step < markers.length; step += 1) {
      order.push(document.activeElement?.getAttribute('aria-label') ?? null);
      await userEvent.tab();
    }
    expect(order.every((name) => name?.startsWith('Citation '))).toBe(true);
    control.focus();
    await userEvent.keyboard(' ');
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(control);
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Sources: /);
    control.focus();
    await userEvent.keyboard('{Enter}');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(control);
  });

  it('moves focus to the first member that Show all brings in, since the control it was pressed on is gone', async () => {
    const edges = Array.from({ length: 8 }, (_, index) => ({ ...edge('a', `r-${index}`, `x-${index}`, 'ent-1'), type: 'SHARED' }));
    const answer: AssistantTurnAnswer = {
      ...ANSWER,
      sentences: [{ text: 'Eight are shared.', cites: edges.map((held) => edgeKey(held.ref)) }],
      citations: edges.map((held) => ({ key: edgeKey(held.ref), kind: 'relationship' as const, ref: held.ref })),
    };
    const h = harness(async () => ok(answer));
    const nodes = ['ent-1', ...edges.map((_, index) => `x-${index}`)].map((id) => node('a', id));
    h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: nodes.map((held) => held.ref), edgeRefs: edges.map((held) => held.ref) }, [{ key: key('a'), result: { sourceId: 'a', nodes, edges } }]);
    render(h.tree());
    await typeAndSend('what is shared?');
    await userEvent.click(await screen.findByRole('button', { name: 'Sources · 8' }));
    const group = screen.getByRole('button', { name: /SHARED, \[1–8\]$/ });
    group.focus();
    await userEvent.keyboard('{Enter}');
    expect(group.getAttribute('aria-expanded')).toBe('true');
    const showAll = screen.getByRole('button', { name: 'Show all' });
    showAll.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Sources: \d+, x-5/);
  });
});
