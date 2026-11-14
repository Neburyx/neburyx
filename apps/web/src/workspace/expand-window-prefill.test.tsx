import { act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { inPanel, panelRig } from './supernode-kit.js';

afterEach(() => cleanup());

const windowSelect = () => inPanel().getByRole('combobox', { name: /Time window/ });
const loadButton = () => inPanel().getByRole('button', { name: 'Load 25 per type' });
const PREFILLED = 'Window pre-filled from your filter';

describe('the window of the Expand panel when the Filters panel has a time window', () => {
  it('starts from it, says so, and sends it', async () => {
    const rig = panelRig();
    rig.state.setTimeWindow({ days: 30 });
    await rig.open();
    expect(windowSelect()).toHaveProperty('value', '30');
    expect(inPanel().getByText(PREFILLED)).toBeTruthy();
    await userEvent.setup().click(loadButton());
    expect(rig.expansions[0]?.body.window).toEqual({ days: 30 });
  });

  it('starts from a window of dates, shows the dates, and sends them', async () => {
    const rig = panelRig();
    rig.state.setTimeWindow({ from: '2026-10-21', to: '2026-10-28' });
    await rig.open();
    expect(windowSelect()).toHaveProperty('value', 'dates');
    expect(inPanel().getByRole('textbox', { name: 'From (UTC date)' })).toHaveProperty('value', '2026-10-21');
    await userEvent.setup().click(loadButton());
    expect(rig.expansions[0]?.body.window).toEqual({ from: '2026-10-21', to: '2026-10-28' });
  });

  it('follows the filter while the person has not chosen, and the note goes once they choose', async () => {
    const rig = panelRig();
    await rig.open();
    expect(windowSelect()).toHaveProperty('value', '7');
    expect(inPanel().queryByText(PREFILLED)).toBeNull();
    act(() => rig.state.setTimeWindow({ days: 90 }));
    expect(windowSelect()).toHaveProperty('value', '90');
    expect(inPanel().getByText(PREFILLED)).toBeTruthy();
    const user = userEvent.setup();
    await user.selectOptions(windowSelect(), 'All time');
    expect(inPanel().queryByText(PREFILLED)).toBeNull();
    await user.click(loadButton());
    expect(rig.expansions[0]?.body).not.toHaveProperty('window');
  });

  it('keeps the window the person chose when the filter changes, and when it is reset', async () => {
    const rig = panelRig();
    rig.state.setTimeWindow({ days: 30 });
    await rig.open();
    const user = userEvent.setup();
    await user.selectOptions(windowSelect(), 'Last 365 days');
    act(() => rig.state.setTimeWindow({ days: 90 }));
    expect(windowSelect()).toHaveProperty('value', '365');
    act(() => rig.state.setTimeWindow(undefined));
    expect(windowSelect()).toHaveProperty('value', '365');
    await user.click(loadButton());
    expect(rig.expansions[0]?.body.window).toEqual({ days: 365 });
  });

  it('is the last 7 days again when the filter is reset and the person never chose', async () => {
    const rig = panelRig();
    rig.state.setTimeWindow({ days: 30 });
    await rig.open();
    act(() => rig.state.setTimeWindow(undefined));
    expect(windowSelect()).toHaveProperty('value', '7');
    expect(inPanel().queryByText(PREFILLED)).toBeNull();
  });
});
