import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { answerAsk, blockedOf, drawAsk, field, previewOf } from './ask-kit.js';

afterEach(cleanup);

async function blocked(question: string, ...tokens: Array<{ text: string; start: number; end: number }>) {
  const harness = drawAsk();
  await userEvent.click(field());
  await userEvent.paste(question);
  await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await answerAsk(harness.asks[0], blockedOf(...tokens));
  return harness;
}

const marked = (container: HTMLElement): string[] => [...container.querySelectorAll('mark.ask-blocked')].map((mark) => mark.textContent ?? '');

describe('the blocked word', () => {
  it('underlines the word by its offsets, says it cannot be sent, shows Not sent and offers the three actions', async () => {
    const { container } = await blocked('which zorvat qux', { text: 'zorvat', start: 6, end: 12 });
    expect(marked(container)).toEqual(['zorvat']);
    expect(screen.getByRole('heading', { level: 3, name: '“zorvat” can\'t be sent to the model' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Not sent · 1 word needs attention');
    for (const name of ['Pick an entity', 'Remove the word', 'Edit question']) expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('has no Send and no send-anyway, and sends no request with send true in any state of the card', async () => {
    const { asks } = await blocked('which zorvat', { text: 'zorvat', start: 6, end: 12 });
    expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Edit question' }));
    await userEvent.keyboard('{Enter}');
    expect(asks.every((sent) => sent.request.send === false)).toBe(true);
  });

  it('lists several blocked words and counts them in the status', async () => {
    const { container } = await blocked('zorvat qux here', { text: 'zorvat', start: 0, end: 6 }, { text: 'qux', start: 7, end: 10 });
    expect(marked(container)).toEqual(['zorvat', 'qux']);
    expect(screen.getByRole('status').textContent).toBe('Not sent · 2 words need attention');
    expect(screen.getByRole('heading', { level: 3, name: "These words can't be sent to the model" })).toBeTruthy();
  });

  it('removes the word and one space, and asks for a new preview of the changed text', async () => {
    const { asks } = await blocked('which zorvat share', { text: 'zorvat', start: 6, end: 12 });
    await userEvent.click(screen.getByRole('button', { name: 'Remove the word' }));
    expect(field().value).toBe('which share');
    expect(asks).toHaveLength(2);
    expect(asks[1]?.request).toMatchObject({ message: 'which share', send: false });
    await answerAsk(asks[1], previewOf('which share'));
    expect(screen.getByRole('region', { name: 'What the model will receive' })).toBeTruthy();
  });

  it('removes the first blocked word, then the next, with a new preview each time', async () => {
    const { asks } = await blocked('zorvat qux here', { text: 'zorvat', start: 0, end: 6 }, { text: 'qux', start: 7, end: 10 });
    await userEvent.click(screen.getByRole('button', { name: 'Remove the word' }));
    expect(field().value).toBe('qux here');
    await answerAsk(asks[1], blockedOf({ text: 'qux', start: 0, end: 3 }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove the word' }));
    expect(field().value).toBe('here');
  });

  it('puts the focus in the field with the cursor at the end of the first blocked word on Edit question, and keeps the underline', async () => {
    const { container } = await blocked('which zorvat share', { text: 'zorvat', start: 6, end: 12 });
    await userEvent.click(screen.getByRole('button', { name: 'Edit question' }));
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(12);
    expect(marked(container)).toEqual(['zorvat']);
  });

  it('keeps the other underlines and moves them with the text, and drops the one the edit touches or a letter is typed against; the status stays Not sent', async () => {
    const { container } = await blocked('zorvat qux here', { text: 'zorvat', start: 0, end: 6 }, { text: 'qux', start: 7, end: 10 });
    await userEvent.click(field());
    field().setSelectionRange(0, 0);
    await userEvent.paste('so ');
    expect(field().value).toBe('so zorvat qux here');
    expect(marked(container)).toEqual(['zorvat', 'qux']);
    field().setSelectionRange(4, 4);
    await userEvent.keyboard('{Delete}');
    expect(field().value).toBe('so zrvat qux here');
    expect(marked(container)).toEqual(['qux']);
    expect(screen.getByRole('status').textContent).toBe('Not sent · 1 word needs attention');
  });

  it('puts the underline and Remove the word on the right range after an emoji', async () => {
    const { container } = await blocked('😀 which zorvath', { text: 'zorvath', start: 9, end: 16 });
    expect(marked(container)).toEqual(['zorvath']);
    await userEvent.click(screen.getByRole('button', { name: 'Remove the word' }));
    expect(field().value).toBe('😀 which');
  });

  it('shows markup characters in the word as text, never as markup', async () => {
    const { container } = await blocked('which <b>x</b>', { text: '<b>x</b>', start: 6, end: 14 });
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('“<b>x</b>” can\'t be sent to the model');
  });

  it('drops an answer for text that was edited while the request was out, and marks no other text', async () => {
    const harness = drawAsk();
    await userEvent.type(field(), 'which zorvat');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await userEvent.type(field(), ' qux');
    await answerAsk(harness.asks[0], blockedOf({ text: 'zorvat', start: 6, end: 12 }));
    expect(harness.container.querySelectorAll('mark.ask-blocked')).toHaveLength(0);
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
  });
});
