import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_LIMIT_SENTENCES, ASSISTANT_NOT_ANSWERED_SENTENCE, ASSISTANT_REFUSAL_SENTENCES, askAnswerSchema, type AssistantRead, type AssistantTurnAnswer, type AssistantTurnRequest } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { heavyRun, okRun } from '../patterns/patterns-kit.js';
import { node as testNode, key as testKey } from '../state/test-data.js';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { continueOf, harness, messageOf, RECORD, REFUSE, typeAndSend, VIEW } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TOKEN = `${'1'.repeat(10)}.${'a'.repeat(64)}`;
const ENTITY = { ref: { sourceId: 'a', entityType: 'kind-a', stableId: 'acc-1' }, display: { title: 'acc-1', type: 'kind-a' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
const inAnswer = (answer: unknown, extra: { reads?: AssistantRead[]; coverage?: string } = {}): AssistantTurnAnswer => ({ status: 'answered', route: 'ask', answer: askAnswerSchema.parse(answer), ...extra });
const ANSWERED = inAnswer({ answered: { intent: 'accounts-paid-by', entities: { targetId: 'acc-1' }, outcome: 'complete', result: { templateId: 'entity', result: ENTITY }, summary: { sentences: [{ text: 'acc-1 is here.', cites: ['n1'] }], citations: [{ key: 'n1', element: ENTITY.ref, type: 'kind-a', title: 'acc-1' }], omissions: 'Not named in the answer: none.' } } });
const HEAVY = inAnswer({ answered: { intent: 'shared-devices', entities: { account: 'acc-1' }, outcome: 'complete', continueToken: TOKEN, result: { templateId: 'shared-attribute', result: heavyRun() } } });
const CONTINUED = inAnswer({ answered: { intent: 'shared-devices', entities: { account: 'acc-1' }, outcome: 'complete', result: { templateId: 'shared-attribute', result: okRun(['acc-2']) } } });
const REFUSED = inAnswer({ refused: { cause: 'no-intent', sentence: 'This question does not match any question type this source offers.' } });
const R_SHARED: AssistantRead = { tool: 'shared', kind: 'intent', read: true, rows: 2, quality: 'exact', partial: false };
const R_BY_ID: AssistantRead = { tool: 'byId', kind: 'intent', subject: 'A-2', read: true, rows: 1, quality: 'exact', partial: false };
const ok = (value: AssistantTurnAnswer): ApiResult<AssistantTurnAnswer> => ({ ok: true, value });

describe('the Assistant thread: the answer of the ask route', () => {
  it('shows the tag, the cited answer with its sources and the step of the intent, each count with its quality word', async () => {
    const h = harness(async () => ok(ANSWERED));
    render(h.tree());
    await typeAndSend('who is acc-1?');
    expect(await screen.findByText(ASSISTANT_COPY.routeAsk)).toBeTruthy();
    expect(screen.getByText('Accounts paid by')).toBeTruthy();
    expect(screen.getByText('Sources · 1')).toBeTruthy();
    expect(screen.getByText('Not named in the answer: none.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Source 1/ })).toBeTruthy();
  });

  it('says why a source that is not drawn cannot be selected, in the words of the Ask panel', async () => {
    const h = harness(async () => ok(ANSWERED));
    render(h.tree());
    await typeAndSend('who is acc-1?');
    expect(await screen.findByText('Use Add to graph first', { selector: '.ask-source-blocked' })).toBeTruthy();
  });

  it('shows the fixed sentence of Ask’s refusal for a cause of its list', async () => {
    const h = harness(async () => ok(REFUSED));
    render(h.tree());
    await typeAndSend('what?');
    expect(await screen.findByText('This question does not match any question type this source offers.')).toBeTruthy();
  });

  it('shows two answers in one thread without a clash of ids', async () => {
    const h = harness(async () => ok(ANSWERED));
    render(h.tree());
    await typeAndSend('one');
    await screen.findAllByText('Sources · 1');
    await typeAndSend('two');
    expect(await screen.findAllByText('Sources · 1')).toHaveLength(2);
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the Assistant thread: the answer after tool steps', () => {
  it('shows the cited sentences as an AI-drafted answer with its sources, the number of steps and the coverage', async () => {
    const answer: AssistantTurnAnswer = {
      status: 'answered',
      route: 'ask',
      sentences: [{ text: 'Account acc-1 is listed.', cites: ['n1'] }],
      citations: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'a', entityType: 'kind-a', stableId: 'acc-1' } }],
      coverage: { retrieval: '2 shown · exact', summary: 'The answer cites 1 of the 2 elements the reads returned.' },
      model: 'claude-test',
      calls: 4,
      steps: 2,
      reads: [R_SHARED, R_BY_ID],
    };
    const h = harness(async () => ok(answer));
    render(h.tree());
    await typeAndSend('who else?');
    expect(await screen.findByText('Account acc-1 is listed.')).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.drafted)).toBeTruthy();
    expect(screen.getByText(`${ASSISTANT_COPY.steps} · 2`)).toBeTruthy();
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.sentencesFromReads })).toBeTruthy();
    expect(screen.getByText('The answer cites 1 of the 2 elements the reads returned.')).toBeTruthy();
  });
});

