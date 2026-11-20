import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSISTANT_SUMMARY_INVALID_SENTENCE, type AssistantTurnAnswer } from '@neburyx/contracts';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { harness, messageOf, RECORD, REFUSE, typeAndSend } from './assistant-kit.js';
import type { AttachedSummary } from './assistant-session.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const ARRIVED = Date.UTC(2026, 10, 20, 9, 46);
const SUMMARY: AttachedSummary = { token: 'v1.tok', sentences: ['Account A and account B both used device D.', 'Account A is linked to a customer.', 'Account A sent one transaction.'], model: 'claude-sonnet-5-5', arrivedAt: ARRIVED, status: 'attached' };
const ok = (value: AssistantTurnAnswer) => ({ ok: true as const, value });

function withSummary(turn: Parameters<typeof harness>[0], summary: AttachedSummary = SUMMARY) {
  const h = harness(turn);
  h.session.store.setState({ ...h.session.store.getState(), summary });
  return h;
}

describe('the summary handed to the Assistant thread', () => {
  it('shows the collapsed context block of frame AS8b: the first sentence, how many more, and that it is used for this thread only', async () => {
    const h = withSummary(async () => ok(REFUSE));
    render(h.tree());
    expect(screen.getByRole('region', { name: ASSISTANT_COPY.summaryContext })).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.summaryContextTag)).toBeTruthy();
    expect(screen.getByText('3 sentences · drafted 09:46 UTC · Model: claude-sonnet-5-5')).toBeTruthy();
    expect(screen.getByText('Account A and account B both used device D.')).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.summaryUsedFor)).toBeTruthy();
    expect(screen.getByText('Account A is linked to a customer.').closest('[hidden]')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '+ 2 more sentences' }));
    expect(screen.getByText('Account A is linked to a customer.').closest('[hidden]')).toBeNull();
    const less = screen.getByRole('button', { name: 'Show fewer sentences' });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(less.getAttribute('aria-controls') ?? '')?.contains(screen.getByText('Account A is linked to a customer.'))).toBe(true);
  });

  it('shows the chip and the follow-up placeholder while attached, and sends the token with each message and with no other request', async () => {
    const h = withSummary(async () => ok(REFUSE));
    render(h.tree());
    expect(screen.getByText(ASSISTANT_COPY.summaryAsking)).toBeTruthy();
    expect(screen.getByPlaceholderText(ASSISTANT_COPY.summaryPlaceholder)).toBeTruthy();
    await typeAndSend('which claim rests on the device?');
    expect(h.sent).toHaveLength(1);
    expect(messageOf(h.sent[0])).toBe('which claim rests on the device?');
    expect(h.sent[0]).toMatchObject({ summaryToken: 'v1.tok' });
  });

  it('stops sending the token when the chip is removed, and leaves the block and the thread as they are', async () => {
    const h = withSummary(async () => ok(REFUSE));
    render(h.tree());
    await typeAndSend('first');
    await screen.findByText(REFUSE.status === 'answered' && REFUSE.route === 'refuse' ? REFUSE.sentence : '');
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.summaryRemove }));
    expect(screen.queryByText(ASSISTANT_COPY.summaryAsking)).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.summaryContextTag)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.summaryNoLonger)).toBeNull();
    expect(screen.getByRole('region', { name: ASSISTANT_COPY.summaryContext })).toBeTruthy();
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByPlaceholderText(ASSISTANT_COPY.placeholder)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText(ASSISTANT_COPY.fieldLabel));
    await typeAndSend('second');
    expect(h.sent).toHaveLength(2);
    expect('summaryToken' in (h.sent[1] ?? {})).toBe(false);
  });

  it('keeps the remove control before the field and the field before Send in the order of the form', async () => {
    const h = withSummary(async () => ok(REFUSE));
    render(h.tree());
    const remove = screen.getByRole('button', { name: ASSISTANT_COPY.summaryRemove });
    const field = screen.getByLabelText(ASSISTANT_COPY.fieldLabel);
    const send = screen.getByRole('button', { name: /Send/ });
    expect(remove.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the expand control, the thread, the remove control, the field and Send in that order', async () => {
    const h = withSummary(async () => ok(REFUSE));
    render(h.tree());
    const order = [screen.getByRole('button', { name: '+ 2 more sentences' }), screen.getByRole('button', { name: ASSISTANT_COPY.summaryRemove }), screen.getByLabelText(ASSISTANT_COPY.fieldLabel), screen.getByRole('button', { name: /Send/ })];
    for (let index = 0; index < order.length - 1; index += 1) expect(order[index]?.compareDocumentPosition(order[index + 1] as HTMLElement) ?? 0).toBeGreaterThan(0);
    for (let index = 0; index < order.length - 1; index += 1) expect((order[index]?.compareDocumentPosition(order[index + 1] as HTMLElement) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('answers a refused summary with its card, removes the chip, marks the block and gives the message back', async () => {
    const h = withSummary(async () => ok({ status: 'summary-invalid', sentence: ASSISTANT_SUMMARY_INVALID_SENTENCE }));
    render(h.tree());
    await typeAndSend('which claim rests on the device?');
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.summaryInvalidTitle })).toBeTruthy();
    expect(screen.getByText(ASSISTANT_SUMMARY_INVALID_SENTENCE)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.summaryAsking)).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.summaryNoLonger)).toBeTruthy();
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).value).toBe('which claim rests on the device?');
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.askAgain })).toBeNull();
  });

  it('sends no token when no summary is attached', async () => {
    const h = harness(async () => ok(REFUSE));
    render(h.tree());
    await typeAndSend('hello');
    expect('summaryToken' in (h.sent[0] ?? {})).toBe(false);
  });
});

