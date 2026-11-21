import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASK_REFUSAL_CAUSES, ASK_REFUSAL_SENTENCES, valueNotFitSentence, ASSISTANT_NOT_ANSWERED_SENTENCE, ASSISTANT_REFUSAL_CAUSES, ASSISTANT_REFUSAL_SENTENCES, askAnswerSchema, type AssistantTurnAnswer } from '@neburyx/contracts';
import { AiActionsProvider, createAiActions } from '../ai/ai-actions.js';
import { UNAVAILABLE_REASON } from '../ai/copy.js';
import { registerPathsTool } from '../paths/paths-tool.js';
import { hintOf } from '../ask/text.js';
import { registerFiltersTool } from '../workspace/filters-tool.js';
import { harness, typeAndSend, VIEW } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const refusal = (cause: (typeof ASSISTANT_REFUSAL_CAUSES)[number]): AssistantTurnAnswer => ({ status: 'answered', route: 'refuse', cause, sentence: ASSISTANT_REFUSAL_SENTENCES[cause] });

function setup(options: { cause?: (typeof ASSISTANT_REFUSAL_CAUSES)[number]; summary?: boolean; handler?: boolean; filters?: boolean; paths?: 'action' | 'flyout'; answers?: AssistantTurnAnswer[] } = {}) {
  const answers = options.answers ?? [refusal(options.cause ?? 'verdict')];
  const h = harness(async () => ({ ok: true, value: answers.shift() ?? VIEW }), 1000, undefined, options.summary ?? true);
  if (options.filters !== false) registerFiltersTool(h.tools, h.state);
  if (options.paths === 'action') registerPathsTool(h.tools, h.state);
  if (options.paths === 'flyout') h.tools.register({ id: 'paths', label: 'Paths', icon: null, order: 30, kind: { type: 'flyout', content: () => null } });
  const actions = createAiActions();
  const summarize = vi.fn();
  if (options.handler !== false) actions.register('summarize', summarize);
  render(<AiActionsProvider value={actions}>{h.tree()}</AiActionsProvider>);
  return { h, summarize };
}

const chip = (name: string) => screen.getByRole('button', { name });

describe('the Assistant thread: the refusal card and its chips', () => {
  it.each(ASSISTANT_REFUSAL_CAUSES)('shows the %s refusal titled Not answered with its fixed sentence under the message as typed, and the chips, without the old tag', async (cause) => {
    setup({ cause });
    await typeAndSend('a message as typed');
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered })).toBeTruthy();
    expect(screen.getByText(ASSISTANT_REFUSAL_SENTENCES[cause])).toBeTruthy();
    expect(screen.getByText('a message as typed')).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.routeRefuse, { selector: 'p' })).toBeNull();
    expect(chip(ASSISTANT_COPY.openFilters)).toBeTruthy();
    expect(await screen.findByRole('button', { name: ASSISTANT_COPY.summarizeView })).toBeTruthy();
  });

  it('leaves out Open Filters when the Filters tool is not registered, and keeps the rest of the card', async () => {
    setup({ filters: false });
    await typeAndSend('is it fraud?');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered });
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.openFilters })).toBeNull();
    expect(await screen.findByRole('button', { name: ASSISTANT_COPY.summarizeView })).toBeTruthy();
  });

  it('opens the Filters tool on Open Filters and leaves it open on a second activation', async () => {
    const { h } = setup();
    await typeAndSend('is it fraud?');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.openFilters }));
    expect(h.state.presentation.view.getState().filtersOpen).toBe(true);
    await userEvent.click(chip(ASSISTANT_COPY.openFilters));
    expect(h.state.presentation.view.getState().filtersOpen).toBe(true);
  });

  it('offers no Summarize this view when no summarize action is registered, so no chip is a dead button', async () => {
    setup({ handler: false });
    await typeAndSend('is it fraud?');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered });
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.summarizeView })).toBeNull();
  });

  it('runs the summarize action once on Summarize this view', async () => {
    const { summarize } = setup();
    await typeAndSend('is it fraud?');
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.summarizeView }));
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('dims Summarize this view with the reason when the summary is not available, and runs nothing on activation', async () => {
    const { summarize } = setup({ summary: false });
    await typeAndSend('is it fraud?');
    const summarizeChip = await screen.findByRole('button', { name: ASSISTANT_COPY.summarizeView });
    expect(summarizeChip.getAttribute('aria-disabled')).toBe('true');
    expect(within(summarizeChip.parentElement as HTMLElement).getByText(UNAVAILABLE_REASON)).toBeTruthy();
    await userEvent.click(summarizeChip);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('reaches each chip with Tab and activates it with Enter and with Space', async () => {
    const { h, summarize } = setup({ answers: [refusal('verdict'), refusal('verdict')] });
    await typeAndSend('first');
    const open = await screen.findByRole('button', { name: ASSISTANT_COPY.openFilters });
    open.focus();
    await userEvent.keyboard('{Enter}');
    expect(h.state.presentation.view.getState().filtersOpen).toBe(true);
    const summarizeChip = chip(ASSISTANT_COPY.summarizeView);
    await userEvent.tab();
    expect(document.activeElement).toBe(summarizeChip);
    await userEvent.keyboard(' ');
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('keeps the earlier turns on screen and shows no word of a model', async () => {
    setup({ answers: [VIEW, refusal('raw-query')] });
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_NOT_ANSWERED_SENTENCE);
    await typeAndSend('second');
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES['raw-query'])).toBeTruthy();
    expect(screen.getByText(ASSISTANT_NOT_ANSWERED_SENTENCE)).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: ASSISTANT_COPY.notAnswered })).toHaveLength(2);
  });
});

