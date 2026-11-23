import { ASSISTANT_CONFIRMATION_INVALID_SENTENCE, ASSISTANT_LIMIT_SENTENCES, type AssistantRead, type AssistantTurnAnswer, type AssistantTurnRequest } from '@neburyx/contracts';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { elementKey } from '../state/keys.js';
import { edge, key, node, ref } from '../state/test-data.js';
import { harness, RECORD, typeAndSend } from './assistant-kit.js';
import { confirmationQuestion, confirmationSentence } from './confirmation-card.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const PLAN = `${'1'.repeat(10)}.${'a'.repeat(120)}.${'b'.repeat(64)}`;
const PENDING = '0192f000-0000-7000-8000-0000000000a1';
const READ: AssistantRead = { tool: 'devices-of-an-account', kind: 'template', subject: 'ACC-71825', read: true, rows: 2, quality: 'exact', partial: false };
const WAITING: AssistantTurnAnswer = { status: 'confirmation', pendingId: PENDING, plan: PLAN, step: { tool: 'relationships-of-a-device', kind: 'template', subject: 'DEV-884', count: { quality: 'lowerBound', value: 1200 }, page: 25 }, reads: [READ] };
const ok = (value: AssistantTurnAnswer): ApiResult<AssistantTurnAnswer> => ({ ok: true, value });
const decisionOf = (request: AssistantTurnRequest | undefined) => (request !== undefined && 'confirmation' in request ? request : undefined);
const ANSWERED: AssistantTurnAnswer = {
  status: 'answered',
  route: 'ask',
  blocks: [{ kind: 'sentences', sentences: [{ text: 'Account acc-1 is listed.', cites: ['n1'] }] }],
  citations: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'a', entityType: 'kind-a', stableId: 'acc-1' } }],
  coverage: { retrieval: '2 shown · exact', summary: 'The answer cites 1 of the 2 elements the reads returned.' },
  model: 'claude-test',
  calls: 4,
  steps: 3,
  reads: [READ, { ...READ, tool: 'relationships-of-a-device', subject: 'DEV-884' }],
};