describe('the summary cleared from the thread', () => {
  function bound(summary: AttachedSummary | undefined) {
    const h = harness(async () => ok(REFUSE));
    const stop = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
    h.session.store.setState({ ...h.session.store.getState(), summary });
    return { ...h, stop };
  }

  it('shows the notice of frame AS8c and sends no token again when the masking changes with a summary attached and no turn sent', async () => {
    const h = bound(SUMMARY);
    render(h.tree());
    act(() => h.state.setMask(true));
    expect(screen.queryByRole('region', { name: ASSISTANT_COPY.summaryContext })).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.maskingTitle)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.maskingBodyWithSummary)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.maskingNoteWithSummary)).toBeTruthy();
    await typeAndSend('hello');
    expect('summaryToken' in (h.sent[0] ?? {})).toBe(false);
    h.stop();
  });

  it('clears the block with the thread on a change of the masking after turns, with the same notice', async () => {
    const h = bound(SUMMARY);
    render(h.tree());
    await typeAndSend('first');
    await screen.findByText('first');
    act(() => h.state.setMask(true));
    expect(screen.queryByText('first')).toBeNull();
    expect(screen.queryByRole('region', { name: ASSISTANT_COPY.summaryContext })).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.maskingBodyWithSummary)).toBeTruthy();
    h.stop();
  });

  it('shows the notice built today when the masking changes and no summary is attached', async () => {
    const h = bound(undefined);
    render(h.tree());
    await typeAndSend('first');
    await screen.findByText('first');
    act(() => h.state.setMask(true));
    expect(screen.getByText(ASSISTANT_COPY.maskingBody)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.maskingBodyWithSummary)).toBeNull();
    h.stop();
  });
});

describe('the other clearings of a summary attached to the thread', () => {
  function bound() {
    const h = harness(async () => ok(REFUSE));
    const stop = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
    h.session.store.setState({ ...h.session.store.getState(), summary: SUMMARY });
    return { ...h, stop };
  }

  it('clears the block with no notice when the investigation changes', async () => {
    const h = bound();
    render(h.tree());
    act(() => h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []));
    expect(screen.queryByRole('region', { name: ASSISTANT_COPY.summaryContext })).toBeNull();
    expect(h.session.store.getState().notice).toBeUndefined();
    h.stop();
  });

  it('clears the block with no notice when the status of the investigation changes', async () => {
    const h = bound();
    render(h.tree());
    act(() => h.state.describeInvestigation({ ...RECORD, status: 'closed' }));
    expect(screen.queryByRole('region', { name: ASSISTANT_COPY.summaryContext })).toBeNull();
    expect(h.session.store.getState().summary).toBeUndefined();
    expect(h.session.store.getState().notice).toBeUndefined();
    h.stop();
  });

  it.each([[true], [false]])('clears the block and shows the existing source-changed notice when the source changes (turns sent: %s)', async (turns) => {
    const h = bound();
    render(h.tree());
    if (turns) {
      await typeAndSend('first');
      await screen.findByText('first');
    }
    act(() => h.state.describeInvestigation({ ...RECORD, sourceState: 'removed' }));
    expect(h.session.store.getState().summary).toBeUndefined();
    expect(h.session.store.getState().notice).toEqual({ kind: 'source-changed' });
    h.stop();
  });
});

