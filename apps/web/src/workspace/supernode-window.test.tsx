import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ExpandWindowField } from './expand-window-field.js';
import { answerExpand, answerPreview, inPanel, panelRig, previewOf, response } from './supernode-kit.js';

afterEach(() => cleanup());

const windowSelect = () => inPanel().getByRole('combobox', { name: /Time window/ });
const loadButton = () => inPanel().getByRole('button', { name: 'Load 25 per type' });

describe('the time window in the Expand panel', () => {
  it('shows the last 7 days without a choice, says it is UTC, and sends it with the first page', async () => {
    const { open, expansions } = panelRig();
    await open();
    expect(windowSelect()).toHaveProperty('value', '7');
    expect(windowSelect().closest('.supernode-field')?.textContent).toContain('Time window · UTC');
    await userEvent.setup().click(loadButton());
    expect(expansions[0]?.body.window).toEqual({ days: 7 });
  });

  it('sends the number of days chosen from the list, and nothing for all time', async () => {
    const { open, expansions } = panelRig();
    await open();
    const user = userEvent.setup();
    await user.selectOptions(windowSelect(), 'Last 30 days');
    await user.click(loadButton());
    expect(expansions[0]?.body.window).toEqual({ days: 30 });
    await answerExpand(expansions[0]);
    await user.selectOptions(windowSelect(), 'All time');
    expect(windowSelect()).toHaveProperty('value', 'all');
    await user.click(loadButton());
    expect(expansions[1]?.body).not.toHaveProperty('window');
  });

  it('takes any whole number of days from 1 to 3650 typed, and refuses another with what to enter, and sends nothing until it is right', async () => {
    const { open, expansions } = panelRig();
    await open();
    const user = userEvent.setup();
    await user.selectOptions(windowSelect(), 'Other number of days');
    const days = inPanel().getByRole('textbox', { name: 'Days' });
    await user.clear(days);
    await user.type(days, '0');
    expect(inPanel().getByRole('alert').textContent).toBe('Enter a whole number of days from 1 to 3650.');
    expect(days.getAttribute('aria-invalid')).toBe('true');
    expect(loadButton().hasAttribute('disabled')).toBe(true);
    await user.clear(days);
    await user.type(days, '45');
    expect(inPanel().queryByRole('alert')).toBeNull();
    expect(loadButton().hasAttribute('disabled')).toBe(false);
    await user.click(loadButton());
    expect(expansions[0]?.body.window).toEqual({ days: 45 });
  });

  it('is reachable and operable with the keyboard', async () => {
    const { open, expansions } = panelRig();
    await open();
    const user = userEvent.setup();
    windowSelect().focus();
    expect(document.activeElement).toBe(windowSelect());
    await user.keyboard('{ArrowDown}');
    await user.click(loadButton());
    expect(expansions[0]?.body.window).toBeDefined();
  });

  it('says what the window is for, and that it does not apply when no relationship type has a date', async () => {
    const { open, previews } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf());
    expect(inPanel().getByText(/Only relationships observed in this period are loaded|does not apply/)).not.toBeNull();
  });

  it('refuses Other with nothing typed after All time, and sends nothing', async () => {
    const { open, expansions } = panelRig();
    await open();
    const user = userEvent.setup();
    await user.selectOptions(windowSelect(), 'All time');
    await user.selectOptions(windowSelect(), 'Other number of days');
    expect(inPanel().getByRole('alert').textContent).toBe('Enter a whole number of days from 1 to 3650.');
    expect(loadButton().hasAttribute('disabled')).toBe(true);
    expect(expansions.length).toBe(0);
  });

  it('shows the UTC dates of the answer beside a window of days when the types have a date, and none for All time', () => {
    const range = { from: '2026-11-05T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' };
    const view = render(<ExpandWindowField window={{ days: 7 }} onChange={() => undefined} range={range} dated="all" />);
    expect(view.getByText(/5 Nov 2026 to 12 Nov 2026 UTC/)).not.toBeNull();
    view.rerender(<ExpandWindowField window="all" onChange={() => undefined} range={range} dated="all" />);
    expect(view.queryByText(/5 Nov 2026 to 12 Nov 2026 UTC/)).toBeNull();
  });

  it('shows no UTC dates when no relationship type has a date, because the window does not apply', async () => {
    const { open, expansions } = panelRig();
    await open();
    const user = userEvent.setup();
    await user.click(loadButton());
    await answerExpand(expansions[0], response({ window: { from: '2026-11-05T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' }, pages: [{ neighborType: 'kind-b', returned: 1, hasMore: false, matchingTotal: { value: 1, quality: 'exact', scope: 'relationships' }, window: { applied: 'none', notAppliedTo: ['link-a'] } }] }));
    expect(inPanel().queryByText(/5 Nov 2026 to 12 Nov 2026 UTC/)).toBeNull();
  });
});