describe('the confirmation card of a heavy step', () => {
  it('shows the reads open above the card, then the label, the question, the sentence, the count with its quality, the buttons and both lines, with the focus on the title', async () => {
    const h = harness(async () => ok(WAITING));
    render(h.tree());
    await typeAndSend('who else uses DEV-884?');
    const title = await screen.findByRole('heading', { name: 'Read Relationships of a device for DEV-884?' });
    expect(document.activeElement).toBe(title);
    expect(screen.getByText(ASSISTANT_COPY.waitingLabel)).toBeTruthy();
    expect(screen.getByText('This read of DEV-884 is larger than one page. This would read one page of 25 rows.')).toBeTruthy();
    expect(screen.getByText('≥ 1,200 rows')).toBeTruthy();
    expect(screen.getAllByText('Lower bound').length).toBeGreaterThan(0);
    for (const name of [ASSISTANT_COPY.confirm, ASSISTANT_COPY.skip, 'Cancel']) expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.waitingSkipNote)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.waitingNothingRuns)).toBeTruthy();
    expect(document.querySelectorAll('.assistant-read')).toHaveLength(1);
    expect(document.querySelector('details.assistant-steps')).toBeNull();
  });

  it('writes the question with the label of the intent, as text, and with the humanized id when there is none', () => {
    const step = { tool: 'shared', kind: 'intent' as const, subject: 'DEV-884', count: { quality: 'unknown' as const }, page: 25 };
    expect(confirmationQuestion({ ...step, label: 'Accounts at the same bank' })).toBe('Read Accounts at the same bank for DEV-884?');
    expect(confirmationQuestion({ ...step, label: '<b>Accounts</b>' })).toBe('Read <b>Accounts</b> for DEV-884?');
    expect(confirmationQuestion(step)).toBe('Read Shared for DEV-884?');
  });

  it('writes the question and the sentence from fixed words, and shows a subject with markup as text', () => {
    const hostile = { ...WAITING.status === 'confirmation' ? WAITING.step : { tool: '', kind: 'template' as const, count: { quality: 'unknown' as const }, page: 1 }, subject: '<img src=x onerror=alert(1)>' };
    expect(confirmationQuestion(hostile)).toBe('Read Relationships of a device for <img src=x onerror=alert(1)>?');
    expect(confirmationSentence({ ...hostile, subject: undefined, page: 1 })).toBe('This read is larger than one page. This would read one page of 1 row.');
    const { container } = render(<p>{confirmationQuestion(hostile)}</p>);
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows an unknown count with no number and the Unknown chip', async () => {
    const answer: AssistantTurnAnswer = WAITING.status === 'confirmation' ? { ...WAITING, step: { ...WAITING.step, count: { quality: 'unknown' } } } : WAITING;
    const h = harness(async () => ok(answer));
    render(h.tree());
    await typeAndSend('go');
    expect(await screen.findByText('Unknown', { selector: '.assistant-waiting-count .ask-tag' })).toBeTruthy();
    expect(document.querySelector('.assistant-waiting-count')?.textContent).toBe('Unknown');
  });

  it('sends Confirm with the plan, the message and the view of the waiting turn, shows the working state with the buttons gone, and goes on in the same turn', async () => {
    let finish: (value: ApiResult<AssistantTurnAnswer>) => void = () => undefined;
    const h = harness((request) => (decisionOf(request) === undefined ? Promise.resolve(ok(WAITING)) : new Promise((resolve) => (finish = resolve))));
    render(h.tree());
    await typeAndSend('who else uses DEV-884?');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.confirm }));
    expect(screen.getByRole('status').textContent).toBe(ASSISTANT_COPY.working);
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.confirm })).toBeNull();
    expect(decisionOf(h.sent[1])).toMatchObject({ message: 'who else uses DEV-884?', viewElementKeys: [], confirmation: { pendingId: PENDING, plan: PLAN, decision: 'confirm' } });
    await act(async () => finish(ok(ANSWERED)));
    expect(await screen.findByText('Account acc-1 is listed.')).toBeTruthy();
    expect(document.querySelectorAll('.assistant-message')).toHaveLength(1);
  });

  it('sends the view of the waiting turn, and not the view of now, when the view changes while the card waits', async () => {
    const A = ref('a', 'type-a', 'ent-1');
    const B = ref('a', 'type-a', 'ent-2');
    const E = edge('a', 'rel-1', 'ent-1', 'ent-2');
    const h = harness(async (request) => ok(decisionOf(request) === undefined ? WAITING : ANSWERED));
    h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A], edgeRefs: [] }, [{ key: key('a'), result: { sourceId: 'a', nodes: [node('a', 'ent-1')], edges: [] } }]);
    render(h.tree());
    await typeAndSend('go');
    await screen.findByRole('button', { name: ASSISTANT_COPY.confirm });
    const before = h.sent[0]?.viewElementKeys;
    expect(before).toEqual([elementKey(A)]);
    act(() => h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A, B], edgeRefs: [E.ref] }, [{ key: key('a'), result: { sourceId: 'a', nodes: [node('a', 'ent-1'), node('a', 'ent-2')], edges: [E] } }]));
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.confirm }));
    await screen.findByText('Account acc-1 is listed.');
    expect(decisionOf(h.sent[1])?.viewElementKeys).toEqual(before);
  });

  it('names the cited elements by the titles the server gave when they are not drawn, for an entity and a relationship', async () => {
    const named: AssistantTurnAnswer = {
      ...ANSWERED,
      citations: [
        { key: 'r1', kind: 'entity', ref: { sourceId: 'a', entityType: 'kind-a', stableId: 'acc-9' }, title: 'Eversiais Interiors Inc.' },
        { key: 'r5', kind: 'relationship', ref: { sourceId: 'a', relType: 'MADE_FROM', stableId: 'rel-9', from: { sourceId: 'a', entityType: 'kind-a', stableId: 'acc-9' }, to: { sourceId: 'a', entityType: 'kind-b', stableId: 'gt-1' } } as never, title: 'MADE_FROM: Eversiais Interiors Inc. → GT-1' },
      ],
      blocks: [{ kind: 'sentences', sentences: [{ text: 'Eversiais Interiors Inc. is linked to GT-1.', cites: ['r1', 'r5'] }] }],
    } as AssistantTurnAnswer;
    const h = harness(async () => ok(named));
    render(h.tree());
    await typeAndSend('who?');
    await screen.findByText('Eversiais Interiors Inc. is linked to GT-1.');
    await userEvent.click(screen.getByRole('button', { name: /^Sources · 2/ }));
    expect(screen.getAllByText(/Eversiais Interiors Inc\./).length).toBeGreaterThan(1);
    expect(screen.queryByText(/Entity r1|Relationship r5/)).toBeNull();
  });

  it('sends Skip as its own decision', async () => {
    const h = harness(async (request) => ok(decisionOf(request) === undefined ? WAITING : ANSWERED));
    render(h.tree());
    await typeAndSend('go');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.skip }));
    await screen.findByText('Account acc-1 is listed.');
    expect(decisionOf(h.sent[1])?.confirmation.decision).toBe('skip');
  });

  it('sends the cancel decision from the card, shows the turn as cancelled and puts the message back', async () => {
    const h = harness(async (request) => ok(decisionOf(request) === undefined ? WAITING : { status: 'cancelled' }));
    render(h.tree());
    await typeAndSend('keep this message');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.cancelledTitle })).toBeTruthy();
    expect(decisionOf(h.sent[1])?.confirmation.decision).toBe('cancel');
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).value).toBe('keep this message');
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.confirm })).toBeNull();
  });

  it('sends one decision for a double press', async () => {
    const h = harness((request) => (decisionOf(request) === undefined ? Promise.resolve(ok(WAITING)) : new Promise(() => undefined)));
    render(h.tree());
    await typeAndSend('go');
    const confirm = await screen.findByRole('button', { name: ASSISTANT_COPY.confirm });
    await userEvent.dblClick(confirm);
    expect(h.sent.filter((request) => decisionOf(request) !== undefined)).toHaveLength(1);
  });

  it('answers a confirmation that is no longer valid with its fixed sentence and Ask again, and nothing was read', async () => {
    const h = harness(async (request) => ok(decisionOf(request) === undefined ? WAITING : { status: 'confirmation-invalid', sentence: ASSISTANT_CONFIRMATION_INVALID_SENTENCE }));
    render(h.tree());
    await typeAndSend('go');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.confirm }));
    expect(await screen.findByText(ASSISTANT_CONFIRMATION_INVALID_SENTENCE)).toBeTruthy();
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.askAgain })).toBeTruthy();
  });

  it('offers Ask again, which sends the message and not the decision, after a decision that began to read and failed', async () => {
    const h = harness(async (request) => (decisionOf(request) === undefined ? ok(WAITING) : ok({ status: 'unavailable', kind: 'source-unavailable', readStarted: true })));
    render(h.tree());
    await typeAndSend('who else uses DEV-884?');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.confirm }));
    const again = await screen.findByRole('button', { name: ASSISTANT_COPY.askAgain });
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.tryAgain })).toBeNull();
    await userEvent.click(again);
    await screen.findByRole('button', { name: ASSISTANT_COPY.confirm });
    expect(h.sent.map((request) => (decisionOf(request) === undefined ? 'message' : 'decision'))).toEqual(['message', 'decision', 'message']);
  });

  it('offers Try again, which sends the decision again, after a failure before anything was read', async () => {
    let attempts = 0;
    const h = harness(async (request) => {
      if (decisionOf(request) === undefined) return ok(WAITING);
      attempts += 1;
      return attempts === 1 ? ok({ status: 'unavailable', kind: 'service', readStarted: false }) : ok(ANSWERED);
    });
    render(h.tree());
    await typeAndSend('go');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.confirm }));
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    await screen.findByText('Account acc-1 is listed.');
    expect(h.sent.filter((request) => decisionOf(request) !== undefined)).toHaveLength(2);
  });

  it('takes the buttons away from a card when another message is sent, and keeps the reads', async () => {
    const h = harness(async (request) => ok(messageOfRequest(request) === 'second' ? ANSWERED : WAITING));
    render(h.tree());
    await typeAndSend('first');
    await screen.findByRole('button', { name: ASSISTANT_COPY.confirm });
    await typeAndSend('second');
    await screen.findByText('Account acc-1 is listed.');
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.confirm })).toBeNull();
    expect(screen.getByText(ASSISTANT_COPY.waitingClosed)).toBeTruthy();
  });

  it('shows a stored turn that was waiting with the fixed line and no button', async () => {
    const h = harness(async () => ok(VIEW_ANSWER), 1000, async () => ({ ok: true, value: { turns: [{ seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'waiting', intent: 'shared', citedElements: 0, steps: 1 }], earlierTurns: 0, previousThreadClearedAt: null } }));
    render(h.tree());
    expect(await screen.findByText(ASSISTANT_COPY.waitingClosed)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.confirm })).toBeNull();
  });
});

const VIEW_ANSWER: AssistantTurnAnswer = { status: 'not-answered', route: 'view', sentence: 'x' };
const messageOfRequest = (request: AssistantTurnRequest): string | undefined => ('message' in request ? request.message : undefined);

describe('the limits are not lifted by a confirmation', () => {
  it('has fixed limit sentences with no digit, which a decision that meets a limit answers with', () => {
    for (const sentence of Object.values(ASSISTANT_LIMIT_SENTENCES)) expect(sentence).not.toMatch(/\d/);
  });
});
