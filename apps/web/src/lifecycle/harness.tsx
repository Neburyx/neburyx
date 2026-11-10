import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import type { Investigation, StatusChangeResponse } from '@neburyx/contracts';
import type { ApiClient, ApiFailure, ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { BannerProvider } from '../banner/banner-context.js';
import { createBannerController, type BannerController } from '../banner/banner-controller.js';
import { StatusBanner } from '../banner/status-banner.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { isReadOnlyStatus, type InvestigationStatus } from '../state/investigation-state.js';
import { key, ref, result } from '../state/test-data.js';
import { InvestigationIdentity } from '../workspace/investigation-identity.js';
import { createSlotRegistry, SlotsProvider } from '../workspace/slots.js';
import { ReadOnlyBannerSync } from './read-only-banner.js';
import { registerInvestigationMenu } from './register-menu.js';

export const ID = '0192f000-0000-7000-8000-0000000000a1';

export const investigationOf = (status: InvestigationStatus, version: number, title = 'Suspicious linked accounts'): Investigation => ({
  id: ID,
  sourceId: 'demo',
  title,
  caseRef: null,
  status,
  startingEntity: { entityType: 'type-a', stableId: 'A' },
  sourceState: 'available',
  createdAt: '2026-11-05T10:00:00.000Z',
  lastEditedAt: '2026-11-05T10:00:00.000Z',
  version,
});

export const answerOf = (status: InvestigationStatus, version: number, title?: string): ApiResult<StatusChangeResponse> => ({
  ok: true,
  value: { investigation: { ...investigationOf(status, version, title), closedAt: status === 'closed' ? '2026-11-06T10:00:00.000Z' : null, archivedAt: status === 'archived' ? '2026-11-06T10:00:00.000Z' : null } },
});

export const failure = (code: 'CONFLICT' | 'NOT_FOUND' | 'INTERNAL_ERROR', message: string, details?: { reason: 'investigation-read-only'; status: 'closed' | 'archived' }): ApiFailure => ({ code, message, retryable: false, traceId: 'tr-1', ...(details === undefined ? {} : { details }) }) as ApiFailure;

export function shownState(status: InvestigationStatus, version = 3, title = 'Suspicious linked accounts'): ClientState {
  const state = createClientState();
  state.bindSource('demo');
  const read = result('demo', ['A']);
  state.show({ id: ID, sourceId: 'demo', record: { title, caseRef: null, status, readOnly: isReadOnlyStatus(status), version, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((node) => node.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
  return state;
}

export interface Rendered {
  readonly state: ClientState;
  readonly banner: BannerController;
  readonly client: ApiClient;
}

/** The header identity with the menu slot, the status banner and the read-only sync, over a fake client. */
export function renderLifecycle(state: ClientState, overrides: Partial<ApiClient> = {}, extra?: ReactNode): Rendered {
  const banner = createBannerController();
  const slots = createSlotRegistry();
  const client = fakeClient(overrides);
  registerInvestigationMenu(slots, client);
  render(
    <MemoryRouter>
      <ClientStateProvider state={state}>
        <BannerProvider controller={banner}>
          <SlotsProvider registry={slots}>
            <InvestigationIdentity />
            <StatusBanner />
            <ReadOnlyBannerSync client={client} />
            {extra}
          </SlotsProvider>
        </BannerProvider>
      </ClientStateProvider>
    </MemoryRouter>,
  );
  return { state, banner, client };
}

export const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

export { ref };