describe('the Assistant thread: an answer after steps that cites the line of a read only', () => {
  it('shows the sentence, the coverage of each read and no Sources list', async () => {
    const answer: AssistantTurnAnswer = {
      status: 'answered',
      route: 'ask',
      sentences: [{ text: 'The read of the second tool found 0 matches.', cites: ['s2'] }],
      citations: [],
      coverage: { retrieval: 'read 1, a: 1 match shown · exact; read 2, b: 0 matches shown · exact', summary: 'The answer cites 0 of the 1 elements the reads returned.' },
      model: 'claude-test',
      calls: 4,
      steps: 2,
      reads: [R_SHARED, R_BY_ID],
    };
    const h = harness(async () => ok(answer));
    render(h.tree());
    await typeAndSend('who else?');
    expect(await screen.findByText('The read of the second tool found 0 matches.')).toBeTruthy();
    expect(screen.getByText('read 1, a: 1 match shown · exact; read 2, b: 0 matches shown · exact')).toBeTruthy();
    expect(screen.queryByText(/^Sources/)).toBeNull();
  });
});

describe('the Assistant thread: a turn that reached a limit', () => {
  it('shows the reads open above the card of the limit, with its title, its fixed sentence and its line, keeps the earlier turns, and offers nothing to retry', async () => {
    const answers: AssistantTurnAnswer[] = [VIEW, { status: 'limit', limit: 'steps', sentence: ASSISTANT_LIMIT_SENTENCES.steps, reads: [R_SHARED, R_BY_ID] }];
    const h = harness(async () => ok(answers.shift() ?? VIEW));
    render(h.tree());
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_NOT_ANSWERED_SENTENCE);
    await typeAndSend('second');
    const title = await screen.findByRole('heading', { name: ASSISTANT_COPY.limitTitle });
    expect(screen.getByText(ASSISTANT_LIMIT_SENTENCES.steps)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.limitNoteReads)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.limitNoteOther)).toBeNull();
    expect(document.querySelectorAll('.assistant-read')).toHaveLength(2);
    expect(document.querySelector('details.assistant-steps')).toBeNull();
    expect(document.activeElement).toBe(title);
    expect(screen.getByText(ASSISTANT_NOT_ANSWERED_SENTENCE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.tryAgain })).toBeNull();
  });

  it.each([
    ['calls', 'Model calls'],
    ['rows', 'Rows read'],
    ['time', 'Time'],
    ['input', 'Too large to send'],
  ] as const)('titles the stop of the %s limit %s and shows the line of the ceiling, with no reads above it when none were made', async (limit, title) => {
    const h = harness(async () => ok({ status: 'limit', limit, sentence: ASSISTANT_LIMIT_SENTENCES[limit], reads: [] }));
    render(h.tree());
    await typeAndSend('go');
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText(ASSISTANT_LIMIT_SENTENCES[limit])).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.limitNoteOther)).toBeTruthy();
    expect(document.querySelectorAll('.assistant-read')).toHaveLength(0);
  });

  it('shows the card of the limit under an answer that was given over what was read, without taking the focus from the answer', async () => {
    const answer: AssistantTurnAnswer = {
      status: 'answered',
      route: 'ask',
      sentences: [{ text: 'Account acc-1 is listed.', cites: ['n1'] }],
      citations: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'a', entityType: 'kind-a', stableId: 'acc-1' } }],
      coverage: { retrieval: '2 shown · exact', summary: 'The answer cites 1 of the 2 elements the reads returned.' },
      model: 'claude-test',
      calls: 4,
      steps: 2,
      reads: [R_SHARED, R_BY_ID],
      stoppedAt: 'rows',
    };
    const h = harness(async () => ok(answer));
    render(h.tree());
    await typeAndSend('who else?');
    expect(await screen.findByText('Account acc-1 is listed.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Rows read' })).toBeTruthy();
    expect(screen.getByText(ASSISTANT_LIMIT_SENTENCES.rows)).toBeTruthy();
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { name: 'Rows read' }));
  });
});

