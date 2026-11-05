import type { IconKey, SourceProfile } from '@neburyx/contracts';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { glyphUri } from '../canvas/glyphs.js';
import { GLYPH_COLOR } from '../canvas/look.js';
import { createProfileStore, type ProfileState, type ProfileStore } from '../canvas/profile-store.js';
import { ProfileProvider } from '../canvas/profile-context.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { createStore, readable } from '../state/store.js';
import { clientWith, me, renderApp, source, staticProfile } from '../test-utils.js';
import { LegendPanel, legendGlyph } from './legend-panel.js';

function renderPanel(profile: SourceProfile | undefined, state: ClientState = createClientState()) {
  state.bindSource('s');
  return render(
    <ClientStateProvider state={state}>
      <ProfileProvider store={staticProfile('s', profile)}>
        <LegendPanel />
      </ProfileProvider>
    </ClientStateProvider>,
  );
}

const names = (types: number): string[] => Array.from({ length: types }, (_, index) => `kind-${index}`);
const entries = (container: HTMLElement) => [...container.querySelectorAll('.legend-type')];

describe('the legend\'s entity types', () => {
  it('are headed ENTITY TYPES under the panel\'s heading', () => {
    renderPanel(testProfile('s'));
    expect(screen.getByRole('heading', { name: 'Legend' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'ENTITY TYPES' })).toBeTruthy();
  });

  it.each([1, 8, 20])('list exactly the %i types of the profile, in its order, by label, none dropped, merged or reordered', (count) => {
    const { container } = renderPanel(testProfile('s', names(count)));
    expect(entries(container).map((entry) => entry.textContent)).toEqual(names(count).map((name) => name.toUpperCase()));
  });

  it('draw each type\'s glyph by its icon key as the canvas draws it, in a circle with the frame\'s outline, and the generic one for an unknown key', () => {
    const base = testProfile('s', ['kind-a', 'kind-b']);
    const icons: readonly IconKey[] = ['person', 'terminal'];
    const profile: SourceProfile = { ...base, entityTypes: base.entityTypes.map((type, index) => ({ ...type, icon: icons[index] ?? 'generic' })) };
    const { container } = renderPanel(profile);
    const sources = [...container.querySelectorAll('.legend-type img')].map((image) => image.getAttribute('src'));
    expect(sources).toEqual([glyphUri('person', GLYPH_COLOR), glyphUri('terminal', GLYPH_COLOR)]);
    expect(container.querySelector('.legend-swatch')?.className).toBe('legend-swatch');
    expect(legendGlyph('not-an-icon')).toBe(glyphUri('generic', GLYPH_COLOR));
    expect(legendGlyph('person')).toBe(glyphUri('person', GLYPH_COLOR));
  });

  it('list nothing before a profile is read, and put the glyph images out of the accessibility tree', () => {
    const { container } = renderPanel(undefined);
    expect(entries(container)).toEqual([]);
    const withTypes = renderPanel(testProfile('s', names(2)));
    for (const image of withTypes.container.querySelectorAll('.legend-type img')) expect(image.getAttribute('alt')).toBe('');
  });
});

