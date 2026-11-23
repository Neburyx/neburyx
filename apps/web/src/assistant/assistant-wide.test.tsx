import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ASSISTANT_REFUSAL_SENTENCES } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { useStoreSelector } from '../state/store.js';
import { floatingLimits, drawnWidth, windowShareWidth } from '../workspace/panel-limits.js';
import { PanelSizeContext } from '../workspace/panel-host.js';
import { harness, REFUSE, typeAndSend } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';
import { ASSISTANT_PANEL_ID, ASSISTANT_PANEL_WIDE_SIZE, ASSISTANT_PANEL_WIDEST_SHARE, ASSISTANT_PANEL_WIDTH } from './panel-layout.js';

afterEach(cleanup);

function setup(windowWidth: number, canvasWidth: number) {
  const h = harness(async () => ({ ok: true, value: REFUSE }));
  const limits = floatingLimits(canvasWidth, 16, windowShareWidth(ASSISTANT_PANEL_WIDEST_SHARE, windowWidth));
  function Sized() {
    const stored = useStoreSelector(h.state.presentation.view, (view) => view.panelSizes.get(ASSISTANT_PANEL_ID));
    return <PanelSizeContext.Provider value={{ width: drawnWidth(stored, ASSISTANT_PANEL_WIDTH, limits), limits }}>{h.tree()}</PanelSizeContext.Provider>;
  }
  const stored = () => h.state.presentation.view.getState().panelSizes.get(ASSISTANT_PANEL_ID);
  return { h, Sized, stored };
}

const wideButton = (): HTMLButtonElement => {
  const found = screen.getByRole('button', { name: /^(Wide|Normal width)$/ });
  if (!(found instanceof HTMLButtonElement)) throw new Error('the Wide button is not a button element');
  return found;
};

describe('the Wide button of the Assistant panel', () => {
  it('widens the panel to its limit and back to its opening width, tinted and pressed while wide, with its name following', async () => {
    const { Sized, stored } = setup(1440, 1384);
    render(<Sized />);
    expect(wideButton().getAttribute('aria-pressed')).toBe('false');
    expect(wideButton().getAttribute('aria-label')).toBe(ASSISTANT_COPY.wide);
    await userEvent.click(wideButton());
    expect(stored()).toBe(ASSISTANT_PANEL_WIDE_SIZE);
    expect(wideButton().getAttribute('aria-pressed')).toBe('true');
    expect(wideButton().getAttribute('aria-label')).toBe(ASSISTANT_COPY.normalWidth);
    await userEvent.click(wideButton());
    expect(stored()).toBeUndefined();
    expect(wideButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('works from the keyboard with Enter and Space and keeps its focus, and comes before Close in the tab order', async () => {
    const { Sized, stored } = setup(1440, 1384);
    render(<Sized />);
    wideButton().focus();
    await userEvent.keyboard('{Enter}');
    expect(stored()).toBe(ASSISTANT_PANEL_WIDE_SIZE);
    expect(document.activeElement).toBe(wideButton());
    await userEvent.keyboard(' ');
    expect(stored()).toBeUndefined();
    expect(document.activeElement).toBe(wideButton());
    const tabs = screen.getAllByRole('button').filter((button) => button === wideButton() || button.getAttribute('aria-label') === ASSISTANT_COPY.close);
    expect(tabs.map((button) => button.getAttribute('aria-label'))).toEqual([ASSISTANT_COPY.wide, ASSISTANT_COPY.close]);
  });

  it('shows a panel dragged to the limit as wide, and returns it to the opening width', async () => {
    const { h, Sized, stored } = setup(1440, 1384);
    render(<Sized />);
    act(() => h.state.presentation.setPanelSize(ASSISTANT_PANEL_ID, 864));
    expect(wideButton().getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(wideButton());
    expect(stored()).toBeUndefined();
  });

  it('is not pressed for a width under the limit, and for a stored width the limit has since cut it is pressed because the panel is drawn at the limit', () => {
    const { h, Sized } = setup(1440, 1384);
    render(<Sized />);
    act(() => h.state.presentation.setPanelSize(ASSISTANT_PANEL_ID, 700));
    expect(wideButton().getAttribute('aria-pressed')).toBe('false');
    act(() => h.state.presentation.setPanelSize(ASSISTANT_PANEL_ID, 5000));
    expect(wideButton().getAttribute('aria-pressed')).toBe('true');
  });

  it.each([
    [634, 578],
    [390, 334],
  ])('is disabled, untinted and not pressed in a %i px window, whatever width the panel is drawn at, even one dragged to the limit', (windowWidth, canvasWidth) => {
    const { h, Sized } = setup(windowWidth, canvasWidth);
    render(<Sized />);
    expect(wideButton().disabled).toBe(true);
    expect(wideButton().getAttribute('aria-pressed')).toBe('false');
    act(() => h.state.presentation.setPanelSize(ASSISTANT_PANEL_ID, 5000));
    expect(wideButton().disabled).toBe(true);
    expect(wideButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('is enabled in a 635 px window, where the limit is 381 px', () => {
    const { Sized } = setup(635, 579);
    render(<Sized />);
    expect(wideButton().disabled).toBe(false);
  });

  it('leaves the thread, the text typed and the focus as they were when pressed, with an answer in the thread', async () => {
    const { h, Sized } = setup(1440, 1384);
    render(<Sized />);
    await typeAndSend('who shares a device');
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    const field = screen.getByLabelText(ASSISTANT_COPY.fieldLabel);
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('the message field is not a textarea');
    await userEvent.type(field, 'and the other');
    const turns = h.session.store.getState().turns.length;
    await userEvent.click(wideButton());
    expect(field.value).toBe('and the other');
    expect(h.session.store.getState().turns).toHaveLength(turns);
    expect(document.activeElement).toBe(wideButton());
  });

  it('is absent when the panel is not drawn by the panel host', () => {
    const h = harness(async () => ({ ok: true, value: REFUSE }));
    render(h.tree());
    expect(screen.queryByRole('button', { name: /^(Wide|Normal width)$/ })).toBeNull();
  });

  it('leaves a pending turn pending when pressed', async () => {
    const h = harness(() => new Promise(() => undefined));
    const limits = floatingLimits(1384, 16, windowShareWidth(ASSISTANT_PANEL_WIDEST_SHARE, 1440));
    render(<PanelSizeContext.Provider value={{ width: ASSISTANT_PANEL_WIDTH, limits }}>{h.tree()}</PanelSizeContext.Provider>);
    await typeAndSend('who shares a device');
    expect(h.session.store.getState().turns.some((turn) => turn.outcome.kind === 'pending')).toBe(true);
    await userEvent.click(wideButton());
    expect(h.session.store.getState().turns.some((turn) => turn.outcome.kind === 'pending')).toBe(true);
    expect(h.state.presentation.view.getState().panelSizes.get(ASSISTANT_PANEL_ID)).toBe(ASSISTANT_PANEL_WIDE_SIZE);
  });
});
