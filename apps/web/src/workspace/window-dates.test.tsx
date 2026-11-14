import { cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { inPanel, panelRig } from './supernode-kit.js';

afterEach(() => cleanup());

const windowSelect = () => inPanel().getByRole('combobox', { name: /Time window/ });
const loadButton = () => inPanel().getByRole('button', { name: 'Load 25 per type' });

async function chooseDates(first: string, last: string) {
  const rig = panelRig();
  await rig.open();
  const user = userEvent.setup();
  await user.selectOptions(windowSelect(), 'Dates (UTC)');
  const from = inPanel().getByRole('textbox', { name: 'From (UTC date)' });
  const to = inPanel().getByRole('textbox', { name: 'To (UTC date)' });
  await user.type(from, first);
  await user.type(to, last);
  return { ...rig, user };
}

describe('a window of dates in the Expand panel', () => {
  it('sends the first and the last date with the first page', async () => {
    const { expansions, user } = await chooseDates('2026-10-21', '2026-10-28');
    expect(inPanel().queryByRole('alert')).toBeNull();
    await user.click(loadButton());
    expect(expansions[0]?.body.window).toEqual({ from: '2026-10-21', to: '2026-10-28' });
  });

  it('refuses reversed dates, and sends nothing until they are right', async () => {
    const { user } = await chooseDates('2026-10-28', '2026-10-21');
    expect(inPanel().getByRole('alert').textContent).toBe('Before the start date');
    expect(inPanel().getByRole('textbox', { name: 'To (UTC date)' }).getAttribute('aria-invalid')).toBe('true');
    expect(loadButton().hasAttribute('disabled')).toBe(true);
    await user.clear(inPanel().getByRole('textbox', { name: 'To (UTC date)' }));
    await user.type(inPanel().getByRole('textbox', { name: 'To (UTC date)' }), '2026-10-30');
    expect(inPanel().queryByRole('alert')).toBeNull();
    expect(loadButton().hasAttribute('disabled')).toBe(false);
  });

  it('refuses a date that does not exist, and a span over 3,650 days', async () => {
    const { user } = await chooseDates('2026-02-31', '2026-03-05');
    expect(inPanel().getByRole('alert').textContent).toBe('Enter a calendar date like 2026-03-01.');
    const from = inPanel().getByRole('textbox', { name: 'From (UTC date)' });
    await user.clear(from);
    await user.type(from, '2010-01-01');
    expect(inPanel().getByRole('alert').textContent).toBe('At most 3,650 days, both dates included.');
    expect(loadButton().hasAttribute('disabled')).toBe(true);
  });
});
