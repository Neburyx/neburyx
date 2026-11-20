import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { askAnswerSchema, type AssistantTurnAnswer } from '@neburyx/contracts';
import { harness, REFUSE, typeAndSend } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const TOKEN = `${'1'.repeat(10)}.${'a'.repeat(64)}`;
const ENTITY = { ref: { sourceId: 'a', entityType: 'kind-a', stableId: 'acc-1' }, display: { title: 'acc-1', type: 'kind-a' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
const choiceFor = (intent: string, stableId: string) => ({ intent, roles: ['id'], entities: { id: stableId }, choiceToken: TOKEN });
const answered = (followUps: NonNullable<Extract<AssistantTurnAnswer, { status: 'answered'; route: 'ask' }>['followUps']>): AssistantTurnAnswer => ({
  status: 'answered',
  route: 'ask',
  answer: askAnswerSchema.parse({ answered: { intent: 'accounts-paid-by', entities: { targetId: 'acc-1' }, outcome: 'complete', result: { templateId: 'entity', result: ENTITY } } }),
  followUps,
});
const CHIPS = [
  { titles: ['acc-1'], choice: choiceFor('accounts-paid-to', 'acc-1') },
  { titles: ['acc-1', 'acc-2'], choice: choiceFor('paths-between', 'acc-1') },
];
const ok = (value: AssistantTurnAnswer) => ({ ok: true as const, value });

describe('the Assistant panel: follow-ups under an answer', () => {
  it('shows a row of follow-ups under the answered turn, each named by the humanised intent name and the titles of its elements', async () => {
    const h = harness(async () => ok(answered(CHIPS)));
    render(h.tree());
    await typeAndSend('who paid acc-1?');
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.followUps })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accounts paid to · acc-1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Paths between · acc-1, acc-2' })).toBeTruthy();
  });

  it('shows no row when the answer has no follow-ups, and none under an answer that is no longer the last', async () => {
    let calls = 0;
    const h = harness(async () => ok(++calls === 1 ? answered(CHIPS) : answered([])));
    render(h.tree());
    await typeAndSend('who paid acc-1?');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.followUps });
    await typeAndSend('and again?');
    await act(async () => undefined);
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.followUps })).toBeNull();
  });

  it('sends the follow-up as a choice with no message, as a turn of its own named by its label, and shows its answer', async () => {
    const h = harness(async (request) => ok('choice' in request ? REFUSE : answered(CHIPS)));
    render(h.tree());
    await typeAndSend('who paid acc-1?');
    await userEvent.click(await screen.findByRole('button', { name: 'Paths between · acc-1, acc-2' }));
    expect(await screen.findByText(ASSISTANT_COPY.notAnswered)).toBeTruthy();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ choice: CHIPS[1]?.choice });
    expect('message' in (h.sent[1] ?? {})).toBe(false);
    expect(screen.getAllByText('Paths between · acc-1, acc-2').length).toBeGreaterThan(0);
  });

  it('is operated by the keyboard and is off while a turn is out', async () => {
    let release: () => void = () => undefined;
    const h = harness(async (request) => ('choice' in request ? new Promise((resolve) => void (release = () => resolve(ok(REFUSE)))) : ok(answered(CHIPS))));
    render(h.tree());
    await typeAndSend('who paid acc-1?');
    const first = await screen.findByRole('button', { name: 'Accounts paid to · acc-1' });
    first.focus();
    await userEvent.keyboard('{Enter}');
    expect((await screen.findByRole('button', { name: 'Paths between · acc-1, acc-2' })).hasAttribute('disabled')).toBe(true);
    await act(async () => release());
    expect(await screen.findByText(ASSISTANT_COPY.notAnswered)).toBeTruthy();
  });

  it('answers a follow-up that is no longer valid with its card, no button to ask again, and leaves the follow-ups where they were', async () => {
    const h = harness(async (request) => ok('choice' in request ? { status: 'choice-invalid', sentence: 'This choice is no longer valid. Nothing was read.' } : answered(CHIPS)));
    render(h.tree());
    await typeAndSend('who paid acc-1?');
    await userEvent.click(await screen.findByRole('button', { name: 'Accounts paid to · acc-1' }));
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.followUpInvalidTitle })).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.followUpInvalid)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.askAgain })).toBeNull();
    expect(screen.getByRole('button', { name: 'Paths between · acc-1, acc-2' })).toBeTruthy();
  });

  it('shows a failure of the run with Try again, which sends the same follow-up', async () => {
    let presses = 0;
    const h = harness(async (request) => ('choice' in request ? (++presses === 1 ? { ok: false as const, failure: { code: 'SOURCE_BUSY', message: 'x', retryable: true, traceId: 't' } } : ok(REFUSE)) : ok(answered(CHIPS))));
    render(h.tree());
    await typeAndSend('who paid acc-1?');
    await userEvent.click(await screen.findByRole('button', { name: 'Accounts paid to · acc-1' }));
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    expect(await screen.findByText(ASSISTANT_COPY.notAnswered)).toBeTruthy();
    expect(h.sent[2]).toMatchObject({ choice: CHIPS[0]?.choice });
  });

  it('shows Cancelled for a follow-up that is stopped and does not put its label in the field', async () => {
    const h = harness(async (request) => ('choice' in request ? new Promise(() => undefined) : ok(answered(CHIPS))));
    render(h.tree());
    await typeAndSend('who paid acc-1?');
    await userEvent.click(await screen.findByRole('button', { name: 'Accounts paid to · acc-1' }));
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.cancel }));
    expect(await screen.findByText(ASSISTANT_COPY.cancelledTitle)).toBeTruthy();
    const field: HTMLTextAreaElement = await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    expect(field.value).toBe('');
  });
});