describe('the Assistant thread: a heavy stop and Continue', () => {
  it('shows the figure as a lower bound, Continue as the only action, and puts the result in the same turn', async () => {
    const calls: AssistantTurnRequest[] = [];
    const h = harness(async (request) => {
      calls.push(request);
      return ok(continueOf(request) === undefined ? HEAVY : CONTINUED);
    });
    render(h.tree());
    await typeAndSend('big one');
    expect(await screen.findByText('Lower bound')).toBeTruthy();
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.continue })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.heavyBody)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.continue }));
    await screen.findByRole('heading', { name: 'Answer ready' });
    expect(continueOf(calls[1])).toEqual({ intent: 'shared-devices', entities: { account: 'acc-1' }, continueToken: TOKEN });
    expect(messageOf(calls[1])).toBeUndefined();
    expect(screen.queryByText('Lower bound')).toBeNull();
    expect(document.querySelectorAll('.assistant-message')).toHaveLength(1);
  });

  it('says "Reading a first page…" while the continue is out', async () => {
    let finish: (value: ApiResult<AssistantTurnAnswer>) => void = () => undefined;
    const h = harness((request) => (continueOf(request) === undefined ? Promise.resolve(ok(HEAVY)) : new Promise((resolve) => (finish = resolve))));
    render(h.tree());
    await typeAndSend('big one');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.continue }));
    expect(screen.getByRole('status').textContent).toBe(ASSISTANT_COPY.working);
    expect(screen.getByLabelText(ASSISTANT_COPY.continuing)).toBeTruthy();
    await act(async () => finish(ok(CONTINUED)));
    expect(await screen.findByRole('heading', { name: 'Answer ready' })).toBeTruthy();
  });

  it('shows Continue no longer valid with Ask again, which sends the original message and not the dead token', async () => {
    const calls: AssistantTurnRequest[] = [];
    const h = harness(async (request) => {
      calls.push(request);
      if (calls.length === 1) return ok(HEAVY);
      return calls.length === 2 ? ok({ status: 'continue-invalid', sentence: 'x' }) : ok(ANSWERED);
    });
    render(h.tree());
    await typeAndSend('big one');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.continue }));
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.continueInvalidTitle })).toBeTruthy();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.tryAgain })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.askAgain }));
    await screen.findByText('Sources · 1');
    expect(messageOf(calls[2])).toBe('big one');
    expect(continueOf(calls[2])).toBeUndefined();
  });
});

