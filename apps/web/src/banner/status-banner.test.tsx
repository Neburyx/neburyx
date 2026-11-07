import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { clientWith, me, need, renderApp, source } from '../test-utils.js';
import { createClientState } from '../state/client-state.js';
import { createBannerController } from './banner-controller.js';
import { action, sampleBanner } from './banner-fixtures.js';

function open(state = createClientState()) {
  const banner = createBannerController();
  const app = renderApp('/explore', clientWith({ me: me(), sources: [source('a')] }), state, undefined, undefined, undefined, undefined, undefined, undefined, undefined, banner);
  return app;
}

const polite = (): Element => need(document.querySelector('[aria-live="polite"]'));
const assertive = (): Element => need(document.querySelector('[aria-live="assertive"]'));
const region = () => screen.queryByRole('region', { name: 'Request status' });

describe('the request status banner', () => {
  it('shows nothing and announces nothing when no state was shown', () => {
    open();
    expect(region()).toBeNull();
    expect(polite().textContent).toBe('');
    expect(assertive().textContent).toBe('');
  });

  it('shows the chip, headline, explanation, side label and actions above the canvas', () => {
    const { banner } = open();
    act(() => banner.show(sampleBanner()));
    const shown = within(region() as HTMLElement);
    expect(shown.getByText('Sample')).toBeTruthy();
    expect(shown.getByText('A sample headline')).toBeTruthy();
    expect(shown.getByText('A sample explanation line.')).toBeTruthy();
    expect(shown.getByText('A side label')).toBeTruthy();
    expect(shown.getByRole('button', { name: 'First action' })).toBeTruthy();
    const position = (region() as HTMLElement).compareDocumentPosition(screen.getByRole('main'));
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves out the side label when the state has none', () => {
    const { banner } = open();
    act(() => banner.show(sampleBanner({ sideLabel: undefined })));
    expect(screen.queryByText('A side label')).toBeNull();
  });

  it('replaces the banner on screen with the next state, so only one is shown', () => {
    const { banner } = open();
    act(() => banner.show(sampleBanner()));
    act(() => banner.show(sampleBanner({ id: 'next', headline: 'The next headline', actions: [] })));
    expect(screen.getAllByRole('region', { name: 'Request status' })).toHaveLength(1);
    expect(screen.queryByText('A sample headline')).toBeNull();
    expect(screen.getByText('The next headline')).toBeTruthy();
  });

  it('dismisses with the Dismiss button, and dismissing again or with nothing shown changes nothing', async () => {
    const { banner } = open();
    act(() => banner.dismiss('sample'));
    expect(region()).toBeNull();
    act(() => banner.show(sampleBanner()));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(region()).toBeNull();
    act(() => banner.dismiss('sample'));
    expect(region()).toBeNull();
  });

  it('draws no Dismiss on a state that is not dismissible', () => {
    const { banner } = open();
    act(() => banner.show(sampleBanner({ dismissible: false })));
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('keeps the banner on screen when the ID of a state that is gone is dismissed', () => {
    const { banner } = open();
    act(() => banner.show(sampleBanner({ id: 'old' })));
    act(() => banner.show(sampleBanner({ id: 'newer', headline: 'The newer headline' })));
    act(() => banner.dismiss('old'));
    expect(screen.getByText('The newer headline')).toBeTruthy();
  });

  it('leaves the graph, the filters, the selection and the draft as they were through show, replace and dismiss', () => {
    const state = createClientState();
    const before = { server: state.server.getState(), investigation: state.investigation.getState(), presentation: state.presentation.view.getState(), jobs: state.jobs.getState(), mask: state.mask.getState() };
    const { banner } = open(state);
    act(() => banner.show(sampleBanner()));
    act(() => banner.show(sampleBanner({ id: 'next' })));
    act(() => banner.dismiss('next'));
    expect({ server: state.server.getState(), investigation: state.investigation.getState(), presentation: state.presentation.view.getState(), jobs: state.jobs.getState(), mask: state.mask.getState() }).toEqual(before);
    expect(state.server.getState()).toBe(before.server);
    expect(state.investigation.getState()).toBe(before.investigation);
    expect(state.presentation.view.getState()).toBe(before.presentation);
    expect(state.jobs.getState()).toBe(before.jobs);
  });

  it('announces a new state once, as an alert for danger and politely otherwise, and does not move the focus', () => {
    const { banner } = open();
    const focused = document.activeElement;
    act(() => banner.show(sampleBanner()));
    expect(polite().textContent).toBe('Sample. A sample headline. A sample explanation line.');
    expect(assertive().textContent).toBe('');
    act(() => banner.show(sampleBanner({ id: 'bad', tone: 'danger', chip: 'Unavailable', headline: 'Down', text: 'Kept.' })));
    expect(assertive().textContent).toBe('Unavailable. Down. Kept.');
    expect(polite().textContent).toBe('');
    expect(document.activeElement).toBe(focused);
    act(() => banner.dismiss('bad'));
    expect(assertive().textContent).toBe('');
  });

  it('makes the banner reachable by Tab in reading order and operable with Enter and Space', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { banner } = open();
    act(() => banner.show(sampleBanner({ actions: [action('first', 'First action', first), action('second', 'Second action', second)] })));
    const user = userEvent.setup();
    const first_ = screen.getByRole('button', { name: 'First action' });
    first_.focus();
    await user.keyboard('{Enter}');
    expect(first).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second action' }));
    await user.keyboard(' ');
    expect(second).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' }));
  });

  it('updates a state with the same ID in place: the focused action keeps the focus and nothing is announced again', () => {
    const { banner } = open();
    act(() => banner.show(sampleBanner({ headline: 'Retry after 12 s', actions: [action('retry', 'Retry in 12 s')] })));
    const button = screen.getByRole('button', { name: 'Retry in 12 s' });
    button.focus();
    act(() => banner.show(sampleBanner({ headline: 'Retry after 11 s', actions: [action('retry', 'Retry in 11 s')] })));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry in 11 s' }));
    expect(screen.getByText('Retry after 11 s')).toBeTruthy();
    expect(polite().textContent).toContain('Retry after 12 s');
  });

  it('announces an update of the same ID when the state asks for it', () => {
    const { banner } = open();
    act(() => banner.show(sampleBanner()));
    act(() => banner.show(sampleBanner({ headline: 'Changed headline', announce: true })));
    expect(polite().textContent).toContain('Changed headline');
  });

  it('puts the focus on the banner region, not on the page, when Dismiss removes the banner', async () => {
    const { banner } = open();
    act(() => banner.show(sampleBanner()));
    const user = userEvent.setup();
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    await user.keyboard('{Enter}');
    expect(region()).toBeNull();
    expect(document.activeElement).toBe(need(document.querySelector('.banner-region')));
  });

  it('leaves the focus where it is when an action that keeps the banner is activated', async () => {
    const { banner } = open();
    act(() => banner.show(sampleBanner()));
    const user = userEvent.setup();
    const first = screen.getByRole('button', { name: 'First action' });
    first.focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(first);
  });

  it('does not move the focus when the code dismisses the banner after an action that kept it', async () => {
    const { banner } = open();
    act(() => banner.show(sampleBanner()));
    const first = screen.getByRole('button', { name: 'First action' });
    first.focus();
    await userEvent.setup().keyboard('{Enter}');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    first.focus();
    act(() => banner.dismiss('sample'));
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps a banner shown in the same update as the change of investigation', () => {
    const state = createClientState();
    const { banner } = open(state);
    act(() => state.bindSource('a'));
    act(() => {
      state.bindSource('b');
      banner.show(sampleBanner({ headline: 'For the new investigation' }));
    });
    expect(screen.getByText('For the new investigation')).toBeTruthy();
  });

  it('leaves no banner when the open investigation changes', () => {
    const state = createClientState();
    const { banner } = open(state);
    act(() => state.bindSource('a'));
    act(() => banner.show(sampleBanner()));
    expect(region()).toBeTruthy();
    act(() => state.bindSource('b'));
    expect(region()).toBeNull();
  });

  it('leaves no banner when the workspace is left', () => {
    const { banner, router } = open();
    act(() => banner.show(sampleBanner()));
    act(() => {
      void router.navigate('/sources');
    });
    expect(banner.view.getState().banner).toBeUndefined();
  });
});
