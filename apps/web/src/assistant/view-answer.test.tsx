import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantTurnAnswer } from '@neburyx/contracts';
import { edge, key, node, ref } from '../state/test-data.js';
import { need } from '../test-utils.js';
import { elementKey } from '../state/keys.js';
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
    { text: 'ent-1 and ent-2 are linked.', cites: ['n1', 'n2', 'e1'] },
    { text: 'ent-2 has one relationship.', cites: ['n2'] },
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
    expect(await screen.findByText(ASSISTANT_COPY.routeRefuse, { selector: 'p' })).toBeTruthy();
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
    expect(screen.getByText(ASSISTANT_COPY.maskingCleared)).toBeTruthy();
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

  it('shows the action of each source in words, not only in its name', async () => {
    const h = harness(async () => ok(ANSWER));
    shown(h);
    render(h.tree());
    await typeAndSend('what is linked?');
    await screen.findByText('Sources · 3');
    expect(screen.getAllByText('Select on graph').length).toBe(3);
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
