import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_CHOICE_INVALID_SENTENCE, ASSISTANT_REFUSAL_SENTENCES, type AssistantTurnAnswer } from '@neburyx/contracts';
import { harness, REFUSE, typeAndSend } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const TOKEN = `${'1'.repeat(10)}.${'a'.repeat(64)}`;
const choiceFor = (stableId: string) => ({ intent: 'shared', roles: ['id'], entities: { id: stableId }, choiceToken: TOKEN });
const CLARIFICATION: AssistantTurnAnswer = {
  status: 'clarification',
  question: 'Which widget do you mean?',
  candidates: [
    { title: 'W-884', type: 'Widget', choice: choiceFor('W-884') },
    { title: 'W-217', type: 'Widget', choice: choiceFor('W-217') },
  ],
};
const ok = (value: AssistantTurnAnswer) => ({ ok: true as const, value });

describe('the Assistant panel: a clarification turn', () => {
  it('shows the card with its title, the question, each candidate with its type, Cancel and the status line, and moves the focus to the title', async () => {
    const h = harness(async () => ok(CLARIFICATION));
    render(h.tree());
    await typeAndSend('and the other widget?');
    const title = await screen.findByRole('heading', { name: ASSISTANT_COPY.clarifyTitle });
    await screen.findByText('Which widget do you mean?');
    expect(document.activeElement).toBe(title);
    const rows = screen.getByRole('list', { name: ASSISTANT_COPY.clarifyCandidates });
    expect(rows.textContent).toContain('W-884');
    expect(rows.textContent).toContain('W-217');
    expect(rows.textContent).toContain('Widget');
    expect(screen.getByText(ASSISTANT_COPY.clarifyStatus)).toBeTruthy();
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.cancel })).toBeTruthy();
  });

  it('sends the choice of the candidate that was pressed, with no message, and shows the answer in the same turn', async () => {
    const h = harness(async (request) => ok('choice' in request ? REFUSE : CLARIFICATION));
    render(h.tree());
    await typeAndSend('and the other widget?');
    await userEvent.click(await screen.findByRole('button', { name: /W-217/ }));
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.clarifyTitle })).toBeNull();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ choice: choiceFor('W-217') });
    expect('message' in (h.sent[1] ?? {})).toBe(false);
  });

  it('is operated by the keyboard: Tab reaches the candidates and Enter picks one, and Escape inside the card cancels it', async () => {
    const h = harness(async (request) => ok('choice' in request ? REFUSE : CLARIFICATION));
    render(h.tree());
    await typeAndSend('and the other widget?');
    const first = await screen.findByRole('button', { name: /W-884/ });
    first.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    const second = harness(async () => ok(CLARIFICATION));
    cleanup();
    render(second.tree());
    await typeAndSend('and the other widget?');
    (await screen.findByRole('button', { name: /W-884/ })).focus();
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByText(ASSISTANT_COPY.cancelledTitle)).toBeTruthy();
    expect(second.sent).toHaveLength(1);
  });

  it('answers a choice that is no longer valid with its card and Ask again, which sends the message of the turn again', async () => {
    const h = harness(async (request) => ('choice' in request ? ok({ status: 'choice-invalid', sentence: ASSISTANT_CHOICE_INVALID_SENTENCE }) : ok(CLARIFICATION)));
    render(h.tree());
    await typeAndSend('and the other widget?');
    await userEvent.click(await screen.findByRole('button', { name: /W-884/ }));
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.choiceInvalidTitle })).toBeTruthy();
    expect(screen.getByText(ASSISTANT_CHOICE_INVALID_SENTENCE)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.askAgain }));
    await vi.waitFor(() => expect(h.sent).toHaveLength(3));
    expect(h.sent[2]).toMatchObject({ message: 'and the other widget?' });
  });

  it('keeps the clarification pickable with the failure beside it when the run of a pick fails, and Try again sends the same pick', async () => {
    let picks = 0;
    const h = harness(async (request) => ('choice' in request ? (++picks === 1 ? { ok: false as const, failure: { code: 'SOURCE_BUSY', message: 'x', retryable: true, traceId: 't' } } : ok(REFUSE)) : ok(CLARIFICATION)));
    render(h.tree());
    await typeAndSend('and the other widget?');
    await userEvent.click(await screen.findByRole('button', { name: /W-884/ }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.clarifyTitle })).toBeTruthy();
    expect(screen.getByRole('button', { name: /W-217/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    expect(h.sent[2]).toMatchObject({ choice: choiceFor('W-884') });
  });

  it('puts the clarification back when Cancel stops a pick that is out, and drops an answer that arrives after it', async () => {
    let release: () => void = () => undefined;
    const h = harness(async (request) => ('choice' in request ? new Promise((resolve) => void (release = () => resolve(ok(REFUSE)))) : ok(CLARIFICATION)));
    render(h.tree());
    await typeAndSend('and the other widget?');
    await userEvent.click(await screen.findByRole('button', { name: /W-884/ }));
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.cancel }));
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.clarifyTitle })).toBeTruthy();
    await act(async () => release());
    expect(screen.queryByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeNull();
  });

  it('replaces the card with the Cancelled turn on Cancel, sends nothing more and gives the message back to the field', async () => {
    const h = harness(async () => ok(CLARIFICATION));
    render(h.tree());
    await typeAndSend('and the other widget?');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.cancel }));
    expect(await screen.findByText(ASSISTANT_COPY.cancelledTitle)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.clarifyTitle })).toBeNull();
    expect(h.sent).toHaveLength(1);
    const field: HTMLTextAreaElement = await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    expect(field.value).toBe('and the other widget?');
    expect(document.activeElement).toBe(field);
  });

  it('keeps the card while the analyst types another message, and leaves a failure of the next turn beside it', async () => {
    let calls = 0;
    const h = harness(async () => (++calls === 1 ? ok(CLARIFICATION) : { ok: false, failure: { code: 'SOURCE_BUSY', message: 'x', retryable: true, traceId: 't' } }));
    render(h.tree());
    await typeAndSend('and the other widget?');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.clarifyTitle });
    await typeAndSend('never mind, show me the account');
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.clarifyTitle })).toBeTruthy();
  });

  it('clears the card with the thread when the masking changes', async () => {
    const h = harness(async () => ok(CLARIFICATION));
    render(h.tree());
    await typeAndSend('and the other widget?');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.clarifyTitle });
    h.session.clear({});
    expect(await screen.findByText(ASSISTANT_COPY.intro)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.clarifyTitle })).toBeNull();
  });
});
