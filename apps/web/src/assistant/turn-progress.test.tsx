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
const progress = () => document.querySelector('.assistant-progress');
const field = () => screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement;

describe('the Assistant panel: the step in progress', () => {
  it('shows each finished read as a box, the read in progress as a dashed row and the checking of the answer, then the answer card with the steps collapsed, and no progress bar', async () => {
    const { h, turns } = held();
    render(h.tree());
    await typeAndSend('hello');
    expect(progress()?.textContent).toContain(ASSISTANT_COPY.workingBody);
    const turn = turns[0];
    if (turn?.onStep === undefined) throw new Error('the client was given no listener');
    await act(async () => turn.onStep?.({ n: 1, phase: 'routing' }));
    expect(progress()?.textContent).toContain(ASSISTANT_COPY.stepRouting);
    expect(progress()?.textContent).not.toContain(ASSISTANT_COPY.workingBody);
    await act(async () => turn.onStep?.({ n: 2, phase: 'reading', tool: 'shared-attribute', label: 'Accounts at the same bank', subject: 'A-1', kind: 'intent' }));
    const current = progress()?.querySelector('.assistant-current');
    expect(current?.textContent).toContain('Reading Accounts at the same bank');
    expect(current?.textContent).toContain('Folder intent');
    expect(current?.textContent).toContain('A-1 …');
    expect(progress()?.querySelectorAll('.assistant-read')).toHaveLength(0);
    await act(async () => turn.onStep?.({ n: 3, phase: 'read-done', read: { tool: 'shared-attribute', label: 'Accounts at the same bank', kind: 'intent', subject: 'A-1', read: true, rows: 2, quality: 'exact', partial: false } }));
    const done = progress()?.querySelector('.assistant-read');
    expect(done?.textContent).toContain('Ran Accounts at the same bank');
    expect(done?.textContent).toContain('A-1 · 2 rows · complete');
    expect(done?.textContent).toContain('Exact');
    expect(progress()?.querySelector('.assistant-current')).toBeNull();
    await act(async () => turn.onStep?.({ n: 4, phase: 'answering' }));
    expect(progress()?.querySelector('.assistant-current')?.textContent).toContain(ASSISTANT_COPY.stepAnswering);
    expect(progress()?.textContent).toContain(ASSISTANT_COPY.stepAnsweringBody);
    expect(progress()?.querySelectorAll('.assistant-read')).toHaveLength(1);
    expect(document.querySelector('.ask-progress, [role="progressbar"], progress')).toBeNull();
    await act(async () => turn.finish({ ok: true, value: REFUSAL }));
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    expect(progress()).toBeNull();
  });

  it('says the humanized tool when the intent has no label, shows a label or subject with markup as text, and shows no figure it was not sent', async () => {
    const { h, turns } = held();
    render(h.tree());
    await typeAndSend('hello');
    const turn = turns[0];
    await act(async () => turn?.onStep?.({ n: 1, phase: 'reading', tool: 'accounts-using-a-device' }));
    expect(progress()?.querySelector('.assistant-current')?.textContent).toBe('Reading Accounts using a device');
    await act(async () => turn?.onStep?.({ n: 2, phase: 'reading', tool: 'x', label: '<img src=x onerror=alert(1)>', subject: '<b>A-1</b>', kind: 'template' }));
    expect(progress()?.querySelector('.assistant-current')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(progress()?.querySelector('.assistant-current')?.textContent).toContain('<b>A-1</b> …');
    expect(progress()?.querySelector('img, b')).toBeNull();
    await act(async () => turn?.onStep?.({ n: 3, phase: 'read-done', read: { tool: 'x', kind: 'template', read: true, quality: 'unknown', partial: false } }));
    expect(progress()?.querySelector('.assistant-read-line')?.textContent).toContain('no row count');
    expect(progress()?.textContent).not.toMatch(/\d+ rows?/);
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
    await act(async () => turns[0]?.onStep?.({ n: 3, phase: 'read-done', read: { tool: 'view', kind: 'view', read: true, rows: 3, quality: 'exact', partial: false } }));
    expect(region.textContent).toBe(`${ASSISTANT_COPY.stepReadDone} View.`);
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
    expect(progress()).toBeNull();
  });

  it('shows the failure card of the code for an error line or an HTTP error body, as for the JSON route', async () => {
    const { h, turns } = held();
    render(h.tree());
    await typeAndSend('hello');
    await act(async () => turns[0]?.onStep?.({ n: 1, phase: 'routing' }));
    await act(async () => turns[0]?.finish({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } as never }));
    expect(progress()).toBeNull();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('shows the waiting sentence and no step for a server that does not stream, as before', async () => {
    const { h } = held();
    render(h.tree());
    await typeAndSend('hello');
    expect(progress()?.textContent).toBe(ASSISTANT_COPY.workingBody);
  });
});