describe('the legend\'s entity types while the profile is read', () => {
  function controlled(sourceId: string | null, initial: ProfileState['request']) {
    const store = createStore<ProfileState>({ sourceId, request: initial });
    const profile: ProfileStore = { ...readable(store), reload: () => undefined };
    const state = createClientState();
    if (sourceId !== null) state.bindSource(sourceId);
    const view = render(
      <ClientStateProvider state={state}>
        <ProfileProvider store={profile}>
          <LegendPanel />
        </ProfileProvider>
      </ClientStateProvider>,
    );
    const set = (request: ProfileState['request']): void => act(() => store.setState({ sourceId, request }));
    return { ...view, set, store };
  }

  const status = () => screen.queryByRole('status');
  const alert = () => screen.queryByRole('alert');
  const rows = (container: HTMLElement) => entries(container).map((entry) => entry.textContent);
  const types = (list: readonly string[]) => testProfile('s', list);

  it.each([
    ['no source is bound', null, { phase: 'idle' as const }],
    ['the profile request is idle', 's', { phase: 'idle' as const }],
    ['the profile is loading with no data', 's', { phase: 'loading' as const }],
  ])('shows a polite status "Loading entity types…", no alert and no entries, when %s, with the relationships section as always', (_name, source, request) => {
    const { container } = controlled(source, request);
    expect(status()?.textContent).toBe('Loading entity types…');
    expect(alert()).toBeNull();
    expect(entries(container)).toEqual([]);
    expect(container.querySelectorAll('.legend-relationship')).toHaveLength(4);
  });

  it('replaces the loading line with the entries when the profile arrives', () => {
    const { container, set } = controlled('s', { phase: 'loading' });
    set({ phase: 'ready', data: types(['kind-a', 'kind-b']) });
    expect(status()).toBeNull();
    expect(rows(container)).toEqual(['KIND-A', 'KIND-B']);
  });

  it('shows the failure\'s code in an alert, with no retry control, when the first read failed, and the entries replace it when they arrive', () => {
    const { container, set } = controlled('s', { phase: 'failed', failure: { code: 'NETWORK_UNAVAILABLE' } });
    expect(alert()?.textContent).toBe('NETWORK_UNAVAILABLE');
    expect(status()).toBeNull();
    expect(screen.queryAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Close Legend']);
    set({ phase: 'ready', data: types(['kind-a']) });
    expect(alert()).toBeNull();
    expect(rows(container)).toEqual(['KIND-A']);
  });

  it('keeps the entries on screen while the profile is read again, and replaces them with the new list when the read succeeds', () => {
    const { container, set } = controlled('s', { phase: 'ready', data: types(['kind-a', 'kind-b']) });
    set({ phase: 'loading', data: types(['kind-a', 'kind-b']) });
    expect(status()).toBeNull();
    expect(rows(container)).toEqual(['KIND-A', 'KIND-B']);
    set({ phase: 'ready', data: types(['kind-c']) });
    expect(rows(container)).toEqual(['KIND-C']);
  });

  it('keeps the entries when a read of the profile fails, with the failure\'s code shown beside them in an alert', () => {
    const { container, set } = controlled('s', { phase: 'ready', data: types(['kind-a', 'kind-b']) });
    set({ phase: 'loading', data: types(['kind-a', 'kind-b']) });
    set({ phase: 'ready', data: types(['kind-a', 'kind-b']), failure: { code: 'SOURCE_UNAVAILABLE', message: 'unavailable', retryable: true, traceId: 'trace-1' } });
    expect(alert()?.textContent).toBe('SOURCE_UNAVAILABLE · trace trace-1');
    expect(rows(container)).toEqual(['KIND-A', 'KIND-B']);
    set({ phase: 'ready', data: types(['kind-a', 'kind-b']) });
    expect(alert()).toBeNull();
  });

  it('keeps the entries and shows no error when the read is cancelled', () => {
    const { container, set } = controlled('s', { phase: 'ready', data: types(['kind-a']) });
    set({ phase: 'loading', data: types(['kind-a']) });
    set({ phase: 'ready', data: types(['kind-a']) });
    expect(alert()).toBeNull();
    expect(status()).toBeNull();
    expect(rows(container)).toEqual(['KIND-A']);
  });

  it('shows "No entity types in this source" for a profile with none, and leaves the relationships section as it is', () => {
    const { container } = controlled('s', { phase: 'ready', data: { ...testProfile('s'), entityTypes: [] } });
    expect(screen.getByText('No entity types in this source')).toBeTruthy();
    expect(status()).toBeNull();
    expect(container.querySelectorAll('.legend-relationship')).toHaveLength(4);
  });

  it('lists 40 entity types, all of them, and two types with the same label, both', () => {
    const forty = controlled('s', { phase: 'ready', data: types(Array.from({ length: 40 }, (_unused, index) => `kind-${index}`)) });
    expect(entries(forty.container)).toHaveLength(40);
    forty.unmount();
    const base = types(['kind-a', 'kind-b']);
    const same: SourceProfile = { ...base, entityTypes: base.entityTypes.map((type) => ({ ...type, label: 'SAME' })) };
    const twice = controlled('s', { phase: 'ready', data: same });
    expect(rows(twice.container)).toEqual(['SAME', 'SAME']);
  });

  it('puts a very long label in the entry as it is, for the stylesheet to wrap', () => {
    const base = types(['kind-a']);
    const long = 'W'.repeat(60);
    const { container } = controlled('s', { phase: 'ready', data: { ...base, entityTypes: base.entityTypes.map((type) => ({ ...type, label: long })) } });
    expect(rows(container)).toEqual([long]);
  });
});

describe('the legend\'s relationship styles', () => {
  const rows = (container: HTMLElement) => [...container.querySelectorAll('.legend-relationship')];

  it('are headed RELATIONSHIPS after a divider, in four rows in the frame\'s order, in the UI\'s words', () => {
    const { container } = renderPanel(testProfile('s'));
    expect(screen.getByRole('heading', { name: 'RELATIONSHIPS' })).toBeTruthy();
    const label = screen.getByRole('heading', { name: 'RELATIONSHIPS' });
    expect(label.previousElementSibling?.className).toBe('legend-divider');
    expect(rows(container).map((row) => row.textContent)).toEqual(['Sourced, stored in your graph', 'Rule-derived, not a source relationship', 'Aggregate: many source relationships as one, with a count', 'Arrow shows stored direction']);
    expect(rows(container).map((row) => row.querySelector('svg')?.getAttribute('data-kind'))).toEqual(['sourced', 'derived', 'aggregate', 'direction']);
  });

  it('show whatever the profile holds: with no entity types, with no relationship types, and before any profile is read', () => {
    const base = testProfile('s');
    for (const profile of [{ ...base, entityTypes: [] }, { ...base, relationshipTypes: [], derivedRules: [] }, undefined]) {
      const { container, unmount } = renderPanel(profile);
      expect(rows(container)).toHaveLength(4);
      unmount();
    }
  });

  it('use only words the UI allows: "relationship" and never "edge"', () => {
    const { container } = renderPanel(testProfile('s'));
    expect(container.textContent?.toLowerCase().includes('edge')).toBe(false);
  });

  it('leave the glyphs and samples to the labels: the samples carry no name', () => {
    const { container } = renderPanel(testProfile('s'));
    for (const sample of container.querySelectorAll('.legend-relationship svg')) {
      expect(sample.getAttribute('aria-hidden')).toBe('true');
      expect(sample.getAttribute('aria-label')).toBeNull();
    }
  });
});

describe('the legend when the source changes', () => {
  function stores() {
    const replies = new Map<string, Array<(result: ApiResult<SourceProfile>) => void>>();
    const asked: string[] = [];
    const client = fakeClient({
      getProfile: (sourceId) => {
        asked.push(sourceId);
        return new Promise((resolve) => replies.set(sourceId, [...(replies.get(sourceId) ?? []), resolve]));
      },
    });
    const state = createClientState();
    const profile = createProfileStore(client, state.investigation);
    return { state, profile, replies, asked };
  }

  function panel(state: ClientState, profile: ReturnType<typeof createProfileStore>) {
    return render(
      <ClientStateProvider state={state}>
        <ProfileProvider store={profile}>
          <LegendPanel />
        </ProfileProvider>
      </ClientStateProvider>,
    );
  }

  it.each([
    ['success', { ok: true, value: testProfile('a', ['stale']) }],
    ['failure', { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }],
  ] as const)('lists no types of the source that was left when its %s arrives late, shows no failure for it, and then lists the new source\'s', async (_name, late) => {
    const { state, profile, replies, asked } = stores();
    state.bindSource('a');
    const { container } = panel(state, profile);
    expect(asked).toEqual(['a']);
    act(() => state.bindSource('b'));
    expect(entries(container)).toEqual([]);
    await act(async () => replies.get('a')?.[0]?.(late));
    expect(entries(container)).toEqual([]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => replies.get('b')?.[0]?.({ ok: true, value: testProfile('b', ['new-1']) }));
    expect(entries(container).map((entry) => entry.textContent)).toEqual(['NEW-1']);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('lists the types of the source that was left while it is bound, and none of them once another source is bound', async () => {
    const { state, profile, replies } = stores();
    state.bindSource('a');
    const { container } = panel(state, profile);
    await act(async () => replies.get('a')?.[0]?.({ ok: true, value: testProfile('a', ['old-1', 'old-2']) }));
    expect(entries(container).map((entry) => entry.textContent)).toEqual(['OLD-1', 'OLD-2']);
    act(() => state.bindSource('b'));
    expect(entries(container)).toEqual([]);
  });

  it('does not read the profile again because the legend is opened and closed', async () => {
    const calls = { profile: 0 };
    const client = fakeClient({ ...clientWith({ me: me(), sources: [source('a')] }), getProfile: async (sourceId) => { calls.profile += 1; return { ok: true, value: testProfile(sourceId, ['kind-a']) }; } });
    const state = createClientState();
    state.bindSource('a');
    const { container } = renderApp('/explore', client, state);
    await act(async () => void (await Promise.resolve()));
    const before = calls.profile;
    for (let round = 0; round < 3; round += 1) {
      act(() => state.presentation.setLegendOpen(true));
      expect(container.querySelector('.legend-panel')).not.toBeNull();
      act(() => state.presentation.setLegendOpen(false));
    }
    expect(calls.profile).toBe(before);
  });
});
