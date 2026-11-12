import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShellData, ShellDataProvider } from '../shell/shell-data.js';
import { clientWith, me } from '../test-utils.js';
import { AiActionsProvider, createAiActions, type AiActions } from './ai-actions.js';
import { AiHeaderControl } from './ai-header-control.js';
import type { ApiClient } from '../api/client.js';

afterEach(cleanup);

function draw(client: ApiClient, actions: AiActions = createAiActions()) {
  render(
    <ShellDataProvider store={createShellData(client)}>
      <AiActionsProvider value={actions}>
        <AiHeaderControl action="ask" />
        <AiHeaderControl action="summarize" />
      </AiActionsProvider>
    </ShellDataProvider>,
  );
  return actions;
}

const withEdition = (edition: MeResponse['edition']) => clientWith({ me: me({ edition }), sources: [] });

describe('Ask and Summarize in the header', () => {
  it('are locked for a community build: a padlock, the Enterprise reason as name and tooltip, focusable, and no pill', async () => {
    draw(withEdition('community'));
    const ask = await screen.findByRole('button', { name: 'Ask, Enterprise capability, locked' });
    expect(ask.getAttribute('aria-disabled')).toBe('true');
    expect(ask.getAttribute('title')).toBe('Enterprise capability, locked');
    expect(ask.querySelector('svg rect')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Summarize, Enterprise capability, locked' })).toBeTruthy();
    expect(screen.queryByText('Enterprise')).toBeNull();
    await userEvent.setup().tab();
    expect(document.activeElement).toBe(ask);
  });

  it('are unlocked for an enterprise build: enabled, named by their label, with no tooltip', async () => {
    draw(withEdition('enterprise'));
    const ask = await screen.findByRole('button', { name: 'Ask' });
    expect(ask.getAttribute('aria-disabled')).toBeNull();
    expect(ask.getAttribute('title')).toBeNull();
    expect(screen.getByRole('button', { name: 'Summarize' })).toBeTruthy();
  });

  it('draw nothing while the answer is not here, and are locked when the read failed', async () => {
    const never = clientWith({ me: me() });
    never.getMe = () => new Promise(() => undefined);
    draw(never);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    draw(clientWith({ sources: [] }));
    expect(await screen.findByRole('button', { name: 'Ask, Enterprise capability, locked' })).toBeTruthy();
  });

  it('run nothing when a locked control is activated by click, Enter or Space, even with a handler registered', async () => {
    const actions = createAiActions();
    const handler = vi.fn();
    actions.register('ask', handler);
    draw(withEdition('community'), actions);
    const user = userEvent.setup();
    const ask = await screen.findByRole('button', { name: 'Ask, Enterprise capability, locked' });
    await user.click(ask);
    ask.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(handler).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(ask);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('run the handler of an unlocked control once, with no message, and say it is not available after the handler is taken out', async () => {
    const actions = createAiActions();
    const handler = vi.fn();
    const remove = actions.register('ask', handler);
    draw(withEdition('enterprise'), actions);
    const user = userEvent.setup();
    const ask = await screen.findByRole('button', { name: 'Ask' });
    await user.click(ask);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Ask is not available in this release yet.')).toBeNull();
    remove();
    await user.click(ask);
    expect(await screen.findByText('Ask is not available in this release yet.')).toBeTruthy();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('say the control is not available yet when none is registered, keep the focus, and take the line away on Escape and on blur', async () => {
    draw(withEdition('enterprise'));
    const user = userEvent.setup();
    const summarize = await screen.findByRole('button', { name: 'Summarize' });
    await user.click(summarize);
    expect(await screen.findByText('Summarize is not available in this release yet.')).toBeTruthy();
    expect(screen.getAllByRole('status').map((line) => line.textContent)).toContain('Summarize is not available in this release yet.');
    expect(document.activeElement).toBe(summarize);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Summarize is not available in this release yet.')).toBeNull());
    await user.click(summarize);
    expect(await screen.findByText('Summarize is not available in this release yet.')).toBeTruthy();
    await user.tab();
    await waitFor(() => expect(screen.queryByText('Summarize is not available in this release yet.')).toBeNull());
  });
});