describe('the Assistant thread: failures and Try again', () => {
  it.each([
    ['service', false, 'The assistant’s service is unavailable. Nothing was asked and nothing was read.'],
    ['timeout', false, 'The assistant’s service took too long. Nothing was asked and nothing was read.'],
    ['busy', true, 'The source is busy right now. The read may have started.'],
    ['source-unavailable', true, 'The source is not available right now. The read may have started.'],
    ['timeout', true, 'The read took too long and was stopped. It may have started.'],
  ] as const)('shows the card for an unavailable answer of kind %s with a read started %s, and keeps the message in the box', async (kind, readStarted, sentence) => {
    const h = harness(async () => ok({ status: 'unavailable', kind, readStarted }));
    render(h.tree());
    await typeAndSend('which accounts?');
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.serviceTitle })).toBeTruthy();
    expect(screen.getByText(sentence)).toBeTruthy();
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).value).toBe('which accounts?');
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain })).toBeTruthy();
  });

  it('does not claim that nothing was read when a read had started', async () => {
    const h = harness(async () => ok({ status: 'unavailable', kind: 'busy', readStarted: true }));
    render(h.tree());
    await typeAndSend('which accounts?');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.serviceTitle });
    expect(screen.queryByText(/nothing was read/i)).toBeNull();
  });

  it('shows the too-large card with the server’s sentence and keeps the message', async () => {
    const h = harness(async () => ok({ status: 'too-large', sentence: 'The message and the view are too large to send. Narrow the view or ask something smaller.' }));
    render(h.tree());
    await typeAndSend('everything');
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.tooLargeTitle })).toBeTruthy();
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).value).toBe('everything');
  });

  it('shows the over-the-limit notice for a too-long answer of the server, with its exact count, removes no earlier turn and keeps the message', async () => {
    const answers: AssistantTurnAnswer[] = [REFUSE, { status: 'too-long', words: 1243, limit: 1000 }];
    const h = harness(async () => ok(answers.shift() ?? VIEW));
    render(h.tree());
    await typeAndSend('first');
    await screen.findByText(REFUSE.status === 'answered' && REFUSE.route === 'refuse' ? REFUSE.sentence : '');
    await typeAndSend('second');
    expect(await screen.findByText('Your message is 1,243 words. The limit is 1,000. Shorten it and send again.')).toBeTruthy();
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).value).toBe('second');
    expect(document.querySelectorAll('.assistant-message')).toHaveLength(1);
  });

  it('shows the words of the product for a network failure, keeps the message and earlier turns, and sends the same message again on Try again', async () => {
    let calls = 0;
    const h = harness(async () => (++calls === 1 ? ok(REFUSE) : calls === 2 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : ok(VIEW)));
    render(h.tree());
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    await typeAndSend('second');
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.serviceTitle })).toBeTruthy();
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).value).toBe('second');
    expect(screen.getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    expect(await screen.findAllByRole('heading', { name: ASSISTANT_COPY.notAnswered })).toHaveLength(2);
    expect(h.sent.map(messageOf)).toEqual(['first', 'second', 'second']);
    expect(document.querySelectorAll('.assistant-message')).toHaveLength(2);
  });

  it('holds Try again back for the wait of a rate limit and then allows it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness(async () => ok({ status: 'unavailable', kind: 'rate-limit', readStarted: true, retryAfterSeconds: 30 }));
    render(h.tree());
    fireEvent.change(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), { target: { value: 'which accounts?' } });
    fireEvent.submit(screen.getByLabelText(ASSISTANT_COPY.fieldLabel).closest('form') ?? document.body);
    const retry = await screen.findByRole('button', { name: ASSISTANT_COPY.tryAgain });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect((screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('retries a failed Continue with the same continue and no message', async () => {
    const calls: AssistantTurnRequest[] = [];
    const h = harness(async (request) => {
      calls.push(request);
      if (calls.length === 1) return ok(HEAVY);
      return calls.length === 2 ? ok({ status: 'unavailable', kind: 'busy', readStarted: true }) : ok(CONTINUED);
    });
    render(h.tree());
    await typeAndSend('big one');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.continue }));
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    await screen.findByRole('heading', { name: 'Answer ready' });
    expect(calls).toHaveLength(3);
    expect(continueOf(calls[2])).toEqual({ intent: 'shared-devices', entities: { account: 'acc-1' }, continueToken: TOKEN });
    expect(messageOf(calls[2])).toBeUndefined();
  });
});

describe('the Assistant thread: the session', () => {
  it('keeps the thread while the panel is closed and opened again', async () => {
    const h = harness(async () => ok(REFUSE));
    const view = render(h.tree(true));
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    view.rerender(h.tree(false));
    view.rerender(h.tree(true));
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
  });

  it('lists the turns as a list the keyboard can read, older ones included', async () => {
    const h = harness(async () => ok(REFUSE));
    render(h.tree());
    for (const text of ['one', 'two', 'three']) await typeAndSend(text);
    await screen.findAllByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    expect(within(screen.getByRole('list', { name: ASSISTANT_COPY.thread })).getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('the Assistant thread: clearing', () => {
  function bound(turn: (request: AssistantTurnRequest) => Promise<ApiResult<AssistantTurnAnswer>>) {
    const h = harness(turn);
    const stop = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
    return { ...h, stop };
  }

  it('clears the thread and shows the masking card of frame AS9 when the masking changes', async () => {
    const h = bound(async () => ok(REFUSE));
    render(h.tree());
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    act(() => h.state.setMask(true));
    expect(screen.queryByText('first')).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.maskingTitle)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.maskingBody)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.maskingNote)).toBeTruthy();
    h.stop();
  });

  it('clears a shown heavy stop and a failed Continue when the masking changes', async () => {
    const h = bound(async (request) => ok(continueOf(request) === undefined ? HEAVY : { status: 'unavailable', kind: 'busy', readStarted: true }));
    render(h.tree());
    await typeAndSend('big one');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.continue }));
    await screen.findByRole('button', { name: ASSISTANT_COPY.tryAgain });
    act(() => h.state.setMask(true));
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.tryAgain })).toBeNull();
    h.stop();
  });

  it('drops an answer that arrives after the thread was cleared, for a pending turn', async () => {
    let finish: (value: ApiResult<AssistantTurnAnswer>) => void = () => undefined;
    const h = bound(() => new Promise((resolve) => (finish = resolve)));
    render(h.tree());
    await typeAndSend('first');
    act(() => h.state.setMask(true));
    await act(async () => finish(ok(REFUSE)));
    expect(screen.queryByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeNull();
    expect(h.session.store.getState().turns).toEqual([]);
    h.stop();
  });

  it('starts an empty thread for another investigation and keeps an answer of the first out of it', async () => {
    let finish: (value: ApiResult<AssistantTurnAnswer>) => void = () => undefined;
    const h = bound(() => new Promise((resolve) => (finish = resolve)));
    render(h.tree());
    await typeAndSend('first');
    act(() => h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []));
    await act(async () => finish(ok(REFUSE)));
    expect(h.session.store.getState().turns).toEqual([]);
    expect(screen.queryByText('first')).toBeNull();
    h.stop();
  });

  it('pauses sending while the source has changed, and clears what was shown', async () => {
    const h = bound(async () => ok(REFUSE));
    render(h.tree());
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    act(() => h.state.describeInvestigation({ ...RECORD, sourceState: 'removed' }));
    expect(screen.queryByText('first')).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.sourceChanged)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), 'again');
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
    h.stop();
  });
});


