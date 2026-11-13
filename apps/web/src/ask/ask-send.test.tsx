import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { answerAsk, blockedOf, drawAsk, field, hookAsk, HASH, previewOf, REF, server, SOURCE } from './ask-kit.js';

afterEach(cleanup);

async function previewed(question = 'which widgets', text = question) {
  const harness = drawAsk();
  await userEvent.type(field(), question);
  await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await answerAsk(harness.asks[0], previewOf(text));
  return harness;
}

const send = (): HTMLButtonElement => screen.getByRole('button', { name: 'Send' });

describe('Send', () => {
  it('sends one request with send true, the same message and source, and the hash that came with the preview', async () => {
    const { asks } = await previewed();
    await userEvent.click(send());
    expect(asks).toHaveLength(2);
    expect(asks[1]?.request).toEqual({ message: 'which widgets', sourceId: SOURCE, send: true, previewHash: HASH });
  });

  it('shows Sending, disables every control that changes the question, offers no cancel, and sends once', async () => {
    const { asks } = await previewed();
    await userEvent.click(send());
    expect(screen.getByRole('status').textContent).toBe('Sending…');
    for (const name of ['Send', 'Preview', 'Edit question', 'Close Ask']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    expect(field().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(send());
    expect(asks).toHaveLength(2);
  });

  it('does nothing to the panel on Escape while the send is out', async () => {
    await previewed();
    await userEvent.click(send());
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('status').textContent).toBe('Sending…');
    expect(screen.getByRole('region', { name: 'What the model will receive' })).toBeTruthy();
  });

  it('shows the neutral status after a plan, keeps the preview greyed, and offers no second send', async () => {
    const { asks } = await previewed();
    await userEvent.click(send());
    await answerAsk(asks[1], { ok: true, value: { plan: { kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, params: { ref: { entityType: 'widget', stableId: 'w-1' } }, rationale: 'Widgets that share a gadget.' } } });
    expect(screen.getByRole('status').textContent).toBe('Sent. The plan is ready.');
    expect(screen.getByRole('region', { name: 'What the model will receive' }).className).toContain('ask-card-sent');
    expect(send().disabled).toBe(true);
  });

  it('shows the reason of an unsupported plan', async () => {
    const { asks } = await previewed();
    await userEvent.click(send());
    await answerAsk(asks[1], { ok: true, value: { plan: { kind: 'unsupported', reason: 'No template fits this question.' } } });
    expect(screen.getByRole('status').textContent).toBe('No template fits this question.');
  });

  it('goes back to a preview to check when the answer is a changed preview, with the note and the new hash for the next send', async () => {
    const { asks } = await previewed();
    await userEvent.click(send());
    await answerAsk(asks[1], previewOf('which widgets, again', 'b'.repeat(64), true));
    expect(screen.getByText('The preview changed. Check the new text before sending.', { selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'What the model will receive' }).querySelector('pre')?.textContent).toBe('which widgets, again');
    await userEvent.click(send());
    expect(asks[2]?.request.previewHash).toBe('b'.repeat(64));
  });

  it('replaces the preview with the blocked card when the send is answered as blocked, says not sent, and leaves no Send', async () => {
    const { asks } = await previewed('which zorvath');
    await userEvent.click(send());
    await answerAsk(asks[1], blockedOf({ text: 'zorvath', start: 6, end: 13 }));
    expect(screen.getByRole('status').textContent).toBe('Not sent · 1 word needs attention');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(asks).toHaveLength(2);
  });

  it('replaces the preview with the chips when the send is answered with a clarification, with no Send', async () => {
    const { asks } = await previewed('which Qux');
    await userEvent.click(send());
    await answerAsk(asks[1], { ok: true, value: { clarification: { start: 6, end: 9, choices: [REF('w-1'), REF('w-2')], count: { quality: 'exact', value: 2, scope: 'exact matches' }, unreferenced: 0 } } });
    expect(screen.getByRole('status').textContent).toBe('Awaiting clarification · no plan run');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('shows a failed send in words, keeps the text and the preview, and offers Try again only where it helps', async () => {
    const { asks } = await previewed();
    await userEvent.click(send());
    await answerAsk(asks[1], server('SOURCE_UNAVAILABLE', { reason: 'unreachable' }));
    expect(screen.getByRole('status').textContent).toContain('demo');
    expect(send().disabled).toBe(true);
    expect(field().value).toBe('which widgets');
    expect(screen.getByRole('region', { name: 'What the model will receive' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(asks).toHaveLength(3);
    expect(asks[2]?.request.send).toBe(true);
    await answerAsk(asks[2], server('ACCESS_DENIED', { reason: 'ai-preview-off' }));
    expect(screen.getByRole('status').textContent).toBe('Ask is not available right now.');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(send().disabled).toBe(true);
  });

  it('removes the sent status and the preview on an edit, so another question needs a new preview', async () => {
    const { asks } = await previewed();
    await userEvent.click(send());
    await answerAsk(asks[1], { ok: true, value: { plan: { kind: 'unsupported', reason: 'No template fits.' } } });
    await userEvent.type(field(), ' x');
    expect(screen.queryByRole('region', { name: 'What the model will receive' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('does not abort the send when the source changes, drops its answer unseen and never says it was not sent', async () => {
    const { asks, state } = await previewed();
    await userEvent.click(send());
    const sent = asks[1];
    state.bindSource('other');
    await settleAfter();
    expect(sent?.signal).toBeUndefined();
    await answerAsk(sent, { ok: true, value: { plan: { kind: 'unsupported', reason: 'No template fits.' } } });
    expect(screen.queryByText('No template fits.')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('The last question may have been sent.');
    expect(screen.queryByRole('region', { name: 'What the model will receive' })).toBeNull();
  });
});

async function settleAfter(): Promise<void> {
  await userEvent.click(document.body);
}

describe('what the panel keeps of a sent question', () => {
  it('keeps the plan the server answered in its state, for the plan card to draw', async () => {
    const harness = hookAsk();
    const plan = { kind: 'plan' as const, templateId: 'shared-attribute' as const, templateVersion: 1, params: { ref: { entityType: 'widget', stableId: 'w-1' } }, rationale: 'Widgets that share a gadget.' };
    act(() => harness.current().setText('which widgets'));
    act(() => harness.current().preview());
    await answerAsk(harness.asks[0], previewOf('which widgets'));
    act(() => harness.current().send());
    await answerAsk(harness.asks[1], { ok: true, value: { plan } });
    expect(harness.current().model.plan).toEqual(plan);
    expect(harness.current().model.sent).toBe('Sent. The plan is ready.');
    act(() => harness.current().setText('which widgets x'));
    expect(harness.current().model.plan).toBeUndefined();
  });
});
