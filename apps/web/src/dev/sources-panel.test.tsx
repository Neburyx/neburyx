import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import type { SourceProfile, SourceSummary } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createShellData, ShellDataProvider, useShellData } from '../shell/shell-data.js';
import { SourcesPanel } from './sources-panel.js';

const SUMMARY = {
  state: 'connected',
  stateReason: null,
  readOnly: true,
  synthetic: true,
  lastTestAt: null,
  lastTest: null,
  mappingSummary: { entityTypes: 2, relationshipTypes: 1, derivedRules: 0 },
  demoCase: null,
} as const;

function source(id: string, overrides: Partial<SourceSummary> = {}): SourceSummary {
  return { id, alias: `Source ${id}`, ...SUMMARY, ...overrides };
}

function profile(sourceId: string, labels: readonly string[]): SourceProfile {
  return {
    sourceId,
    synthetic: true,
    vocabulary: { caseRef: null },
    entityTypes: labels.map((label) => ({ type: label.toLowerCase(), label, displayName: label, icon: 'generic', title: 'name', titleUsesPii: false, keyProperties: [], stateProperty: null, searchable: [], filterable: [], pii: [] })),
    relationshipTypes: [{ type: 'linked', from: labels[0]?.toLowerCase() ?? 'a', to: labels[1]?.toLowerCase() ?? 'b', aggregate: false, observedAt: null, filterable: [], evidence: [] }],
    derivedRules: [],
    presets: [],
    mappingExcerpt: '',
  };
}

function Reloader() {
  const { reload } = useShellData();
  return <button onClick={reload}>Reload</button>;
}

function Panel({ client }: { readonly client: ApiClient }) {
  const [store] = useState(() => createShellData(client));
  return (
    <ShellDataProvider store={store}>
      <Reloader />
      <SourcesPanel client={client} />
    </ShellDataProvider>
  );
}

const list = (...items: SourceSummary[]) => async () => ({ ok: true, value: { items, nextCursor: null } }) as const;

describe('the sources panel', () => {
  it('shows a loading state while the sources are awaited', () => {
    render(<Panel client={fakeClient({ getSources: () => new Promise(() => undefined) })} />);
    expect(screen.getByRole('status').textContent).toBe('Loading the sources');
  });

  it('shows NETWORK_UNAVAILABLE, not an empty page, when the API cannot be reached', async () => {
    render(<Panel client={fakeClient()} />);
    expect((await screen.findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
  });

  it('shows a failure of a later read beside the list it already has', async () => {
    let calls = 0;
    const client = fakeClient({
      getSources: async () => {
        calls += 1;
        return calls === 1 ? { ok: true, value: { items: [source('a')], nextCursor: null } } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
      },
    });
    render(<Panel client={client} />);
    await screen.findByRole('button', { name: 'Source a' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect((await screen.findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(screen.getByRole('button', { name: 'Source a' })).toBeTruthy();
  });

  it('shows a failure of a later read beside an empty list', async () => {
    let calls = 0;
    const client = fakeClient({
      getSources: async () => {
        calls += 1;
        return calls === 1 ? { ok: true, value: { items: [], nextCursor: null } } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
      },
    });
    render(<Panel client={client} />);
    await screen.findByText('No sources are configured.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect((await screen.findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(screen.getByText('No sources are configured.')).toBeTruthy();
  });

  it('says that no sources are configured for an empty list', async () => {
    render(<Panel client={fakeClient({ getSources: list() })} />);
    expect(await screen.findByText('No sources are configured.')).toBeTruthy();
  });

  it('lists each source with its state, the reason for an unavailable one, and the synthetic flag', async () => {
    render(<Panel client={fakeClient({ getSources: list(source('a'), source('b', { state: 'unavailable', stateReason: 'TLS handshake failed', synthetic: false })) })} />);
    const items = await screen.findAllByRole('listitem');
    expect(items[0]?.textContent).toBe('Source a connected · synthetic');
    expect(items[1]?.textContent).toBe('Source b unavailable · TLS handshake failed');
  });

  it('reads and summarizes the profile of the chosen source, which carries that source\'s own type names', async () => {
    const client = fakeClient({
      getSources: list(source('a'), source('b')),
      getProfile: async (id) => ({ ok: true, value: id === 'a' ? profile('a', ['Alpha', 'Beta']) : profile('b', ['Gamma', 'Delta', 'Epsilon']) }),
    });
    render(<Panel client={client} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Source a' }));
    expect(await screen.findByText('2 entity types · 1 relationship types')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Source b' }));
    expect(await screen.findByText('3 entity types · 1 relationship types')).toBeTruthy();
    expect(screen.getByText('Gamma')).toBeTruthy();
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('never shows the profile of one source under another while the second answer is awaited', async () => {
    const client = fakeClient({
      getSources: list(source('a'), source('b')),
      getProfile: (id) => (id === 'a' ? Promise.resolve({ ok: true, value: profile('a', ['Alpha', 'Beta']) }) : new Promise(() => undefined)),
    });
    render(<Panel client={client} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Source a' }));
    await screen.findByText('Alpha');
    await user.click(screen.getByRole('button', { name: 'Source b' }));
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.getByText('Loading the profile')).toBeTruthy();
  });

  it('keeps the list on screen and shows the failure beside it when the profile cannot be read', async () => {
    render(<Panel client={fakeClient({ getSources: list(source('a')) })} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Source a' }));
    expect((await screen.findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(screen.getByRole('button', { name: 'Source a' })).toBeTruthy();
  });
});
