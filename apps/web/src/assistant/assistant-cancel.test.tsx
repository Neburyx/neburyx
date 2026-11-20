import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { askAnswerSchema, ASSISTANT_NOT_ANSWERED_SENTENCE, ASSISTANT_REFUSAL_SENTENCES, type AssistantTurnAnswer, type AssistantTurnRequest } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { heavyRun, okRun } from '../patterns/patterns-kit.js';
import { continueOf, harness, REFUSE, typeAndSend, VIEW } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

type Held = { readonly signal: AbortSignal | undefined; readonly finish: (value: ApiResult<AssistantTurnAnswer>) => void };

function heldHarness(limit = 1000) {
  const held: Held[] = [];
  const h = harness(
    (_request, signal) =>
      new Promise((resolve) => {
        held.push({ signal, finish: resolve });
      }),
    limit,
  );
  return { h, held };
}

const cancelButton = () => screen.getByRole('button', { name: ASSISTANT_COPY.cancel });
const field = () => screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement;

describe('the Assistant panel: Cancel', () => {
  it('shows a failure turn, not the Cancelled turn, when the request fails', async () => {
    const h = harness(async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    render(h.tree());
    await typeAndSend('first');
    expect(await screen.findByRole('button', { name: ASSISTANT_COPY.tryAgain })).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.cancelledTitle)).toBeNull();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.cancel })).toBeNull();
  });

  it('shows no Cancel before a turn is sent, and none once the turn has its answer', async () => {
    const { h, held } = heldHarness();
    render(h.tree());
    expect(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.cancel })).toBeNull();
    await typeAndSend('first');
    expect(cancelButton()).toBeTruthy();
    await act(async () => held[0]?.finish({ ok: true, value: VIEW }));
    expect(await screen.findByText(ASSISTANT_NOT_ANSWERED_SENTENCE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.cancel })).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.cancelledTitle)).toBeNull();
    expect(screen.getByRole('button', { name: /Send/ })).toBeTruthy();
  });

  it('replaces Send with Cancel and the hint while a turn is out, with the input still disabled', async () => {
    const { h } = heldHarness();
    render(h.tree());
    await typeAndSend('first');
    expect(cancelButton()).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.cancelHint)).toBeTruthy();
    expect(field().readOnly).toBe(true);
    expect(field().getAttribute('aria-disabled')).toBe('true');
  });

  it('moves the focus to Cancel when a turn goes out, so the field is not the focused element while it waits', async () => {
    const { h } = heldHarness();
    render(h.tree());
    await typeAndSend('first');
    expect(document.activeElement).toBe(cancelButton());
  });

  it('aborts the request on Cancel, shows the Cancelled turn, puts the message back in the input and focuses it', async () => {
    const { h, held } = heldHarness();
    render(h.tree());
    await typeAndSend('who shares a device?');
    await userEvent.click(cancelButton());
    expect(held[0]?.signal?.aborted).toBe(true);
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.cancelledTitle })).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.cancelledBody)).toBeTruthy();
    expect(field().value).toBe('who shares a device?');
    expect(field().readOnly).toBe(false);
    expect(document.activeElement).toBe(field());
    expect(screen.getByRole('button', { name: /Send/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.cancel })).toBeNull();
  });

  it('drops the late answer of a cancelled request and changes nothing on screen', async () => {
    const { h, held } = heldHarness();
    render(h.tree());
    await typeAndSend('first');
    await userEvent.click(cancelButton());
    await act(async () => held[0]?.finish({ ok: true, value: REFUSE }));
    expect(screen.queryByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeNull();
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.cancelledTitle })).toBeTruthy();
    expect(field().value).toBe('first');
  });

  it('sends the restored message as a new request, and the late answer of the cancelled one never settles it', async () => {
    const { h, held } = heldHarness();
    render(h.tree());
    await typeAndSend('first');
    await userEvent.click(cancelButton());
    await userEvent.type(field(), '{Enter}');
    expect(h.sent).toHaveLength(2);
    await act(async () => held[0]?.finish({ ok: true, value: REFUSE }));
    expect(screen.queryByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeNull();
    expect(cancelButton()).toBeTruthy();
    await act(async () => held[1]?.finish({ ok: true, value: VIEW }));
    expect(await screen.findByText(ASSISTANT_NOT_ANSWERED_SENTENCE)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeNull();
  });

  it('reaches Cancel with Tab and activates it with Enter and with Space', async () => {
    for (const key of ['{Enter}', ' ']) {
      cleanup();
      const { h, held } = heldHarness();
      render(h.tree());
      await typeAndSend('first');
      cancelButton().focus();
      expect(document.activeElement).toBe(cancelButton());
      await userEvent.keyboard(key);
      expect(held[0]?.signal?.aborted).toBe(true);
      expect(screen.getByRole('heading', { name: ASSISTANT_COPY.cancelledTitle })).toBeTruthy();
    }
  });

  it('keeps the earlier turns when a later one is cancelled', async () => {
    const { h, held } = heldHarness();
    render(h.tree());
    await typeAndSend('first');
    await act(async () => held[0]?.finish({ ok: true, value: VIEW }));
    await screen.findByText(ASSISTANT_NOT_ANSWERED_SENTENCE);
    await typeAndSend('second');
    await userEvent.click(cancelButton());
    expect(screen.getByText(ASSISTANT_NOT_ANSWERED_SENTENCE)).toBeTruthy();
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.cancelledTitle })).toBeTruthy();
  });
});

