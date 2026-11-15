import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { SUMMARY_FAILURE_KINDS, type SummaryRequest, type SummaryResponse } from '@neburyx/contracts';
import { ApiClientProvider } from '../api/client-context.js';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { failure } from '../patterns/patterns-kit.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edge, key, node, ref } from '../state/test-data.js';
import { elementKey } from '../state/keys.js';
import { FAILURE_KIND_TEXT } from './copy.js';
import { SummaryPanel } from './summary-panel.js';
import { SummarySessionProvider, createSummarySession } from './summary-session.js';

afterEach(cleanup);

const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const EDGE = edge('a', 'rel-1', 'ent-1', 'ent-2');
const SENT = 'n1 type-a ent-1\n  odd   spacing\ne1 rel-a';

const draft = (over: Record<string, unknown> = {}): SummaryResponse =>
  ({
    status: 'ok',
    sentences: [
      { text: 'ent-1 and ent-2 are linked.', cites: ['e1', 'n1', 'n2'] },
      { text: 'ent-2 has one relationship.', cites: ['n2'] },
    ],
    citations: [
      { key: 'n1', kind: 'entity', ref: A },
      { key: 'n2', kind: 'entity', ref: B },
      { key: 'e1', kind: 'relationship', ref: EDGE.ref },
    ],
    coverage: { retrieval: '2 shown · ~38 not yet retrieved (estimated)', summary: 'The draft cites 3 of the 3 shown elements' },
    removedCount: 0,
    sent: SENT,
    model: 'stub-model',
    calls: 2,
    summaryToken: 'tok',
    ...over,
  }) as SummaryResponse;

const RECORD = { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' as const } };

function show(state: ClientState, id: string): void {
  const result = { sourceId: 'a', nodes: [node('a', 'ent-1'), node('a', 'ent-2')], edges: [EDGE] };
  state.show({ id, sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A, B], edgeRefs: [EDGE.ref] }, [{ key: key('a'), result }]);
}

type Answer = (request: SummaryRequest, key: string, signal: AbortSignal | undefined) => Promise<ApiResult<SummaryResponse>>;

function harness(answer: Answer) {
  const state = createClientState();
  state.bindSource('a');
  show(state, 'inv-1');
  const session = createSummarySession();
  const sent: { request: SummaryRequest; key: string; signal: AbortSignal | undefined }[] = [];
  const client = fakeClient({
    summarize: async (request, key, signal) => {
      sent.push({ request, key, signal });
      return answer(request, key, signal);
    },
  });
  let closed = 0;
  const tree = (open: boolean, over?: ClientState) => (
    <ApiClientProvider client={client}>
      <ClientStateProvider state={over ?? state}>
        <SummarySessionProvider value={session}>{open ? <SummaryPanel onClose={() => (closed += 1)} returnToGraph={() => (closed += 100)} /> : null}</SummarySessionProvider>
      </ClientStateProvider>
    </ApiClientProvider>
  );
  return { tree, sent, state, session, closed: () => closed };
}

const outcomeCard = () =>
  waitFor(() => {
    const card = document.querySelector('.summary-outcome');
    if (card === null) throw new Error('no outcome');
    return card;
  });

const ok = (value: SummaryResponse): ApiResult<SummaryResponse> => ({ ok: true, value });