describe('the Assistant thread: Open Paths', () => {
  const left = ASSISTANT_COPY.pathsLeftOut;
  const openPaths = () => screen.queryByRole('button', { name: ASSISTANT_COPY.openPaths });

  it('leaves out Open Paths and says so when the Paths tool is not registered', async () => {
    setup();
    await typeAndSend('is it fraud?');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered });
    expect(openPaths()).toBeNull();
    expect(screen.getByText(left)).toBeTruthy();
  });

  it('leaves out Open Paths and says so when the Paths tool is registered as a flyout', async () => {
    setup({ paths: 'flyout' });
    await typeAndSend('is it fraud?');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered });
    expect(openPaths()).toBeNull();
    expect(screen.getByText(left)).toBeTruthy();
  });

  it('offers Open Paths after the other chips when the tool is an action, opens Paths and leaves it open on a second activation', async () => {
    const { h } = setup({ paths: 'action' });
    await typeAndSend('is it fraud?');
    const chips = await screen.findAllByRole('button', { name: /^(Open Filters|Summarize this view|Open Paths)$/ });
    expect(chips.map((button) => button.textContent)).toEqual([ASSISTANT_COPY.openFilters, ASSISTANT_COPY.summarizeView, ASSISTANT_COPY.openPaths]);
    expect(screen.queryByText(left)).toBeNull();
    await userEvent.click(chips[2] as HTMLElement);
    expect(h.state.presentation.view.getState().pathsOpen).toBe(true);
    await userEvent.click(chips[2] as HTMLElement);
    expect(h.state.presentation.view.getState().pathsOpen).toBe(true);
  });

  it('offers Open Paths on a card already shown when the tool is registered afterwards', async () => {
    const { h } = setup();
    await typeAndSend('is it fraud?');
    await screen.findByText(left);
    act(() => void registerPathsTool(h.tools, h.state));
    expect(await screen.findByRole('button', { name: ASSISTANT_COPY.openPaths })).toBeTruthy();
    expect(screen.queryByText(left)).toBeNull();
  });
});

