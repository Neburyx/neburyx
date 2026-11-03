import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SourceSummary } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../api/fake-client.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { FixturePage } from './fixture-page.js';
import { testProfile } from './test-profile.js';

const ME = { principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' as const }, edition: 'community' as const, identityMode: 'none' as const, sources: [] };
const SOURCE: SourceSummary = { id: 'source-a', alias: 'Source a', state: 'connected', stateReason: null, readOnly: true, synthetic: true, lastTestAt: null, mappingSummary: { entityTypes: 3, relationshipTypes: 2, derivedRules: 1 } };

function renderPage(profile = testProfile()) {
  const client = fakeClient({
    getMe: async () => ({ ok: true, value: ME }),
    getSources: async () => ({ ok: true, value: { items: [SOURCE], nextCursor: null } }),
    getProfile: async () => ({ ok: true, value: profile }),
  });
  render(
    <ClientStateProvider state={createClientState()}>
      <FixturePage client={client} />
    </ClientStateProvider>,
  );
}

describe('the fixture page', () => {
  it('shows why Load is unavailable when the principal cannot be read', async () => {
    const client = fakeClient({
      getSources: async () => ({ ok: true, value: { items: [SOURCE], nextCursor: null } }),
      getProfile: async () => ({ ok: true, value: testProfile() }),
    });
    render(
      <ClientStateProvider state={createClientState()}>
        <FixturePage client={client} />
      </ClientStateProvider>,
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Source a' }));
    expect((await screen.findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(true);
  });

  it('loads a graph from the chosen source and says how many entities and relationships were loaded, exact', async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Source a' }));
    const load = await screen.findByRole('button', { name: 'Load' });
    await screen.findByText('0 entities · 0 relationships · loaded · exact');
    await user.click(load);
    expect(await screen.findByText('120 entities · 180 relationships · loaded · exact')).toBeTruthy();
    expect(screen.getByText('10 pinned')).toBeTruthy();
  });

  it('says why a profile is refused and keeps what was shown', async () => {
    renderPage({ ...testProfile(), relationshipTypes: [] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Source a' }));
    await user.click(await screen.findByRole('button', { name: 'Load' }));
    expect((await screen.findByRole('alert')).textContent).toBe('NO_RELATIONSHIP_TYPES');
    expect(screen.getByText('0 entities · 0 relationships · loaded · exact')).toBeTruthy();
  });
});
