import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { clientWith, counted, me, renderApp, source } from '../test-utils.js';
import { LOCK_TOOLTIP } from './locked-control.js';

const enterprise = me({ edition: 'enterprise', identityMode: 'sso', principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Maya Chen', role: 'investigator' } });
const header = () => within(screen.getByRole('banner', { name: 'Investigation' }));

describe('the locked Ask and Summarize controls', () => {
  it('show a lock and their names, are named as locked and are reached by Tab', async () => {
    renderApp('/explore', clientWith({ me: me(), sources: [source('a')] }));
    const ask = header().getByRole('button', { name: 'Ask, locked' });
    const summarize = header().getByRole('button', { name: 'Summarize, locked' });
    expect(ask.textContent).toBe('Ask');
    expect(summarize.textContent).toBe('Summarize');
    expect(ask.querySelector('.icon-lock')?.getAttribute('aria-hidden')).toBe('true');
    const user = userEvent.setup();
    for (let presses = 0; presses < 10 && document.activeElement !== ask; presses += 1) await user.tab();
    expect(document.activeElement).toBe(ask);
    await user.tab();
    expect(document.activeElement).toBe(summarize);
  });

  it.each([
    ['Community', me()],
    ['Enterprise', enterprise],
  ])('change nothing when clicked or pressed with Enter or Space, for %s: no navigation, no dialog, no request', async (_edition, principal) => {
    const { client, calls } = counted(clientWith({ me: principal, sources: [source('a')] }));
    const { router } = renderApp('/explore', client);
    await screen.findByRole('region', { name: 'Source' });
    const before = { me: calls.me, sources: calls.sources, path: router.state.location.pathname };
    const user = userEvent.setup();
    for (const name of ['Ask, locked', 'Summarize, locked']) {
      const control = header().getByRole('button', { name });
      await user.click(control);
      control.focus();
      await user.keyboard('{Enter}');
      await user.keyboard(' ');
    }
    expect(screen.queryByRole('dialog')).toBeNull();
    expect({ me: calls.me, sources: calls.sources, path: router.state.location.pathname }).toEqual(before);
  });

  it('show "Enterprise" on hover and on focus for a Community principal, and not for an Enterprise principal', async () => {
    renderApp('/explore', clientWith({ me: me(), sources: [] }));
    await screen.findByText('Local workspace');
    const user = userEvent.setup();
    const ask = header().getByRole('button', { name: 'Ask, locked' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.hover(ask);
    expect(screen.getByRole('tooltip').textContent).toBe(LOCK_TOOLTIP);
    expect(ask.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
    await user.unhover(ask);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => ask.focus());
    expect(screen.getByRole('tooltip').textContent).toBe('Enterprise');
    act(() => ask.blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keep the tooltip while either hover or focus applies, in either order', async () => {
    renderApp('/explore', clientWith({ me: me(), sources: [] }));
    await screen.findByText('Local workspace');
    const user = userEvent.setup();
    const ask = header().getByRole('button', { name: 'Ask, locked' });
    act(() => ask.focus());
    await user.hover(ask);
    await user.unhover(ask);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    act(() => ask.blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.hover(ask);
    act(() => ask.focus());
    act(() => ask.blur());
    expect(screen.getByRole('tooltip')).toBeTruthy();
    await user.unhover(ask);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('show no tooltip for an Enterprise principal, nor while the principal is unknown', async () => {
    renderApp('/explore', clientWith({ me: enterprise, sources: [] }));
    await screen.findByRole('img', { name: 'Maya Chen' });
    await userEvent.setup().hover(header().getByRole('button', { name: 'Summarize, locked' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('are followed by the Views, Export and Save stand-ins in that order', () => {
    const { slots } = renderApp('/explore', clientWith({ me: me(), sources: [] }));
    act(() => {
      slots.register('save', () => <button type="button">Save</button>);
      slots.register('views', () => <button type="button">Views</button>);
      slots.register('export', () => <button type="button">Export</button>);
    });
    const names = header().getAllByRole('button').map((button) => button.textContent);
    expect(names).toEqual(['Ask', 'Summarize', 'Views', 'Export', 'Save']);
  });

  it('are replaced in the same place by a feature that registers ask or summarize', () => {
    const { slots } = renderApp('/explore', clientWith({ me: me(), sources: [] }));
    act(() => {
      slots.register('ask', () => <button type="button">Ask now</button>);
    });
    expect(header().queryByRole('button', { name: 'Ask, locked' })).toBeNull();
    expect(header().getAllByRole('button').map((button) => button.textContent)).toEqual(['Ask now', 'Summarize']);
  });
});
