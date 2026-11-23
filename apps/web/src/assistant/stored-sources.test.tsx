import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantThreadResponse, ReadRefsResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { edge, key, node, ref, result } from '../state/test-data.js';
import { elementKey } from '../state/keys.js';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { harness, RECORD, REFUSE, type ReadRefsCall } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const failed = (): ApiResult<ReadRefsResponse> => ({ ok: false, failure: { code: 'INTERNAL_ERROR', message: 'no', retryable: true, traceId: 'tr-1' } });
const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const EDGE = edge('a', 'rel-1', 'ent-1', 'ent-2');
const STORED: AssistantThreadResponse = {
  turns: [{ id: '0192f000-0000-7000-8000-000000000001', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'view', outcome: 'answered', citedElements: 3, steps: 0, question: 'What links them?', answer: { blocks: [{ kind: 'sentences', items: [{ item: { state: 'text', text: 'They are linked.' }, cites: [A, B, EDGE.ref] }] }] } }],
  earlierTurns: 0,
  previousThreadClearedAt: null,
};
const read = (over: Partial<ReadRefsResponse> = {}): ApiResult<ReadRefsResponse> => ok({ nodes: [{ ...node('a', 'ent-1'), display: { title: 'Account One', type: 'type-a' } }, node('a', 'ent-2')], edges: [EDGE], missing: { entities: [], edges: [] }, ...over });
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

