import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { answerAsk, drawAsk, field, HASH, previewOf } from './ask-kit.js';

afterEach(cleanup);

const PATTERNS = 'Saved patterns of the investigator, each with a key.\npat_1, named "Widgets and gadgets": starts at an entity of type widget that the question gives; step 1: out over link to gadget, no conditions';

interface Extra {
  readonly patternLabels?: string[];
  readonly patternText?: string;
  readonly patternCatalogCut?: true;
  readonly changed?: true;
}

const answerWith = (text: string, extra: Extra) => {
  const base = previewOf(text, HASH);
  return base.ok ? { ...base, value: { ...base.value, ...extra } } : base;
};

const previewWith = async (extra: Extra) => {
  const { asks } = drawAsk();
  await userEvent.type(field(), 'which widgets{Enter}');
  await answerAsk(asks[0], answerWith('which ‹widget#1›', extra));
  return { asks };
};

describe('the preview card of the Ask panel with saved patterns', () => {
  it('shows the text of the saved patterns that will be sent, with its names in quotes, under its own heading, after the question text', async () => {
    await previewWith({ patternLabels: ['Widgets and gadgets'], patternText: PATTERNS });
    const card = screen.getByRole('region', { name: 'What the model will receive' });
    const blocks = [...card.querySelectorAll('pre')];
    expect(blocks.map((block) => block.textContent)).toEqual(['which ‹widget#1›', PATTERNS]);
    expect(screen.getByRole('heading', { level: 4, name: 'Your saved patterns, listed for the model' })).toBeTruthy();
    expect(screen.getByText('Only their structure goes, and a name only when every word of it is allowed. Nothing from the data goes.')).toBeTruthy();
  });

  it('shows nothing about saved patterns when none is offered, and the question text alone', async () => {
    await previewWith({});
    const card = screen.getByRole('region', { name: 'What the model will receive' });
    expect(card.querySelectorAll('pre')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Your saved patterns, listed for the model' })).toBeNull();
  });

  it('says that more saved patterns exist than are listed when the server says the list was cut, with no number', async () => {
    await previewWith({ patternText: PATTERNS, patternCatalogCut: true });
    expect(screen.getByText('More saved patterns exist than are listed here.')).toBeTruthy();
  });

  it('shows the new text and the changed note when the patterns changed since the preview, and sent nothing', async () => {
    const { asks } = await previewWith({ patternText: PATTERNS });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(asks).toHaveLength(2);
    await answerAsk(asks[1], answerWith('which ‹widget#1›', { changed: true, patternText: PATTERNS.replace('Widgets and gadgets', 'Gadgets and widgets') }));
    expect(screen.getAllByText('The preview changed. Check the new text before sending.').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('region', { name: 'What the model will receive' }).some((card) => card.textContent?.includes('Gadgets and widgets') === true)).toBe(true);
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false);
  });

  it('reads the pattern text by keyboard, in order, and leaves Send after it', async () => {
    await previewWith({ patternText: PATTERNS });
    const card = screen.getByRole('region', { name: 'What the model will receive' });
    const stops = [...card.querySelectorAll<HTMLElement>('pre, button')];
    expect(stops.map((stop) => stop.tagName)).toEqual(['PRE', 'PRE', 'BUTTON', 'BUTTON']);
    expect(stops[1]?.getAttribute('tabindex')).toBe('0');
    expect(stops[2]?.textContent).toBe('Send');
  });
});