describe('the summary panel: one click to a draft', () => {
  it('sends the references of the view once, with a key and no content, and shows the numbered cited draft', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    expect(await screen.findByRole('heading', { name: 'Draft' })).toBeTruthy();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(h.sent[0]?.request).toEqual({ investigationId: 'inv-1', sourceId: 'a', entities: [A, B], edges: [EDGE.ref], aggregates: [], derived: [] });
    const items = screen.getAllByRole('listitem').filter((item) => item.querySelector('textarea') !== null);
    expect(items).toHaveLength(2);
    expect((screen.getByLabelText('Sentence 1') as HTMLTextAreaElement).value).toBe('ent-1 and ent-2 are linked.');
    expect(screen.getByText('2 shown · ~38 not yet retrieved (estimated) · The draft cites 3 of the 3 shown elements')).toBeTruthy();
    expect(screen.getByText('AI-drafted')).toBeTruthy();
    expect(screen.getByText('stub-model')).toBeTruthy();
    expect(screen.getByText('Not saved')).toBeTruthy();
    expect(screen.getByText('This is not a finding.')).toBeTruthy();
  });

  it('numbers the cited elements in the order of their first citation, one number for one key, apart from the sentences', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    const block = screen.getByLabelText('Sentence 1').closest('li') as HTMLElement;
    expect(within(block).getAllByRole('button').map((button) => button.textContent)).toEqual(['[1] ent-1 → ent-2 · rel-a', '[2] ent-1', '[3] ent-2']);
    const second = (screen.getByLabelText('Sentence 2').closest('li') as HTMLElement).querySelector('button');
    expect(second?.textContent).toBe('[3] ent-2');
  });

  it('asks for masking when the session masks', async () => {
    const h = harness(async () => ok(draft()));
    h.state.setMask(true);
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    expect(h.sent[0]?.request.mask).toBe(true);
  });

  it.each([
    ['ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }],
    ['ACCESS_DENIED', { reason: 'ai-preview-off' }],
  ])('says the summary is unavailable and offers no Try again: %s', async (code, details) => {
    const h = harness(async () => ({ ok: false, failure: failure(code, details) }));
    render(h.tree(true));
    expect(await screen.findByText('The case summary is not available right now.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says the source changed after a CONFLICT of that reason and sends nothing further', async () => {
    const h = harness(async () => ({ ok: false, failure: failure('CONFLICT', { reason: 'source-changed' }) }));
    render(h.tree(true));
    expect(await screen.findByText('The source changed, so summaries are paused.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(h.sent).toHaveLength(1);
  });

  it('keeps the draft while the panel is closed and reopened, edits included, and sends no request', async () => {
    const h = harness(async () => ok(draft()));
    const view = render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.type(screen.getByLabelText('Sentence 1'), ' Edited.');
    view.rerender(h.tree(false));
    view.rerender(h.tree(true));
    expect((screen.getByLabelText('Sentence 1') as HTMLTextAreaElement).value).toBe('ent-1 and ent-2 are linked. Edited.');
    expect(h.sent).toHaveLength(1);
  });

  it('shows nothing of a late answer after the panel was closed and starts afresh when it is opened again', async () => {
    let finish: (value: ApiResult<SummaryResponse>) => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (finish = resolve)));
    const view = render(h.tree(true));
    const first = h.sent[0]?.signal;
    view.rerender(h.tree(false));
    expect(first?.aborted).toBe(true);
    await act(async () => finish(ok(draft())));
    view.rerender(h.tree(true));
    expect(screen.queryByRole('heading', { name: 'Draft' })).toBeNull();
    expect(h.sent).toHaveLength(2);
  });

  it('clears the draft with a sentence when masking is switched, and shows no late answer', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    act(() => h.state.setMask(true));
    expect(await screen.findByText('Masking changed, so the draft is cleared. Summarize again to see it.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Draft' })).toBeNull();
  });

  it('clears the draft when the investigation is another one', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    act(() => show(h.state, 'inv-2'));
    expect(await screen.findByText('This is another investigation, so the earlier draft is cleared.')).toBeTruthy();
  });

  it('does not follow the view: the draft stays when an entity leaves it', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    act(() => h.state.hide([elementKey(B)]));
    expect(screen.getByLabelText('Sentence 1')).toBeTruthy();
    expect(h.sent).toHaveLength(1);
  });
});

describe('the summary panel: citations', () => {
  it('selects a drawn element and says why an element that is hidden cannot be selected', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getAllByRole('button', { name: /^Citation \d+, ent-1,/ })[0] as HTMLElement);
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
    act(() => h.state.hide([elementKey(B)]));
    await userEvent.click(screen.getAllByRole('button', { name: /^Citation \d+, ent-2,/ })[0] as HTMLElement);
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
    expect(screen.getAllByText('Outside the current view').length).toBeGreaterThan(0);
  });

  it('keeps the label it was given for an element that leaves the graph, and says it is gone', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    act(() => h.state.setLoaded([key('a')], [A], []));
    expect(screen.getAllByRole('button', { name: /^Citation \d+, ent-2,/ })[0] as HTMLElement).toBeTruthy();
    expect(screen.getAllByText('No longer on the graph').length).toBeGreaterThan(0);
  });

  it('labels an element the graph never held by its key and kind', async () => {
    const h = harness(async () => ok(draft({ citations: [{ key: 'n1', kind: 'entity', ref: ref('a', 'type-a', 'unknown') }], sentences: [{ text: 'One.', cites: ['n1'] }] })));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    expect(screen.getAllByRole('button', { name: /Entity n1/ })).toHaveLength(1);
  });
});