describe('the Assistant thread: what a review asked for', () => {
  it('shows the step and the coverage line exactly as the server wrote them, and nothing of the values of the question', async () => {
    const entities = { account: 'acc-1', pattern: '0a1b2c3d-0000-4000-8000-000000000000' };
    const answer = (outcome: 'complete' | 'partial') => ({ answered: { intent: 'shared-devices', entities, outcome, result: { templateId: 'shared-attribute', result: okRun(['acc-2']) } } });
    const answers = [
      inAnswer(answer('complete'), { reads: [{ tool: 'shared-devices', kind: 'intent', subject: 'acc-1', read: true, rows: 1, quality: 'exact', partial: false }], coverage: '1 shown · exact' }),
      inAnswer(answer('partial'), { reads: [{ tool: 'shared-devices', kind: 'intent', subject: 'acc-1', read: true, rows: 123, quality: 'lowerBound', partial: true }], coverage: '25 shown · ≥ 123 not yet retrieved · lower bound' }),
      inAnswer(answer('complete'), { reads: [{ tool: 'shared-devices', kind: 'intent', subject: 'acc-1', read: true, quality: 'unknown', partial: false }], coverage: '3 shown · count unknown' }),
    ];
    const h = harness(async () => ok(answers.shift() ?? ANSWERED));
    render(h.tree());
    await typeAndSend('one');
    expect(await screen.findByText('Steps · 1')).toBeTruthy();
    expect(screen.getByText('acc-1 · 1 row · complete')).toBeTruthy();
    expect(screen.getByText('Ran Shared devices')).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.coverage)).toBeTruthy();
    expect(screen.getByText('1 shown · exact')).toBeTruthy();
    await typeAndSend('two');
    expect(await screen.findByText('25 shown · ≥ 123 not yet retrieved · lower bound')).toBeTruthy();
    expect(screen.getByText('acc-1 · ≥ 123 rows · partial')).toBeTruthy();
    await typeAndSend('three');
    expect(await screen.findByText('3 shown · count unknown')).toBeTruthy();
    expect(screen.getByText('acc-1 · complete · no row count')).toBeTruthy();
    expect(document.querySelector('.assistant-steps')?.textContent).not.toMatch(/0a1b2c3d/);
  });

  it('shows only the fixed sentence for a refusal of Ask’s list, with no chips and no manual-action card', async () => {
    const h = harness(async () => ok(REFUSED));
    render(h.tree());
    await typeAndSend('what?');
    await screen.findByText('This question does not match any question type this source offers.');
    expect(screen.queryByRole('button', { name: 'Open Filters' })).toBeNull();
    expect(screen.queryByText('Or do it by hand')).toBeNull();
  });

  it('keeps a message typed after a failure when an older turn fails again on Try again, and focuses the turn it retried', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
      if (calls === 2) return ok(REFUSE);
      return { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
    });
    render(h.tree());
    await typeAndSend('older');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.serviceTitle });
    await userEvent.clear(screen.getByLabelText(ASSISTANT_COPY.fieldLabel));
    await typeAndSend('newer');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), 'my new draft');
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    await screen.findByRole('heading', { name: ASSISTANT_COPY.serviceTitle });
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).value).toBe('my new draft');
    const turns = document.querySelectorAll('.assistant-turn');
    expect(document.activeElement?.closest('.assistant-turn')).toBe(turns[0]);
  });

  it('counts the wait of a rate limit from the failure, so closing and opening the panel neither restarts nor shortens it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness(async () => ok({ status: 'unavailable', kind: 'rate-limit', readStarted: true, retryAfterSeconds: 30 }));
    const view = render(h.tree(true));
    fireEvent.change(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), { target: { value: 'which accounts?' } });
    fireEvent.submit(screen.getByLabelText(ASSISTANT_COPY.fieldLabel).closest('form') ?? document.body);
    expect(((await screen.findByRole('button', { name: ASSISTANT_COPY.tryAgain })) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(20_000));
    view.rerender(h.tree(false));
    view.rerender(h.tree(true));
    expect((screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(11_000));
    expect((screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }) as HTMLButtonElement).disabled).toBe(false);
    view.rerender(h.tree(false));
    view.rerender(h.tree(true));
    expect((screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses the words of the assistant, not those of Ask, when the assistant is off at the server', async () => {
    const h = harness(async () => ({ ok: false, failure: { code: 'ACCESS_DENIED', message: 'x', retryable: false, traceId: 't', details: { reason: 'ai-off' } } }));
    render(h.tree());
    await typeAndSend('hello');
    expect(await screen.findByText(ASSISTANT_COPY.notAvailableNow)).toBeTruthy();
    expect(screen.queryByText(/Ask is not available/)).toBeNull();
  });

  it('refuses to send a view of 301 elements, says so, keeps the message and sends nothing', async () => {
    const h = harness(async () => ok(REFUSE));
    const nodes = Array.from({ length: 301 }, (_unused, index) => testNode('a', `ent-${index}`));
    h.state.show({ id: 'inv-9', sourceId: 'a', record: RECORD, resultKeys: [testKey('a')], nodeRefs: nodes.map((entry) => entry.ref), edgeRefs: [] }, [{ key: testKey('a'), result: { sourceId: 'a', nodes, edges: [] } }]);
    render(h.tree());
    await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), 'hello{Enter}');
    expect(await screen.findByText(ASSISTANT_COPY.viewTooLarge)).toBeTruthy();
    expect(h.sent).toEqual([]);
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).value).toBe('hello');
  });

  it('does not say anything of Ask or Summarize, whose availability is their own', async () => {
    const h = harness(async () => ok(REFUSE), null);
    render(h.tree());
    await screen.findByText(ASSISTANT_COPY.unavailableBody);
    expect(screen.queryByText(/Ask and Summarize/)).toBeNull();
  });

  it('shows the fixed sentence of the not-answered turn of the view route and no note that answers from the view are missing', async () => {
    const h = harness(async () => ok(VIEW));
    render(h.tree());
    await typeAndSend('what?');
    expect(await screen.findByText(ASSISTANT_NOT_ANSWERED_SENTENCE)).toBeTruthy();
    expect(screen.queryByText(/not available in this release/)).toBeNull();
    expect(screen.queryByText(/tied to an element/)).toBeNull();
  });
});

describe('the Assistant thread: the person and the access', () => {
  it('clears a thread of another person when the panel is opened again, and drops a late answer', async () => {
    const h = harness(async () => ok(REFUSE));
    const view = render(h.tree(true));
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    view.rerender(h.tree(false));
    h.session.store.setState({ ...h.session.store.getState(), principalId: 'someone-else' });
    view.rerender(h.tree(true));
    expect(screen.queryByText('first')).toBeNull();
    expect(h.session.store.getState().turns).toEqual([]);
  });

  it('clears the thread and says so when a turn is refused because the investigation is no longer the person’s', async () => {
    let calls = 0;
    const h = harness(async () => (++calls === 1 ? ok(REFUSE) : { ok: false, failure: { code: 'NOT_FOUND', message: 'x', retryable: false, traceId: 't' } }));
    render(h.tree());
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict);
    await typeAndSend('second');
    expect(await screen.findByText(ASSISTANT_COPY.accessLost)).toBeTruthy();
    expect(screen.queryByText('first')).toBeNull();
    expect(h.session.store.getState().turns).toEqual([]);
  });
});
