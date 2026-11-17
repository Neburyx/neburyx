import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShellData, ShellDataProvider } from '../shell/shell-data.js';
import { aiStatus, AI_STATUS_NONE, clientWith, me } from '../test-utils.js';
import { AiActionsProvider, createAiActions, type AiActions } from './ai-actions.js';
import { AiHeaderControl } from './ai-header-control.js';
import type { ApiClient } from '../api/client.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';

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

const withStatus = (available: { ask?: boolean; summary?: boolean }, edition: 'community' | 'enterprise' = 'community') => clientWith({ me: me({ edition }), sources: [], aiStatus: aiStatus(available) });
const REASON = 'Not available: AI is switched off, or no AI provider is configured.';

describe('Ask and Summarize in the header', () => {
  it('are available when the status says so, in the Community edition too: enabled, named by their label, with no tooltip and no padlock', async () => {
    draw(withStatus({ ask: true, summary: true }));
    const ask = await screen.findByRole('button', { name: 'Ask' });
    expect(ask.getAttribute('aria-disabled')).toBeNull();
    expect(ask.getAttribute('title')).toBeNull();
    expect(ask.querySelector('svg rect')).toBeNull();
    expect(screen.getByRole('button', { name: 'Summarize' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Enterprise/ })).toBeNull();
  });

  it('follow each feature on its own: Ask available and Summarize not, and the other way round', async () => {
    draw(withStatus({ ask: true }));
    expect((await screen.findByRole('button', { name: 'Ask' })).getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByRole('button', { name: 'Summarize' }).getAttribute('aria-disabled')).toBe('true');
    cleanup();
    draw(withStatus({ summary: true }));
    expect((await screen.findByRole('button', { name: 'Summarize' })).getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ask' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('are dimmed when the status says a feature is not available: focusable, named by their label, with the reason as tooltip and description, and no padlock', async () => {
    draw(clientWith({ me: me(), sources: [], aiStatus: AI_STATUS_NONE }));
    const ask = await screen.findByRole('button', { name: 'Ask' });
    expect(ask.getAttribute('aria-disabled')).toBe('true');
    expect(ask.getAttribute('title')).toBe(REASON);
    expect(ask.className).toContain('header-ai-unavailable');
    expect(ask.querySelector('svg rect')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ask', description: REASON })).toBe(ask);
    expect(screen.getByRole('button', { name: 'Summarize', description: REASON })).toBeTruthy();
    await userEvent.setup().tab();
    expect(document.activeElement).toBe(ask);
  });

  it('draw nothing while the status has not answered, and dim with the same reason when its read failed', async () => {
    const never = clientWith({ me: me(), sources: [] });
    never.getAiStatus = () => new Promise(() => undefined);
    draw(never);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    draw(clientWith({ me: me(), sources: [] }));
    expect(await screen.findByRole('button', { name: 'Ask', description: REASON })).toBeTruthy();
  });

  it('run nothing when a dimmed control is activated by click, Enter or Space, even with a handler registered, and say why', async () => {
    const actions = createAiActions();
    const handler = vi.fn();
    actions.register('ask', handler);
    draw(clientWith({ me: me(), sources: [], aiStatus: AI_STATUS_NONE }), actions);
    const user = userEvent.setup();
    const ask = await screen.findByRole('button', { name: 'Ask' });
    await user.click(ask);
    ask.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(handler).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(ask);
    expect(screen.getAllByRole('status').map((status) => status.textContent)).toContain(REASON);
  });

  it('run the handler of an available control once, with no message, and say it is not available after the handler is taken out', async () => {
    const actions = createAiActions();
    const handler = vi.fn();
    const remove = actions.register('ask', handler);
    draw(withStatus({ ask: true, summary: true }), actions);
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
    draw(withStatus({ ask: true, summary: true }));
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

describe('the Ask control while its panel is open', () => {
  it('is drawn active and says it is expanded, and goes back when the panel closes; Summarize follows its own panel', async () => {
    const state = createClientState();
    render(
      <ClientStateProvider state={state}>
        <ShellDataProvider store={createShellData(withStatus({ ask: true, summary: true }))}>
          <AiActionsProvider value={createAiActions()}>
            <AiHeaderControl action="ask" />
            <AiHeaderControl action="summarize" />
          </AiActionsProvider>
        </ShellDataProvider>
      </ClientStateProvider>,
    );
    const ask = await screen.findByRole('button', { name: 'Ask' });
    expect(ask.getAttribute('aria-expanded')).toBe('false');
    act(() => state.presentation.setAskOpen(true));
    expect(ask.getAttribute('aria-expanded')).toBe('true');
    expect(ask.className).toContain('header-ai-active');
    const summarize = screen.getByRole('button', { name: 'Summarize' });
    expect(summarize.getAttribute('aria-expanded')).toBe('false');
    act(() => state.presentation.setAskOpen(false));
    expect(ask.className).not.toContain('header-ai-active');
    act(() => state.presentation.setSummaryOpen(true));
    expect(summarize.getAttribute('aria-expanded')).toBe('true');
    expect(summarize.className).toContain('header-ai-active');
    expect(ask.getAttribute('aria-expanded')).toBe('false');
  });
});
