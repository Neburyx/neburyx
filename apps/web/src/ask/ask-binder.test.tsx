import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskAnswer } from '@neburyx/contracts';
import { ApiClientProvider } from '../api/client-context.js';
import { fakeClient } from '../api/fake-client.js';
import { okRun } from '../patterns/patterns-kit.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { createToolRegistry, ToolsProvider } from '../workspace/tool-registry.js';
import { createPanelRegistryFor } from '../workspace/panel-registry.js';
import { bindAskPanel } from './ask-binder.js';

afterEach(cleanup);

const ANSWER: AskAnswer = { answered: { intent: 'shared-devices', entities: { account: 'acc-1' }, outcome: 'complete', result: { templateId: 'shared-attribute', result: okRun(['acc-2']) } } };
const CLEARED = 'Masking changed, so this answer is cleared. Ask again to see it.';

describe('the Ask session while its panel is closed', () => {
  it('is cleared when masking is turned on, and stays cleared when masking is turned off before the panel opens again', async () => {
    const state = createClientState();
    state.bindSource('a');
    const panels = createPanelRegistryFor(state);
    const register = vi.spyOn(panels, 'register');
    const unbind = bindAskPanel(state, panels);
    const client = fakeClient({ ask: async () => ({ ok: true, value: ANSWER }) });
    const view = (content: (() => React.ReactNode) | undefined) => (
      <ApiClientProvider client={client}>
        <ClientStateProvider state={state}>
          <ToolsProvider registry={createToolRegistry()}>{content?.()}</ToolsProvider>
        </ClientStateProvider>
      </ApiClientProvider>
    );
    const contentOf = () => register.mock.calls.at(-1)?.[0].content;
    act(() => state.presentation.setAskOpen(true));
    const first = render(view(() => {
      const Content = contentOf();
      return Content === undefined ? null : <Content />;
    }));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    await screen.findByRole('heading', { name: 'Answer ready' });
    first.unmount();
    act(() => state.presentation.setAskOpen(false));
    act(() => state.setMask(true));
    act(() => state.setMask(false));
    act(() => state.presentation.setAskOpen(true));
    render(view(() => {
      const Content = contentOf();
      return Content === undefined ? null : <Content />;
    }));
    expect(await screen.findByText(CLEARED, { selector: 'p.ask-note' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Answer ready' })).toBeNull();
    unbind();
  });
});
