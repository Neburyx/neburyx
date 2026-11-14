import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createShellData, ShellDataProvider } from '../shell/shell-data.js';
import { clientWith, me } from '../test-utils.js';
import { createSlotRegistry, Slot, SlotsProvider } from '../workspace/slots.js';
import { AiActionsProvider, createAiActions } from './ai-actions.js';
import { registerAiControls } from './register-ai-controls.js';

afterEach(cleanup);

describe('the AI controls of the header', () => {
  it('put Summarize in its slot and no Ask control in either edition, whatever the AI status says', async () => {
    for (const edition of ['community', 'enterprise'] as const) {
      const slots = createSlotRegistry();
      const remove = registerAiControls(slots);
      render(
        <ShellDataProvider store={createShellData(clientWith({ me: me({ edition }), sources: [] }))}>
          <AiActionsProvider value={createAiActions()}>
            <SlotsProvider registry={slots}>
              <Slot name="ask" />
              <Slot name="summarize" />
            </SlotsProvider>
          </AiActionsProvider>
        </ShellDataProvider>,
      );
      expect(await screen.findByRole('button', { name: /^Summarize/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Ask/ })).toBeNull();
      remove();
      cleanup();
    }
  });

  it('take Summarize out again when the function returned is called', () => {
    const slots = createSlotRegistry();
    registerAiControls(slots)();
    expect(slots.view.getState().has('summarize')).toBe(false);
  });
});
