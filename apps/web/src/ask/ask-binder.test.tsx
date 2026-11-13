import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AiActionsProvider, createAiActions } from '../ai/ai-actions.js';
import { AiHeaderControl } from '../ai/ai-header-control.js';
import { ApiClientProvider } from '../api/client-context.js';
import { createShellData, ShellDataProvider } from '../shell/shell-data.js';
import { createClientState } from '../state/client-state.js';
import { createPresentationStore } from '../state/presentation-state.js';
import { clientWith, me } from '../test-utils.js';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { aiActions } from '../ai/ai-actions.js';
import { bindAskPanel } from './ask-binder.js';
import { answerAsk, askClient, drawAsk, field, previewOf } from './ask-kit.js';

afterEach(cleanup);

describe('the Ask panel and its place', () => {
  it('registers the Ask action once, opens the panel when the action runs and takes it away when it runs again', () => {
    const state = createClientState();
    const panels = createPanelRegistry();
    const unbind = bindAskPanel(state, panels);
    const run = aiActions.view.getState().get('ask');
    expect(run).toBeDefined();
    run?.();
    expect(state.presentation.view.getState().askOpen).toBe(true);
    expect(panels.view.getState().map((panel) => panel.id)).toEqual(['ask']);
    expect(panels.view.getState()[0]?.placement).toMatchObject({ kind: 'floating', side: 'right' });
    run?.();
    expect(panels.view.getState()).toEqual([]);
    unbind();
    expect(aiActions.view.getState().has('ask')).toBe(false);
  });

  it('draws the Ask panel above the Inspector when both are open: the one registered later is above, and the Inspector stays', () => {
    const state = createClientState();
    const panels = createPanelRegistry();
    panels.register({ id: 'inspector', title: 'Inspector', placement: { kind: 'floating', side: 'right', top: 0 }, content: () => null });
    const unbind = bindAskPanel(state, panels);
    aiActions.view.getState().get('ask')?.();
    expect(panels.view.getState().map((panel) => panel.id)).toEqual(['inspector', 'ask']);
    state.presentation.setAskOpen(false);
    expect(panels.view.getState().map((panel) => panel.id)).toEqual(['inspector']);
    unbind();
  });

  it('closes when no source is bound any more', () => {
    const state = createClientState();
    state.bindSource('demo');
    state.presentation.setAskOpen(true);
    state.unbindSource();
    expect(state.presentation.view.getState().askOpen).toBe(false);
  });

  it('keeps Ask open across a reset of the presentation, as the other panels stay', () => {
    const presentation = createPresentationStore({ isNode: () => false, isElement: () => false });
    presentation.setAskOpen(true);
    presentation.reset();
    expect(presentation.view.getState().askOpen).toBe(true);
  });

  it('sends no Ask request from a Community build: the control stays locked and does nothing', async () => {
    const { client, asks, searches } = askClient();
    const actions = createAiActions();
    const store = createShellData(clientWith({ me: me({ edition: 'community' }), sources: [] }));
    render(
      <ApiClientProvider client={client}>
        <ShellDataProvider store={store}>
          <AiActionsProvider value={actions}>
            <AiHeaderControl action="ask" />
          </AiActionsProvider>
        </ShellDataProvider>
      </ApiClientProvider>,
    );
    const control = await screen.findByRole('button', { name: 'Ask, Enterprise capability, locked' });
    await userEvent.click(control);
    await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('true'));
    expect([asks, searches]).toEqual([[], []]);
  });

  it('does nothing when the Ask control is used while a question is being sent, and works again after the answer', async () => {
    const harness = drawAsk();
    const panels = createPanelRegistry();
    const unbind = bindAskPanel(harness.state, panels);
    harness.state.presentation.setAskOpen(true);
    await userEvent.type(field(), 'which widgets');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await answerAsk(harness.asks[0], previewOf('which widgets'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    aiActions.view.getState().get('ask')?.();
    expect(harness.state.presentation.view.getState().askOpen).toBe(true);
    await answerAsk(harness.asks[1], { ok: true, value: { plan: { kind: 'unsupported', family: 'other', reason: 'No template fits.' } } });
    aiActions.view.getState().get('ask')?.();
    expect(harness.state.presentation.view.getState().askOpen).toBe(false);
    unbind();
  });
});
