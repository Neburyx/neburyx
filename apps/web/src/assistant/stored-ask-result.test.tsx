import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantThreadResponse, GraphNode, ReadAskResult, ReadRefsResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { edge, node as baseNode, ref } from '../state/test-data.js';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { harness, REFUSE, type ReadRefsCall } from './assistant-kit.js';
import { ASK_COPY, pathCapText } from '../ask/copy.js';
import { ASSISTANT_COPY, listedText, noticeKeptOf, linesNotKept, noticeEntriesNotKept, pathsNotKept, rowsNotKept } from './copy.js';

afterEach(cleanup);

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const EDGE = edge('a', 'rel-1', 'ent-1', 'ent-2');
const titled = (id: string, title: string): GraphNode => ({ ...baseNode('a', id), display: { title, type: 'type-a' } });
const read = (nodes: GraphNode[], edges = [EDGE], missing: ReadRefsResponse['missing'] = { entities: [], edges: [] }): ApiResult<ReadRefsResponse> => ok({ nodes, edges, missing });
const empty = { values: [], lines: [], rows: [], paths: [], notices: [], noticeTotals: [], omitted: { rows: 0, paths: 0, lines: 0, noticeEntries: 0 } };
const block = (over: Partial<ReadAskResult>): ReadAskResult => ({ kind: 'ask-result', templateId: 'file-query', outcome: 'complete', ...empty, ...over }) as ReadAskResult;
const thread = (result: ReadAskResult, over: Record<string, unknown> = {}): AssistantThreadResponse => ({
  turns: [{ id: '0192f000-0000-7000-8000-000000000001', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', citedElements: 0, steps: 0, intent: 'find_accounts', question: 'Find them', answer: { blocks: [result] }, ...over } as AssistantThreadResponse['turns'][number]],
  earlierTurns: 0,
  previousThreadClearedAt: null,
});
const exact = (value: number) => ({ value, quality: 'exact' as const, scope: 's' });
function open(response: AssistantThreadResponse, refs: ReadRefsCall = async () => read([])) {
  const h = harness(async () => ok(REFUSE), 1000, async () => ok(response), false, refs);
  const stop = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
  render(h.tree());
  return { ...h, stop };
}
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

describe('the stored result of an Ask answer in the panel', () => {
  it('draws the label, the values the person typed, the count with its quality word and the rows read by reference, a relationship by the titles of its ends', async () => {
    const h = open(thread(block({ label: 'Find accounts', values: [{ name: 'widget', text: 'typed text' }], count: { count: exact(2), noun: 'row' }, listed: 2, rows: [{ form: 'ref', ref: EDGE.ref }, { form: 'ref', ref: A }] })), async () => read([titled('ent-1', 'Account One'), titled('ent-2', 'Account Two')]));
    expect(await screen.findByText('Find accounts')).toBeTruthy();
    expect(screen.getByText('typed text')).toBeTruthy();
    expect(screen.getByText(/2 rows/)).toBeTruthy();
    expect(screen.getByText('Exact')).toBeTruthy();
    expect(await screen.findByText('Account One → rel-a → Account Two')).toBeTruthy();
    expect(screen.getByText('Account One')).toBeTruthy();
    expect(h.askedRefs.map((request) => [request.entities.length, request.edges.length])).toEqual([[1, 0], [0, 1], [1, 0]].slice(0, h.askedRefs.length));
    h.stop();
  });

  it('draws an element that cannot be read as not available, and no identifier in its place', async () => {
    const h = open(thread(block({ rows: [{ form: 'ref', ref: A }] })), async () => read([], [], { entities: [A], edges: [] }));
    expect(await screen.findByText(ASSISTANT_COPY.valueUnavailable)).toBeTruthy();
    expect(document.body.textContent).not.toContain('ent-1');
    h.stop();
  });

  it('draws the rows a result written with the mask on kept, as the masked text it was written as, makes no read, and never shows a title in clear whatever the mask is now', async () => {
    const response = thread(block({ rows: [{ form: 'frozen', text: 'J••• L••• → rel-a → A•••' }] }));
    const h = open(response, async () => read([titled('ent-1', 'SENTINEL-CLEAR')]));
    expect(await screen.findByText('J••• L••• → rel-a → A•••')).toBeTruthy();
    act(() => h.state.setMask(false));
    act(() => h.state.setMask(true));
    act(() => h.state.setMask(false));
    expect(await screen.findByText('J••• L••• → rel-a → A•••')).toBeTruthy();
    expect(document.body.textContent).not.toContain('SENTINEL-CLEAR');
    expect(h.askedRefs).toEqual([]);
    h.stop();
  });

  it.each([
    [{ value: 3, quality: 'exact', scope: 's' }, 'Exact', /3 matches/],
    [{ value: 3, quality: 'estimated', scope: 's' }, 'Estimated', /~ 3 matches/],
    [{ value: 3, quality: 'lowerBound', scope: 's' }, 'Lower bound', /≥ 3 matches/],
    [{ quality: 'unknown', scope: 's' }, 'Unknown', /No count/],
  ] as const)('draws a count of quality %j with its quality word, and a count only result with no row', async (count, word, figure) => {
    const h = open(thread(block({ templateId: 'shared-attribute', count: { count: count as never, noun: 'match' }, listed: 3 })), async () => read([]));
    expect(await screen.findByText(figure)).toBeTruthy();
    expect(screen.getByText(word)).toBeTruthy();
    expect(h.askedRefs).toEqual([]);
    h.stop();
  });

  it('draws the count lines of a degree preview and an expansion, the entity line by its title, and the notices as the live card writes them', async () => {
    const h = open(thread(block({ templateId: 'expand', lines: [{ label: 'type-b', count: exact(7), shown: 3, more: true }, { label: 'Relationships', count: exact(9) }, { label: 'Entity', item: { form: 'ref', ref: A } }], notices: [{ code: 'noStopList' }] })), async () => read([titled('ent-1', 'Account One')], []));
    expect(await screen.findByText('3 shown · 7 · exact · more on the next page')).toBeTruthy();
    expect(screen.getByText('9 · exact')).toBeTruthy();
    expect(await screen.findByText('Account One')).toBeTruthy();
    expect(document.querySelectorAll('.ask-notice').length).toBe(1);
    h.stop();
  });

  it('draws a path by the titles of its ends, the cut of a search that timed out and the limit that was reached, apart from what the thread did not keep', async () => {
    const step = { relationshipType: 'rel-a', from: { form: 'ref' as const, ref: A }, to: { form: 'ref' as const, ref: B } };
    const h = open(thread(block({ templateId: 'shortest-paths', outcome: 'partial', paths: [{ hops: 1, steps: [step] }], lines: [{ label: 'Paths', shown: 1 }], pathCut: { capReached: false, partial: true, retained: 1, requested: 5 }, omitted: { rows: 0, paths: 2, lines: 0, noticeEntries: 0 } })), async () => read([titled('ent-1', 'Account One'), titled('ent-2', 'Account Two')], []));
    expect(await screen.findByText('Account One → Account Two')).toBeTruthy();
    expect(screen.getByText('Path 1 · 1 hop')).toBeTruthy();
    expect(screen.getByText(/1 of 5 requested paths retained/)).toBeTruthy();
    expect(screen.getByText(pathsNotKept(2))).toBeTruthy();
    expect(screen.getByText('1 found')).toBeTruthy();
    h.stop();
  });

  it('says how many are listed when that differs from the count, keeps the quality word of a heavy stop beside the stop, says the notice lists only some of the entries the source gave, and takes the cap of paths from what the search returned', async () => {
    const h = open(thread(block({ templateId: 'shared-attribute', count: { count: exact(500), noun: 'match' }, listed: 25, notices: [{ code: 'windowNotApplied', relationshipTypes: ['T1'] }, { code: 'supernodesSkipped', entities: [A] }], noticeTotals: [{ code: 'windowNotApplied', total: 30 }, { code: 'supernodesSkipped', total: 40 }] })));
    expect(await screen.findByText(listedText(25))).toBeTruthy();
    const notices = [...document.querySelectorAll('.ask-notice')];
    expect(notices).toHaveLength(2);
    expect(notices[0]?.textContent).toContain(noticeKeptOf(30));
    expect(notices[1]?.textContent).toContain(noticeKeptOf(40));
    expect(notices[0]?.textContent).not.toContain(noticeKeptOf(40));
    h.stop();
    cleanup();
    const heavy = open(thread(block({ templateId: 'shared-attribute', stop: { estimate: { value: 500, quality: 'lowerBound', scope: 's' }, threshold: 500 } })));
    expect(await screen.findByText('Lower bound')).toBeTruthy();
    expect(screen.getByText(ASK_COPY.stopped)).toBeTruthy();
    heavy.stop();
    cleanup();
    const capped = open(thread(block({ templateId: 'shortest-paths', outcome: 'partial', paths: [], lines: [{ label: 'Paths', shown: 25 }], pathCut: { capReached: true, partial: false }, omitted: { rows: 0, paths: 20, lines: 0, noticeEntries: 0 } })));
    expect(await screen.findByText(pathCapText(25))).toBeTruthy();
    capped.stop();
  });

  it('shows the masking line in place of a frozen row a read withheld, keeps the counts and the typed values, and makes no read for it', async () => {
    const h = open(thread(block({ count: { count: exact(2), noun: 'row' }, values: [{ name: 'widget', text: 'typed text' }], rows: [{ form: 'withheld' }], lines: [{ label: 'Entity', item: { form: 'withheld' } }] })));
    expect(await screen.findAllByText(ASSISTANT_COPY.storedWithheld)).toHaveLength(2);
    expect(screen.getByText('typed text')).toBeTruthy();
    expect(screen.getByText(/2 rows/)).toBeTruthy();
    expect(h.askedRefs).toEqual([]);
    h.stop();
  });

  it('says each unit of what the thread did not keep in its own words', async () => {
    const h = open(thread(block({ omitted: { rows: 5, paths: 1, lines: 2, noticeEntries: 3 } })));
    expect(await screen.findByText(rowsNotKept(5))).toBeTruthy();
    expect(screen.getByText(pathsNotKept(1))).toBeTruthy();
    expect(screen.getByText(linesNotKept(2))).toBeTruthy();
    expect(screen.getByText(noticeEntriesNotKept(3))).toBeTruthy();
    h.stop();
  });

  it('draws a heavy stop with its estimate and no way to continue, and shows a turn with no block as it showed it before', async () => {
    const h = open(thread(block({ templateId: 'shared-attribute', stop: { estimate: { value: 500, quality: 'lowerBound', scope: 's' }, threshold: 500 } })));
    expect(await screen.findByText(/≥ 500 matches/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
    h.stop();
    cleanup();
    const old = open({ turns: [{ id: '0192f000-0000-7000-8000-000000000001', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 3, steps: 1 }], earlierTurns: 0, previousThreadClearedAt: null });
    expect(await screen.findByText('shared-devices')).toBeTruthy();
    old.stop();
  });

  it('keeps the counts and shows the rows of a failed read as not available, with a way to read them again, and reads again under the new mask when the switch changes, dropping a late answer of the old one', async () => {
    const late = deferred<ApiResult<ReadRefsResponse>>();
    let calls = 0;
    const h = open(thread(block({ count: { count: exact(1), noun: 'row' }, rows: [{ form: 'ref', ref: A }] })), (request) => {
      calls += 1;
      if (calls === 1) return late.promise;
      return Promise.resolve(read([titled('ent-1', request.mask === true ? 'J••• L•••' : 'Account One')], []));
    });
    await screen.findByText(ASSISTANT_COPY.valuesLoading);
    act(() => h.state.setMask(true));
    await act(async () => late.resolve(read([titled('ent-1', 'SENTINEL-OLD')], [])));
    expect(await screen.findByText('J••• L•••')).toBeTruthy();
    expect(document.body.textContent).not.toContain('SENTINEL-OLD');
    expect(h.askedRefs.map((request) => request.mask === true)).toEqual([false, true]);
    h.stop();
  });

  it('shows a failed read with the counts kept and the rows not available, and reads again alone on a try again', async () => {
    let calls = 0;
    const h = open(thread(block({ count: { count: exact(1), noun: 'row' }, rows: [{ form: 'ref', ref: A }] })), async () => (calls++ === 0 ? { ok: false as const, failure: { code: 'INTERNAL_ERROR' as const, message: 'no', retryable: true, traceId: 'tr-1' } } : read([titled('ent-1', 'Account One')], [])));
    expect(await screen.findByText(ASSISTANT_COPY.valuesFailed)).toBeTruthy();
    expect(screen.getByText(/1 row/)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.valueUnavailable)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    expect(await screen.findByText('Account One')).toBeTruthy();
    expect(h.askedRefs).toHaveLength(2);
    h.stop();
  });

  it('reaches the retry by keyboard in the order of the card', async () => {
    const h = open(thread(block({ rows: [{ form: 'ref', ref: A }] })), async () => ({ ok: false as const, failure: { code: 'INTERNAL_ERROR' as const, message: 'no', retryable: true, traceId: 'tr-1' } }));
    const retry = await screen.findByRole('button', { name: ASSISTANT_COPY.tryAgain });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    expect(within(document.body).getAllByRole('button').includes(retry)).toBe(true);
    h.stop();
  });
});

