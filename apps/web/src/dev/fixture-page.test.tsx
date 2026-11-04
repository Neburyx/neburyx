import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SourceSummary } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../api/fake-client.js';
import { counted, renderApp } from '../test-utils.js';
import { testProfile } from './test-profile.js';

const ME = { principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' as const }, edition: 'community' as const, identityMode: 'none' as const, sources: [] };
const SOURCE: SourceSummary = { id: 'source-a', alias: 'Source a', state: 'connected', stateReason: null, readOnly: true, synthetic: true, lastTestAt: null, lastTest: null, mappingSummary: { entityTypes: 3, relationshipTypes: 2, derivedRules: 1 } };

function clientFor(profile = testProfile()) {
  return fakeClient({
    getMe: async () => ({ ok: true, value: ME }),
    getSources: async () => ({ ok: true, value: { items: [SOURCE], nextCursor: null } }),
    getProfile: async () => ({ ok: true, value: profile }),
  });
}

function renderPage(profile = testProfile()) {
  return renderApp('/dev/fixture', clientFor(profile));
}

describe('the fixture page', () => {
  it('shows why Load is unavailable when the principal cannot be read', async () => {
    renderApp('/dev/fixture', fakeClient({
      getSources: async () => ({ ok: true, value: { items: [SOURCE], nextCursor: null } }),
      getProfile: async () => ({ ok: true, value: testProfile() }),
    }));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Source a' }));
    expect((await screen.findAllByText('NETWORK_UNAVAILABLE')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(true);
  });

  it('starts with the shared page heading: the title, the source in view, the Synthetic data badge and a description', async () => {
    renderPage();
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Fixture graph');
    expect(await screen.findByText('Synthetic data')).toBeTruthy();
    expect(document.querySelector('.page-heading > p')?.textContent?.length).toBeGreaterThan(0);
  });

  it('reuses the shell\'s answers: choosing a source and a profile asks for the principal and the sources no more than once', async () => {
    const { client, calls } = counted(clientFor());
    renderApp('/dev/fixture', client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Source a' }));
    await user.click(await screen.findByRole('button', { name: 'Load' }));
    await screen.findByText('120 entities · 180 relationships · loaded · exact');
    expect(calls).toEqual({ me: 1, sources: 1 });
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

  it('loads again after a visit to Explore and back, taking out the controls the first load put on the canvas and putting them in once', async () => {
    const { router, slots } = renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Source a' }));
    await user.click(await screen.findByRole('button', { name: 'Load' }));
    await user.click(await screen.findByRole('link', { name: 'Open Explore' }));
    await screen.findByRole('img', { name: 'Graph canvas' });
    expect(slots.view.getState().has('floating')).toBe(true);
    await act(() => router.navigate('/dev/fixture'));
    await user.click(await screen.findByRole('button', { name: 'Source a' }));
    await user.click(await screen.findByRole('button', { name: 'Load' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(await screen.findByRole('link', { name: 'Open Explore' }));
    await screen.findByRole('img', { name: 'Graph canvas' });
    expect(screen.getAllByRole('button', { name: 'Add 25 entities' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Displace 10 entities' })).toHaveLength(1);
  });

  it('says why a profile is refused and keeps what was shown', async () => {
    renderPage({ ...testProfile(), relationshipTypes: [] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Source a' }));
    await user.click(await screen.findByRole('button', { name: 'Load' }));
    expect((await screen.findByRole('alert')).textContent).toBe('NO_RELATIONSHIP_TYPES');
    expect(screen.getByText('0 entities · 0 relationships · loaded · exact')).toBeTruthy();
  });

  it('opens Explore from a link after loading, with the loaded graph, the synthetic record and the stand-ins kept', async () => {
    const { router } = renderPage();
    const user = userEvent.setup();
    expect(screen.queryByRole('link', { name: 'Open Explore' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Source a' }));
    await user.click(await screen.findByRole('button', { name: 'Load' }));
    await user.click(await screen.findByRole('link', { name: 'Open Explore' }));
    expect(router.state.location.pathname).toBe('/explore');
    const scope = await screen.findByRole('group', { name: 'Graph scope' });
    expect(scope.textContent).toContain('120 entities · 180 relationships · loaded · exact');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Suspicious linked accounts');
    expect(screen.getByRole('link', { name: 'Search' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask, locked' })).toBeTruthy();
  });
});