const TOKEN = `${'1'.repeat(10)}.${'a'.repeat(64)}`;
const inAnswer = (answer: unknown): AssistantTurnAnswer => ({ status: 'answered', route: 'ask', answer: askAnswerSchema.parse(answer) });
const HEAVY = inAnswer({ answered: { intent: 'shared-devices', entities: { account: 'acc-1' }, outcome: 'complete', continueToken: TOKEN, result: { templateId: 'shared-attribute', result: heavyRun() } } });
const CONTINUED = inAnswer({ answered: { intent: 'shared-devices', entities: { account: 'acc-1' }, outcome: 'complete', result: { templateId: 'shared-attribute', result: okRun(['acc-2']) } } });

/** A thread whose first turn is a heavy stop, whose continues are held until the test finishes them. */
function continuedHarness() {
  const continues: Held[] = [];
  const h = harness((request: AssistantTurnRequest, signal) =>
    continueOf(request) === undefined
      ? Promise.resolve({ ok: true, value: HEAVY })
      : new Promise((resolve) => {
          continues.push({ signal, finish: resolve });
        }),
  );
  return { h, continues };
}

const continueButton = () => screen.getByRole('button', { name: ASSISTANT_COPY.continue });

describe('the Assistant panel: Cancel of a continued heavy turn', () => {
  it('shows Cancel and the hint while a continue is out, with Send gone', async () => {
    const { h } = continuedHarness();
    render(h.tree());
    await typeAndSend('big one');
    await screen.findByText('Lower bound');
    await userEvent.click(continueButton());
    expect(cancelButton()).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.cancelHint)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull();
  });

  it('aborts the continue and returns the turn to its heavy stop with Continue available, no Cancelled turn and the focus on the stop', async () => {
    const { h, continues } = continuedHarness();
    render(h.tree());
    await typeAndSend('big one');
    await screen.findByText('Lower bound');
    await userEvent.click(continueButton());
    await userEvent.click(cancelButton());
    expect(continues[0]?.signal?.aborted).toBe(true);
    expect(screen.getByText('Lower bound')).toBeTruthy();
    expect(continueButton()).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.cancelledTitle)).toBeNull();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.cancel })).toBeNull();
    expect(document.activeElement?.getAttribute('data-ask-focus')).toBe('title');
    expect(field().value).toBe('');
  });

  it('drops the late answer of a cancelled continue and sends the next Continue with the same token, which that late answer never settles', async () => {
    const { h, continues } = continuedHarness();
    render(h.tree());
    await typeAndSend('big one');
    await screen.findByText('Lower bound');
    await userEvent.click(continueButton());
    await userEvent.click(cancelButton());
    await act(async () => continues[0]?.finish({ ok: true, value: CONTINUED }));
    expect(screen.getByText('Lower bound')).toBeTruthy();
    await userEvent.click(continueButton());
    expect(h.sent).toHaveLength(3);
    expect(continueOf(h.sent[2])).toEqual({ intent: 'shared-devices', entities: { account: 'acc-1' }, continueToken: TOKEN });
    expect(screen.queryByRole('heading', { name: 'Answer ready' })).toBeNull();
    await act(async () => continues[1]?.finish({ ok: true, value: CONTINUED }));
    expect(await screen.findByRole('heading', { name: 'Answer ready' })).toBeTruthy();
  });

  it('shows the failure turn, not the heavy stop, when the continue fails, and the continue-invalid turn for an expired token', async () => {
    const answers: ApiResult<AssistantTurnAnswer>[] = [{ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }, { ok: true, value: { status: 'continue-invalid', sentence: 'expired' } }];
    const h = harness(async (request) => (continueOf(request) === undefined ? { ok: true, value: HEAVY } : (answers.shift() ?? { ok: true, value: HEAVY })));
    render(h.tree());
    await typeAndSend('big one');
    await screen.findByText('Lower bound');
    await userEvent.click(continueButton());
    expect(await screen.findByRole('button', { name: ASSISTANT_COPY.tryAgain })).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.cancelledTitle)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.continueInvalidTitle })).toBeTruthy();
  });
});