describe('the summary panel: generating, Cancel, Regenerate and Discard', () => {
  it('lists the steps of one request held open and cancels on the client without changing the view', async () => {
    const h = harness(() => new Promise(() => undefined));
    render(h.tree(true));
    for (const step of ['Read through the gate', 'Size checked', 'Drafting', 'Checking citations']) expect(screen.getByText(step)).toBeTruthy();
    expect(screen.queryByText('Names replaced')).toBeNull();
    const selection = h.state.presentation.view.getState().selection;
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.sent[0]?.signal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Summarize' })).toBeTruthy();
    expect(h.state.presentation.view.getState().selection).toBe(selection);
    expect(h.state.loadedGraph().nodes).toHaveLength(2);
  });

  it('cancels with Escape first and closes with the next one', async () => {
    const h = harness(() => new Promise(() => undefined));
    render(h.tree(true));
    await userEvent.keyboard('{Escape}');
    expect(h.sent[0]?.signal?.aborted).toBe(true);
    expect(h.closed()).toBe(0);
    await userEvent.keyboard('{Escape}');
    expect(h.closed()).toBe(1);
  });

  it('sends no second request while one is out', async () => {
    let finish: (value: ApiResult<SummaryResponse>) => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (finish = resolve)));
    render(h.tree(true));
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
    await act(async () => finish(ok(draft())));
    await userEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
    expect((screen.getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.sent).toHaveLength(2);
  });

  it('keeps the previous draft while regenerating, with a new key, and replaces it with the new one', async () => {
    let call = 0;
    let finish: (value: ApiResult<SummaryResponse>) => void = () => undefined;
    const h = harness(() => (call++ === 0 ? Promise.resolve(ok(draft())) : new Promise((resolve) => (finish = resolve))));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(screen.getByText('Previous draft')).toBeTruthy();
    expect(screen.getByLabelText('Sentence 1')).toBeTruthy();
    expect(h.sent[1]?.key).not.toBe(h.sent[0]?.key);
    await act(async () => finish(ok(draft({ sentences: [{ text: 'Fresh.', cites: ['n1'] }], model: 'second-model' }))));
    expect(screen.queryByText('Previous draft')).toBeNull();
    expect((screen.getByLabelText('Sentence 1') as HTMLTextAreaElement).value).toBe('Fresh.');
  });

  it('returns to the previous draft when a regeneration is cancelled', async () => {
    let call = 0;
    const h = harness(() => (call++ === 0 ? Promise.resolve(ok(draft())) : new Promise(() => undefined)));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Sentence 1')).toBeTruthy();
    expect(screen.queryByText('Previous draft')).toBeNull();
  });

  it('discards the draft with no request and shows the start state', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByLabelText('Sentence 1')).toBeNull();
    expect(screen.getByRole('button', { name: 'Summarize' })).toBeTruthy();
    expect(h.sent).toHaveLength(1);
  });
});

describe('the summary panel: editable text', () => {
  it('keeps an edit in the panel only, tags it, leaves the citations and sends nothing', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.type(screen.getByLabelText('Sentence 2'), ' More.');
    expect(screen.getByText('Edited')).toBeTruthy();
    expect(screen.getByText('AI-drafted')).toBeTruthy();
    expect((screen.getByLabelText('Sentence 2').closest('li') as HTMLElement).querySelectorAll('button')).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it('ends an edit with Escape before it closes the panel', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    screen.getByLabelText('Sentence 1').focus();
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).not.toBe(screen.getByLabelText('Sentence 1'));
    expect(h.closed()).toBe(0);
    await userEvent.keyboard('{Escape}');
    expect(h.closed()).toBe(1);
  });

  it('drops the edits when a new draft replaces the old one', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.type(screen.getByLabelText('Sentence 1'), ' x');
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await screen.findByText('AI-drafted');
    expect((screen.getByLabelText('Sentence 1') as HTMLTextAreaElement).value).toBe('ent-1 and ent-2 are linked.');
    expect(screen.queryByText('Edited')).toBeNull();
  });
});

