import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ApiClient } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { BannerProvider } from '../banner/banner-context.js';
import { createBannerController } from '../banner/banner-controller.js';
import { StatusBanner } from '../banner/status-banner.js';
import { shownState } from '../lifecycle/harness.js';
import type { ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { createSlotRegistry, Slot, SlotsProvider } from '../workspace/slots.js';
import { registerExport } from './register-export.js';

export { shownState };

/** The header with its Export slot and the banner, over a fake client. */
export function renderExport(state: ClientState, overrides: Partial<ApiClient> = {}) {
  const banner = createBannerController();
  const slots = createSlotRegistry();
  const client = fakeClient(overrides);
  registerExport(slots, client);
  render(
    <MemoryRouter>
      <ClientStateProvider state={state}>
        <BannerProvider controller={banner}>
          <SlotsProvider registry={slots}>
            <Slot name="export" />
            <StatusBanner />
          </SlotsProvider>
        </BannerProvider>
      </ClientStateProvider>
    </MemoryRouter>,
  );
  return { state, banner, client };
}

