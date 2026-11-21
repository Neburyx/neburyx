import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSISTANT_REFUSAL_SENTENCES, type AssistantTurnAnswer } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import type { TurnStep } from '../api/turn-stream.js';
import { harness, typeAndSend } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const REFUSAL: AssistantTurnAnswer = { status: 'answered', route: 'refuse', cause: 'verdict', sentence: ASSISTANT_REFUSAL_SENTENCES.verdict };
type Held = { readonly signal: AbortSignal | undefined; readonly onStep: ((step: TurnStep) => void) | undefined; readonly finish: (value: ApiResult<AssistantTurnAnswer>) => void };

function held() {
  const turns: Held[] = [];
  const h = harness((_request, signal, onStep) => new Promise((resolve) => void turns.push({ signal, onStep, finish: resolve })));
  return { h, turns };
}
const cardStep = () => document.querySelector('.assistant-step')?.textContent;
const field = () => screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement;

describe('the Assistant panel: the step in progress', () => {
  it('shows the step the server reports, replaced by the next, then the answer card in its place', async () => {
    const { h, turns } = held();
    render(h.tree());
    await typeAndSend('hello');
    expect(screen.getByText(ASSISTANT_COPY.workingBody)).toBeTruthy();
    const turn = turns[0];
    if (turn?.onStep === undefined) throw new Error('the client was given no listener');
    await act(async () => turn.onStep?.({ n: 1, phase: 'routing' }));
    expect(cardStep()).toBe(ASSISTANT_COPY.stepRouting);
    expect(screen.queryByText(ASSISTANT_COPY.workingBody)).toBeNull();
    await act(async () => turn.onStep?.({ n: 2, phase: 'reading', tool: 'shared-attribute', label: 'Accounts at the same bank', subject: 'A-1' }));
    expect(cardStep()).toBe('Reading Accounts at the same bank for A-1…');
    expect(screen.queryByText(ASSISTANT_COPY.stepRouting)).toBeNull();
    await act(async () => turn.onStep?.({ n: 3, phase: 'answering' }));
    expect(cardStep()).toBe(ASSISTANT_COPY.stepAnswering);
    await act(async () => turn.finish({ ok: true, value: REFUSAL }));
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.stepAnswering)).toBeNull();
  });

  it('says the humanized tool when the intent has no label, and shows a label or subject with markup as text', async () => {
    const { h, turns } = held();
    render(h.tree());
    await typeAndSend('hello');
    const turn = turns[0];
    await act(async () => turn?.onStep?.({ n: 1, phase: 'reading', tool: 'accounts-using-a-device' }));
    expect(cardStep()).toBe('Reading Accounts using a device…');
    await act(async () => turn?.onStep?.({ n: 2, phase: 'reading', tool: 'x', label: '<img src=x onerror=alert(1)>', subject: '<b>A-1</b>' }));
    expect(cardStep()).toBe('Reading <img src=x onerror=alert(1)> for <b>A-1</b>…');
    expect(document.querySelector('.assistant-step img, .assistant-step b')).toBeNull();
  });

  it('announces the step in the panel’s one live region, which holds the waiting sentence first and one step at a time after', async () => {
    const { h, turns } = held();
    render(h.tree());
    await typeAndSend('hello');
    const region = screen.getByRole('status');
    expect(region.textContent).toBe(ASSISTANT_COPY.working);
    await act(async () => turns[0]?.onStep?.({ n: 1, phase: 'routing' }));
    expect(region.textContent).toBe(ASSISTANT_COPY.stepRouting);
    await act(async () => turns[0]?.onStep?.({ n: 2, phase: 'reading-view' }));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe(ASSISTANT_COPY.stepReadingView);
  });

  it('closes the request when Cancel is pressed during the steps, shows the Cancelled turn and gives the message back', async () => {
    const { h, turns } = held();
    render(h.tree());
    await typeAndSend('keep me');
    await act(async () => turns[0]?.onStep?.({ n: 1, phase: 'routing' }));
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.cancel }));
    expect(turns[0]?.signal?.aborted).toBe(true);
    expect(await screen.findByText(ASSISTANT_COPY.cancelledTitle)).toBeTruthy();
    expect(field().value).toBe('keep me');
    // a step that arrives after the cancel is dropped
    await act(async () => turns[0]?.onStep?.({ n: 2, phase: 'reading-view' }));
    expect(screen.queryByText(ASSISTANT_COPY.stepReadingView)).toBeNull();
  });

  it('shows the failure card of the code for an error line or an HTTP error body, as for the JSON route', async () => {
    const { h, turns } = held();
    render(h.tree());
    await typeAndSend('hello');
    await act(async () => turns[0]?.onStep?.({ n: 1, phase: 'routing' }));
    await act(async () => turns[0]?.finish({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } as never }));
    expect(screen.queryByText(ASSISTANT_COPY.stepRouting)).toBeNull();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('shows the waiting sentence and no step for a server that does not stream, as before', async () => {
    const { h } = held();
    render(h.tree());
    await typeAndSend('hello');
    expect(screen.getByText(ASSISTANT_COPY.workingBody)).toBeTruthy();
  });
});