describe('the summary panel: What the model sees', () => {
  it('shows exactly the text sent, the number of calls, closed until opened', async () => {
    const h = harness(async () => ok(draft()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    const details = document.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await userEvent.click(screen.getByText('What the model sees'));
    expect(details.open).toBe(true);
    expect(details.querySelector('pre')?.textContent).toBe(SENT);
    expect(details.textContent).toContain('2 calls made');
  });

  it.each([
    ['tooLarge', { status: 'tooLarge', limit: 'elements', elements: 412, cap: 300 }],
    ['timeLimit', { status: 'timeLimit', calls: 3 }],
    ['failed', { status: 'failed', kind: 'timeout', calls: 1 }],
  ])('offers no disclosure for %s', async (_name, response) => {
    const h = harness(async () => ok(response as SummaryResponse));
    render(h.tree(true));
    await outcomeCard();
    expect(screen.queryByText('What the model sees')).toBeNull();
  });
});

describe('the summary panel: unusual outcomes', () => {
  it.each([
    [1, '1 sentence removed: it could not be cited'],
    [2, '2 sentences removed: they could not be cited'],
  ])('says how many sentences a partial draft lost: %i', async (removedCount, text) => {
    const h = harness(async () => ok(draft({ status: 'partial', removedCount })));
    render(h.tree(true));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('says no sentence was supportable, with the coverage line, the disclosure, Return to graph and Regenerate', async () => {
    const h = harness(async () => ok({ status: 'unsupported', removedCount: 2, coverage: { retrieval: 'r', summary: 's' }, sent: SENT, model: 'm', calls: 3 }));
    render(h.tree(true));
    expect(await screen.findByRole('heading', { name: 'Nothing supportable to summarize' })).toBeTruthy();
    expect(screen.getByText('r · s')).toBeTruthy();
    expect(screen.getByText('What the model sees')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Return to graph' }));
    expect(h.closed()).toBe(100);
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(h.sent).toHaveLength(2);
  });

  it('says a view is too large with the numbers of the response and that no data was submitted', async () => {
    const h = harness(async () => ok({ status: 'tooLarge', limit: 'elements', elements: 412, cap: 300 }));
    render(h.tree(true));
    expect(await screen.findByText('412 > 300 elements')).toBeTruthy();
    expect(screen.getByText('Narrow the current view before drafting. No data was submitted, including any partial selection.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Return to graph' })).toBeTruthy();
  });

  it('says the text of a view is too large with no figure the response does not carry', async () => {
    const h = harness(async () => ok({ status: 'tooLarge', limit: 'text', estimatedTokens: 90000, cap: 60000 }));
    render(h.tree(true));
    const sentence = await screen.findByText(/The text of this view is over the size allowed/);
    expect(sentence.textContent).toContain('No data was submitted');
    expect(sentence.textContent).not.toMatch(/\d/);
  });

  it('says the draft took longer than the limit and offers Try again', async () => {
    const h = harness(async () => ok({ status: 'timeLimit', calls: 3 }));
    render(h.tree(true));
    expect(await screen.findByText('The draft took longer than the limit.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(h.sent).toHaveLength(2);
  });

  it.each(SUMMARY_FAILURE_KINDS)('shows one fixed sentence for the failure kind %s and offers Try again', async (kind) => {
    const h = harness(async () => ok({ status: 'failed', kind, calls: 1 }));
    render(h.tree(true));
    expect(await screen.findByText(FAILURE_KIND_TEXT[kind])).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows the unreadable-answer sentence for an answer the schema refuses', async () => {
    const h = harness(async () => ({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } }));
    render(h.tree(true));
    expect(await screen.findByText('The answer was not in the form expected.')).toBeTruthy();
  });

  it('holds Try again back for the wait a rate limit asks for', async () => {
    const h = harness(async () => ({ ok: false, failure: failure('RATE_LIMITED', { retryAfterMs: 60000 }) }));
    render(h.tree(true));
    await outcomeCard();
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['unsupported', { status: 'unsupported', removedCount: 1, coverage: { retrieval: 'r', summary: 's' }, sent: 'second text', model: 'm', calls: 1 }],
    ['tooLarge', { status: 'tooLarge', limit: 'elements', elements: 412, cap: 300 }],
    ['timeLimit', { status: 'timeLimit', calls: 3 }],
    ['failed', { status: 'failed', kind: 'refused', calls: 1 }],
  ])('keeps the previous draft beside the outcome of a regeneration: %s', async (_name, response) => {
    let call = 0;
    const h = harness(() => Promise.resolve(call++ === 0 ? ok(draft()) : ok(response as SummaryResponse)));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await outcomeCard();
    expect((screen.getByLabelText('Sentence 1') as HTMLTextAreaElement).value).toBe('ent-1 and ent-2 are linked.');
    expect(screen.getByText('Previous draft')).toBeTruthy();
    expect(document.querySelector('.summary-draft pre')?.textContent).toBe(SENT);
  });

  it('keeps the previous draft when a regeneration fails on the network', async () => {
    let call = 0;
    const h = harness(() => Promise.resolve(call++ === 0 ? ok(draft()) : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await outcomeCard();
    expect(screen.getByLabelText('Sentence 1')).toBeTruthy();
  });
});

describe('the summary panel: keeping the person going and the focus', () => {
  it('sends nothing and says the source changed when the investigation record already says so', async () => {
    const h = harness(async () => ok(draft()));
    h.state.describeInvestigation({ ...RECORD, sourceState: 'repointed' });
    render(h.tree(true));
    expect(await screen.findByText('The source changed, so summaries are paused.')).toBeTruthy();
    expect(h.sent).toHaveLength(0);
  });

  it('asks again when the panel is opened after a view that was too large', async () => {
    let call = 0;
    const h = harness(() => Promise.resolve(ok(call++ === 0 ? ({ status: 'tooLarge', limit: 'elements', elements: 412, cap: 300 } as SummaryResponse) : draft())));
    const view = render(h.tree(true));
    await screen.findByText(/412 > 300 elements/);
    view.rerender(h.tree(false));
    view.rerender(h.tree(true));
    expect(await screen.findByRole('heading', { name: 'Draft' })).toBeTruthy();
    expect(h.sent).toHaveLength(2);
  });

  it('offers Summarize after the draft was cleared by a change of masking, and sends nothing until it is pressed', async () => {
    const h = harness(async () => ok(draft()));
    const view = render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    act(() => h.state.setMask(true));
    await screen.findByText('Masking changed, so the draft is cleared. Summarize again to see it.');
    view.rerender(h.tree(false));
    view.rerender(h.tree(true));
    expect(h.sent).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    expect(await screen.findByRole('heading', { name: 'Draft' })).toBeTruthy();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.request.mask).toBe(true);
  });

  it('shows nothing of an answer that arrives after Cancel', async () => {
    let finish: (value: ApiResult<SummaryResponse>) => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (finish = resolve)));
    render(h.tree(true));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => finish(ok(draft())));
    expect(screen.queryByRole('heading', { name: 'Draft' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Summarize' })).toBeTruthy();
  });

  it('shows nothing of an answer that arrives after Discard during a regeneration', async () => {
    let call = 0;
    let finish: (value: ApiResult<SummaryResponse>) => void = () => undefined;
    const h = harness(() => (call++ === 0 ? Promise.resolve(ok(draft())) : new Promise((resolve) => (finish = resolve))));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(h.sent[1]?.signal?.aborted).toBe(true);
    await act(async () => finish(ok(draft())));
    expect(screen.queryByRole('heading', { name: 'Draft' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Summarize' }));
  });

  it('keeps the focus inside the panel when a regeneration is cancelled, so Escape still closes it', async () => {
    let call = 0;
    const h = harness(() => (call++ === 0 ? Promise.resolve(ok(draft())) : new Promise(() => undefined)));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Draft' }));
    await userEvent.keyboard('{Escape}');
    expect(h.closed()).toBe(1);
  });

  it('moves the focus to the title of an outcome', async () => {
    const h = harness(async () => ok({ status: 'timeLimit', calls: 3 }));
    render(h.tree(true));
    await outcomeCard();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Took too long' }));
  });

  it('says a cited element is gone when it left the graph while the answer was out', async () => {
    let finish: (value: ApiResult<SummaryResponse>) => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (finish = resolve)));
    render(h.tree(true));
    act(() => h.state.setLoaded([key('a')], [A], []));
    await act(async () => finish(ok(draft())));
    await screen.findByRole('heading', { name: 'Draft' });
    expect(screen.getAllByText('No longer on the graph').length).toBeGreaterThan(0);
  });

  it('is operable by keyboard: Tab passes the markers, the list, Regenerate and Discard, and Enter on a citation selects the element', async () => {
    const h = harness(async () => ok(draft({ sentences: [{ text: 'One.', cites: ['n1'] }], citations: [{ key: 'n1', kind: 'entity', ref: A }] })));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    const order: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      await userEvent.tab();
      const active = document.activeElement as HTMLElement;
      order.push(active.getAttribute('aria-label') ?? active.textContent ?? '');
    }
    expect(order.join('|')).toMatch(/Sentence 1.*Citation 1.*Regenerate.*Discard.*What the model sees/);
    (screen.getAllByRole('button', { name: /^Citation \d+, ent-1,/ })[0] as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
    expect(panel().contains(document.activeElement)).toBe(true);
  });
});

const panel = (): HTMLElement => document.querySelector('.summary-panel') as HTMLElement;
