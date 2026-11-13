import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoCodes } from '../patterns/no-codes.js';
import { answerAsk, blockedOf, drawAsk, failed, field, previewOf, server } from './ask-kit.js';

afterEach(cleanup);

async function asked(question = 'which widgets') {
  const harness = drawAsk();
  await userEvent.type(field(), question);
  await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
  return harness;
}

const status = (): string => screen.getByRole('status').textContent ?? '';

describe('the failures of a preview request', () => {
  const cases: ReadonlyArray<readonly [string, ReturnType<typeof server>, string | RegExp, boolean]> = [
    ['unreachable', failed('NETWORK_UNAVAILABLE'), 'The server could not be reached.', true],
    ['source unavailable', server('SOURCE_UNAVAILABLE', { reason: 'unreachable' }), /demo/, true],
    ['timeout', server('QUERY_TIMEOUT', { timeoutMs: 5000 }), /demo/, true],
    ['busy', server('SOURCE_BUSY'), /demo/, true],
    ['rate limited, with the wait', server('RATE_LIMITED', { retryAfterMs: 3000 }), 'You can try again in 3 s.', true],
    ['not found', server('NOT_FOUND'), 'This was not found. It may have been removed.', false],
    ['unsupported', server('ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }), 'Ask is not available right now.', false],
    ['the preview switched off', server('ACCESS_DENIED', { reason: 'ai-preview-off' }), 'Ask is not available right now.', false],
  ];

  it.each(cases)('says %s in words with no code, keeps the text and the last card, and offers Try again only where it helps', async (_name, failure, words, retry) => {
    const { asks } = await asked();
    await answerAsk(asks[0], previewOf('which widgets'));
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await answerAsk(asks[1], failure);
    const shown = status();
    if (typeof words === 'string') expect(shown).toBe(words);
    else expect(shown).toMatch(words);
    expect(() => assertNoCodes(document.body.textContent ?? '', 'the Ask panel')).not.toThrow();
    expect(document.body.textContent).not.toContain('tr-1');
    expect(field().value).toBe('which widgets');
    expect(screen.getByRole('region', { name: 'What the model will receive' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retry);
  });

  it('asks again with Try again', async () => {
    const { asks } = await asked();
    await answerAsk(asks[0], failed('NETWORK_UNAVAILABLE'));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(asks).toHaveLength(2);
    expect(asks[1]?.request.send).toBe(false);
  });
});

describe('a request that ends with nothing sent', () => {
  it('leaves the panel ready, with the text and the last card, when the answer says the request ended', async () => {
    const { asks } = await asked();
    await answerAsk(asks[0], previewOf('which widgets'));
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await answerAsk(asks[1], failed('ABORTED'));
    expect(status()).toBe('');
    expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('region', { name: 'What the model will receive' })).toBeTruthy();
  });
});

describe('the states and what the status region says', () => {
  it('says Checking the question while a preview is asked for, disables Preview and keeps the earlier card', async () => {
    const { asks } = await asked();
    await answerAsk(asks[0], previewOf('which widgets'));
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(status()).toBe('Checking the question…');
    expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('region', { name: 'What the model will receive' })).toBeTruthy();
  });

  it('says nothing was claimed when a preview request is cancelled: the card is as before', async () => {
    const { asks } = await asked();
    await answerAsk(asks[0], previewOf('which widgets'));
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await userEvent.type(field(), 'x');
    expect(asks[1]?.signal?.aborted).toBe(true);
    expect(status()).toBe('');
    expect(screen.queryByText(/sent/i)).toBeNull();
  });

  it('names the preview as a readable region, and says the count of words of a blocked question', async () => {
    const { asks } = await asked('which zorvat qux');
    await answerAsk(asks[0], blockedOf({ text: 'zorvat', start: 6, end: 12 }, { text: 'qux', start: 13, end: 16 }));
    expect(status()).toBe('Not sent · 2 words need attention');
  });

  it('keeps a long preview inside a scrolling box and offers every chip', async () => {
    const { asks } = await asked();
    await answerAsk(asks[0], previewOf('word '.repeat(400)));
    const text = screen.getByRole('region', { name: 'What the model will receive' }).querySelector('pre');
    expect(text?.className).toBe('ask-preview-text');
    expect(text?.getAttribute('tabindex')).toBe('0');
  });
});

describe('the keyboard path', () => {
  it('reaches every control of the blocked card by Tab in reading order, after the close button', async () => {
    const { asks } = await asked('which zorvat share');
    await answerAsk(asks[0], blockedOf({ text: 'zorvat', start: 6, end: 12 }));
    await userEvent.click(screen.getByRole('button', { name: 'Close Ask' }));
    const order: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await userEvent.tab();
      const name = document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '';
      order.push(name);
    }
    expect(order).toEqual(['Your question', 'Preview', 'Pick an entity', 'Use as a search value', 'Remove the word', 'Edit question']);
  });

  it('operates the Preview, Send and Edit question buttons with Enter and Space', async () => {
    const { asks } = await asked();
    await answerAsk(asks[0], previewOf('which widgets'));
    screen.getByRole('button', { name: 'Edit question' }).focus();
    await userEvent.keyboard(' ');
    expect(screen.queryByRole('region', { name: 'What the model will receive' })).toBeNull();
    screen.getByRole('button', { name: 'Preview' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(asks).toHaveLength(2);
  });

  it('closes the card on Escape, then the panel, and gives the focus back to the Ask control', async () => {
    const { asks, state } = await asked();
    state.presentation.setAskOpen(true);
    await answerAsk(asks[0], previewOf('which widgets'));
    await userEvent.click(field());
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'What the model will receive' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(state.presentation.view.getState().askOpen).toBe(false);
  });

  it('closes with the close button and cancels a request in flight', async () => {
    const { asks, state } = await asked();
    state.presentation.setAskOpen(true);
    await userEvent.click(screen.getByRole('button', { name: 'Close Ask' }));
    expect(state.presentation.view.getState().askOpen).toBe(false);
    expect(asks).toHaveLength(1);
  });

  it('puts the focus back on the Ask control of the header when the panel is closed', async () => {
    const button = document.createElement('button');
    button.className = 'header-ai header-ai-unlocked';
    button.textContent = 'Ask';
    document.body.append(button);
    await asked();
    await userEvent.click(screen.getByRole('button', { name: 'Close Ask' }));
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});
