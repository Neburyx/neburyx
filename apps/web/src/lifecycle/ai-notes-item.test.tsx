import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiActionsProvider, createAiActions } from '../ai/ai-actions.js';
import { fakeClient } from '../api/fake-client.js';
import { BannerProvider } from '../banner/banner-context.js';
import { createBannerController } from '../banner/banner-controller.js';
import { createShellData, ShellDataProvider } from '../shell/shell-data.js';
import { ClientStateProvider } from '../state/context.js';
import { aiStatus, clientWith, me } from '../test-utils.js';
import { InvestigationIdentity } from '../workspace/investigation-identity.js';
import { createSlotRegistry, SlotsProvider } from '../workspace/slots.js';
import { shownState } from './harness.js';
import { registerInvestigationMenu } from './register-menu.js';

afterEach(cleanup);

function drawMenu(available: { ask?: boolean; summary?: boolean }, notes: () => void) {
  const slots = createSlotRegistry();
  registerInvestigationMenu(slots, fakeClient());
  const actions = createAiActions();
  actions.register('notes', notes);
  render(
    <MemoryRouter>
      <ClientStateProvider state={shownState('open')}>
        <ShellDataProvider store={createShellData(clientWith({ me: me({ edition: 'community' }), sources: [], aiStatus: aiStatus(available) }))}>
          <AiActionsProvider value={actions}>
            <BannerProvider controller={createBannerController()}>
              <SlotsProvider registry={slots}>
                <InvestigationIdentity />
              </SlotsProvider>
            </BannerProvider>
          </AiActionsProvider>
        </ShellDataProvider>
      </ClientStateProvider>
    </MemoryRouter>,
  );
}

const itemNames = (): string[] => within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent ?? '');

describe('the AI notes item of the investigation menu', () => {
  it('is offered when the summary is available, in the Community edition too, and runs the handler of the notes', async () => {
    const notes = vi.fn();
    drawMenu({ summary: true }, notes);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Investigation menu' }));
    expect(itemNames().some((name) => name.startsWith('AI notes'))).toBe(true);
    await user.click(screen.getByRole('menuitem', { name: /AI notes/ }));
    expect(notes).toHaveBeenCalledTimes(1);
  });

  it('is not offered when the summary is not available, even when Ask is', async () => {
    drawMenu({ ask: true }, vi.fn());
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Investigation menu' }));
    expect(itemNames().some((name) => name.startsWith('AI notes'))).toBe(false);
  });
});