describe('the Assistant thread: the refusal of an Ask question', () => {
  const askRefusal = (cause: (typeof ASK_REFUSAL_CAUSES)[number]): AssistantTurnAnswer => ({ status: 'answered', route: 'ask', answer: askAnswerSchema.parse({ refused: { cause, sentence: ASK_REFUSAL_SENTENCES[cause], parameters: ['kind-a'], missing: ['kind-a'], ...(cause === 'value-not-fit' ? { valueNotFit: { kind: 'not-found', needed: 'widget' } } : {}) } }) });

  it.each(ASK_REFUSAL_CAUSES)('shows the %s refusal titled Not answered with Ask’s fixed sentence, its hint where Ask gives one and the chips, and none of Ask’s own lines or tag', async (cause) => {
    setup({ answers: [askRefusal(cause)], paths: 'action' });
    await typeAndSend('a message as typed');
    const title = await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered });
    expect(screen.getByText(ASK_REFUSAL_SENTENCES[cause])).toBeTruthy();
    const hint = hintOf(cause);
    if (hint === undefined) expect(document.querySelector('.ask-hint')).toBeNull();
    else expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.getByText('a message as typed')).toBeTruthy();
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.openFilters })).toBeTruthy();
    expect(await screen.findByRole('button', { name: ASSISTANT_COPY.summarizeView })).toBeTruthy();
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.openPaths })).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.routeAsk, { selector: 'p' })).toBeNull();
    expect(screen.queryByText('Missing')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search by stable ID' })).toBeNull();
    expect(document.activeElement).toBe(title);
  });

  const misfit = (valueNotFit: Record<string, unknown>, sentence: string, reads?: readonly Record<string, unknown>[]): AssistantTurnAnswer => ({ status: 'answered', route: 'ask', answer: askAnswerSchema.parse({ refused: { cause: 'value-not-fit', sentence, intent: 'shared', valueNotFit } }), ...(reads === undefined ? {} : { reads: reads as never }) });
  const ACCOUNT = { ref: { sourceId: 'demo', entityType: 'account', stableId: 'A-1' }, title: 'Account A-1', type: 'account' };

  it.each([
    ['another type, with the element cited', { kind: 'other-type', needed: 'customer', found: 'account', citation: ACCOUNT }, valueNotFitSentence({ kind: 'other-type', needed: 'customer', found: 'account', title: 'Account A-1' })],
    ['no element', { kind: 'not-found', needed: 'customer' }, valueNotFitSentence({ kind: 'not-found', needed: 'customer' })],
    ['an element the read left out', { kind: 'hidden', needed: 'customer' }, valueNotFitSentence({ kind: 'hidden', needed: 'customer' })],
  ])('shows the sentence the server wrote for a value that does not fit: %s', async (_name, fit, sentence) => {
    setup({ answers: [misfit(fit, sentence)] });
    await typeAndSend('a message as typed');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered });
    expect(screen.getByText(sentence)).toBeTruthy();
    if ('citation' in fit) expect(screen.getByText(`${ASSISTANT_COPY.citedElement} Account A-1 (account)`)).toBeTruthy();
    else expect(screen.queryByText(new RegExp(ASSISTANT_COPY.citedElement))).toBeNull();
  });

  it('shows the reads of the earlier steps of a tool loop that the refusal ended, above the refusal', async () => {
    const sentence = valueNotFitSentence({ kind: 'not-found', needed: 'customer' });
    setup({ answers: [misfit({ kind: 'not-found', needed: 'customer' }, sentence, [{ tool: 'shared', kind: 'intent', read: true, rows: 2, quality: 'exact', partial: false }])] });
    await typeAndSend('a message as typed');
    await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered });
    expect(document.querySelector('.assistant-reads')).not.toBeNull();
    expect(screen.getByText(sentence)).toBeTruthy();
  });

  it('keeps the earlier turns on screen when an Ask question is refused', async () => {
    setup({ answers: [VIEW, askRefusal('no-intent')] });
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_NOT_ANSWERED_SENTENCE);
    await typeAndSend('second');
    expect(await screen.findByText(ASK_REFUSAL_SENTENCES['no-intent'])).toBeTruthy();
    expect(screen.getByText(ASSISTANT_NOT_ANSWERED_SENTENCE)).toBeTruthy();
  });
});
