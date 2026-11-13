import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ASK_MESSAGE_MAX_LENGTH } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { answerAsk, drawAsk, field, HASH, previewOf, settle, SOURCE } from './ask-kit.js';

afterEach(cleanup);

const typeAndPreview = async (text: string): Promise<void> => {
  await userEvent.clear(field());
  await userEvent.type(field(), text);
  await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
};

describe('the Ask panel: ask one question and see the preview', () => {
  it('opens with the field in focus, the placeholder, the hint under the field and a Preview button', () => {
    drawAsk();
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute('placeholder')).toBe('Ask about this investigation…');
    const hint = screen.getByText("Don't type customer names; others may see this text.");
    expect(field().getAttribute('aria-describedby')).toContain(hint.id);
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Ask' })).toBeTruthy();
  });

  it('sends one request without a hash for the preview, in the source of the investigation, and nothing with send true', async () => {
    const { asks } = drawAsk();
    await typeAndPreview('which widgets share the same device');
    expect(asks).toHaveLength(1);
    expect(asks[0]?.request).toEqual({ message: 'which widgets share the same device', sourceId: SOURCE, send: false });
    expect(asks.some((sent) => sent.request.send === true)).toBe(false);
  });

  it('shows the preview text exactly as the server returned it, with the note, Send and Edit question', async () => {
    const { asks } = drawAsk();
    await typeAndPreview('Which widgets share the same device');
    await answerAsk(asks[0], previewOf('Which widgets share devices with ‹widget#1› in the last 30 days?'));
    const card = screen.getByRole('region', { name: 'What the model will receive' });
    expect(card.querySelector('pre')?.textContent).toBe('Which widgets share devices with ‹widget#1› in the last 30 days?');
    expect(screen.getByText('Names and IDs are replaced with placeholders. Your typed text is never sent, only these words.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit question' })).toBeTruthy();
  });

  it('asks for the preview with Enter in the field, and Enter never sends', async () => {
    const { asks } = drawAsk();
    await userEvent.type(field(), 'which widgets{Enter}');
    expect(asks).toHaveLength(1);
    await answerAsk(asks[0], previewOf('which widgets', HASH));
    await userEvent.type(field(), '{Enter}');
    expect(asks.every((sent) => sent.request.send === false)).toBe(true);
  });

  it('removes the card on Edit question, keeps the text and puts the focus in the field', async () => {
    const { asks } = drawAsk();
    await typeAndPreview('which widgets');
    await answerAsk(asks[0], previewOf('which widgets'));
    await userEvent.click(screen.getByRole('button', { name: 'Edit question' }));
    expect(screen.queryByRole('region', { name: 'What the model will receive' })).toBeNull();
    expect(field().value).toBe('which widgets');
    expect(document.activeElement).toBe(field());
  });

  it('removes the preview as soon as the text is edited, so no Send is left for other text', async () => {
    const { asks } = drawAsk();
    await typeAndPreview('which widgets');
    await answerAsk(asks[0], previewOf('which widgets'));
    await userEvent.type(field(), ' x');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'What the model will receive' })).toBeNull();
  });

  it('says there is nothing to ask about with no investigation, and sends nothing', async () => {
    const { asks } = drawAsk({ source: null });
    expect(screen.getByText('There is nothing to ask about yet. Open an investigation first.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(true);
    expect(asks).toEqual([]);
  });

  it('sends nothing for an empty question and says why in words', async () => {
    const { asks } = drawAsk();
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText('Type a question first.')).toBeTruthy();
    expect(asks).toEqual([]);
  });

  it('counts the limit in code points: a question of exactly the limit is sent, one more is not', async () => {
    const { asks } = drawAsk();
    const exactly = '😀'.repeat(ASK_MESSAGE_MAX_LENGTH);
    await userEvent.click(field());
    await userEvent.paste(exactly);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(asks).toHaveLength(1);
    expect(exactly.length).toBeGreaterThan(ASK_MESSAGE_MAX_LENGTH);
    await userEvent.type(field(), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText(/longer than/)).toBeTruthy();
    expect(asks).toHaveLength(1);
  });

  it('cancels the request in flight when the text is edited, and drops its late answer', async () => {
    const { asks } = drawAsk();
    await typeAndPreview('which widgets');
    const first = asks[0];
    await userEvent.type(field(), ' x');
    expect(first?.signal?.aborted).toBe(true);
    await answerAsk(first, previewOf('late text'));
    await settle();
    expect(screen.queryByText('late text')).toBeNull();
  });
});