function open(refs: ReadRefsCall, drawn = false) {
  const h = harness(async () => ok(REFUSE), 1000, async () => ok(STORED), false, refs);
  if (drawn) h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A, B], edgeRefs: [EDGE.ref] }, [{ key: key('a'), result: result('a', ['ent-1', 'ent-2'], [['rel-1', 'ent-1', 'ent-2']]) }]);
  const stop = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
  render(h.tree());
  return { ...h, stop };
}
const toggle = async () => userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${ASSISTANT_COPY.sources} · 3`) }));

describe('the Sources of a stored answer, read by reference when they are opened', () => {
  it('shows the exact number of cited elements and reads nothing until the control is opened', async () => {
    const h = open(async () => read());
    await screen.findByText('They are linked.');
    expect(screen.getByRole('button', { name: `${ASSISTANT_COPY.sources} · 3` }).getAttribute('aria-expanded')).toBe('false');
    expect(h.askedRefs).toEqual([]);
    h.stop();
  });

  it('shows a loading state, then a row for each cited element with the label the current read gave it, and the relationship by its ends', async () => {
    const wait = deferred<ApiResult<ReadRefsResponse>>();
    const h = open(() => wait.promise);
    await toggle();
    expect(await screen.findByText(ASSISTANT_COPY.sourcesLoading)).toBeTruthy();
    await act(async () => wait.resolve(read()));
    const list = (await screen.findByText('Account One')).closest('ul, ol') as HTMLElement;
    expect(within(list).getByText('Account One')).toBeTruthy();
    expect(within(list).getByText('ent-2')).toBeTruthy();
    expect(within(list).getByText(/Account One → ent-2 · rel-a/)).toBeTruthy();
    expect(h.askedRefs.map((request) => [request.entities.length, request.edges.length])).toEqual([[2, 0], [0, 1]]);
    h.stop();
  });

  it('selects a cited element that is on the graph, and says why one that is not cannot be', async () => {
    const h = open(async () => read(), true);
    await toggle();
    const row = await screen.findByRole('button', { name: /^Sources: 1, Account One/ });
    expect(row.getAttribute('title')).toBe('Select on graph');
    await userEvent.click(row);
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
    h.stop();
    cleanup();
    const apart = open(async () => read());
    await toggle();
    await userEvent.click(await screen.findByRole('button', { name: /^Sources: 1, Account One/ }));
    expect(await screen.findByText('No longer on the graph', { selector: '.summary-note' })).toBeTruthy();
    apart.stop();
  });

  it('lists an element the read did not return as not available, which cannot be selected, and the rest of the list and the answer still show', async () => {
    const h = open(async () => read({ nodes: [node('a', 'ent-2')], edges: [], missing: { entities: [A], edges: [EDGE.ref] } }), true);
    await toggle();
    const row = await screen.findByRole('button', { name: /^Sources: 1, Not available/ });
    await userEvent.click(row);
    expect([...h.state.presentation.view.getState().selection]).toEqual([]);
    expect(screen.getByRole('button', { name: /^Sources: 2, ent-2/ })).toBeTruthy();
    expect(screen.getByText('They are linked.')).toBeTruthy();
    h.stop();
  });

  it('shows a failure with a way to try again and no list when the read fails, and reads only the failed read again', async () => {
    let calls = 0;
    const h = open(async () => {
      calls += 1;
      return calls === 2 ? failed() : read();
    });
    await toggle();
    expect(await screen.findByText(ASSISTANT_COPY.sourcesFailed)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Sources: 1/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    expect(await screen.findByRole('button', { name: /^Sources: 1, Account One/ })).toBeTruthy();
    expect(h.askedRefs).toHaveLength(3);
    expect(h.askedRefs[2]).toMatchObject({ entities: [], edges: [EDGE.ref] });
    h.stop();
  });

  it('keeps no label read under the old setting when the masking changes, and reads again under the new one when the control is opened again', async () => {
    const h = open(async (request) => read({ nodes: [{ ...node('a', 'ent-1'), display: { title: request.mask === true ? 'J••• L•••' : 'SENTINEL-TITLE', type: 'type-a' } }, node('a', 'ent-2')] }));
    await toggle();
    await screen.findByText('SENTINEL-TITLE');
    act(() => h.state.setMask(true));
    expect(document.body.textContent).not.toContain('SENTINEL-TITLE');
    await toggle();
    expect(await screen.findByText('J••• L•••')).toBeTruthy();
    expect(h.askedRefs.some((request) => request.mask === true)).toBe(true);
    expect(document.body.textContent).not.toContain('SENTINEL-TITLE');
    h.stop();
  });

  it('reads the list again each time the control is opened, so that a label that changed or an element that was removed since shows as it is now', async () => {
    let opening = 0;
    const h = open(async (request) => {
      if (request.entities.length === 0) return read({ nodes: [], edges: [] });
      opening += 1;
      return opening === 1 ? read() : read({ nodes: [node('a', 'ent-2')], edges: [], missing: { entities: [A], edges: [] } });
    }, true);
    await toggle();
    await screen.findByText('Account One');
    await toggle();
    await toggle();
    const row = await screen.findByRole('button', { name: /^Sources: 1, Not available/ });
    expect(row).toBeTruthy();
    expect(screen.queryByText('Account One')).toBeNull();
    expect(h.askedRefs.filter((request) => request.entities.length > 0).length).toBeGreaterThanOrEqual(2);
    h.stop();
  });

  it('reads the ends of a relationship that is cited alone and lists it by their titles as they are now, with its shape', async () => {
    const onlyEdge: AssistantThreadResponse = { ...STORED, turns: [{ ...STORED.turns[0], citedElements: 1, answer: { blocks: [{ kind: 'sentences', items: [{ item: { state: 'text', text: 'They are linked.' }, cites: [EDGE.ref] }] }] } } as AssistantThreadResponse['turns'][number]] };
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(onlyEdge), false, async (request) => {
      if (request.edges.length > 0) return ok({ nodes: [], edges: [EDGE], missing: { entities: [], edges: [] } });
      return ok({ nodes: [{ ...node('a', 'ent-1'), display: { title: 'Account One', type: 'type-a' } }, { ...node('a', 'ent-2'), display: { title: 'Account Two', type: 'type-a' } }], edges: [], missing: { entities: [], edges: [] } });
    });
    const stop = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
    render(h.tree());
    await userEvent.click(await screen.findByRole('button', { name: `${ASSISTANT_COPY.sources} · 1` }));
    expect(await screen.findByText(/Account One → Account Two · rel-a/)).toBeTruthy();
    expect(h.askedRefs.map((request) => [request.entities.length, request.edges.length])).toEqual([[0, 1], [2, 0]]);
    stop();
  });
});
