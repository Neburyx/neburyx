import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceProfile } from '@neburyx/contracts';
import { ProfileProvider } from '../canvas/profile-context.js';
import { entityOf, keyOf, linkOf, loadedState, profileWith, at } from '../groups/group-kit.js';
import { ClientStateProvider } from '../state/context.js';
import type { ClientState } from '../state/client-state.js';
import { setMaskKeepingView } from '../state/test-data.js';
import { staticProfile } from '../test-utils.js';
import { GroupPanel } from './group-panel.js';

afterEach(cleanup);

const profile = profileWith({ 'kind-a': { name: 'Kind A', properties: ['currency', 'holder'], pii: ['holder'] }, 'kind-d': { name: 'Kind D', properties: ['model'] }, 'kind-l': { name: 'Kind L' }, 'kind-c': { name: 'Kind C' }, 'kind-r': { name: 'Kind R' }, 'kind-p': { name: 'Kind P' } });

function show(state: ClientState, withProfile: SourceProfile | null = profile) {
  const user = userEvent.setup();
  render(
    <ClientStateProvider state={state}>
      <ProfileProvider store={staticProfile('a', withProfile ?? undefined)}>
        <GroupPanel />
      </ProfileProvider>
    </ClientStateProvider>,
  );
  return { user, panel: within(screen.getByRole('heading', { name: 'Group loaded nodes' }).parentElement ?? document.body) };
}

const rowText = (name: string, count: number): string => `${name}${count} loaded`;
const entities = [entityOf('kind-d', 'DV1', { model: 'm1' }), entityOf('kind-d', 'DV2', { model: 'm1' }), entityOf('kind-a', 'A1', { currency: 'USD', holder: 'Ana' }), entityOf('kind-a', 'A2', { currency: 'EUR', holder: 'Ana' }), entityOf('kind-l', 'C1'), entityOf('kind-c', 'U1'), entityOf('kind-r', 'AD1'), entityOf('kind-p', 'P1')];

describe('the Group panel', () => {
  it('shows the frame\'s text, the choice of how to group, no groups yet, and the buttons off, and sends nothing', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const { panel } = show(loadedState(entities));
    expect(panel.getByText('Rearranges what is loaded. Nothing new is fetched.')).toBeTruthy();
    expect(panel.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Entity type', 'Property', 'Component']);
    expect(panel.getByText('GROUPS · 8 LOADED ITEMS')).toBeTruthy();
    expect(panel.getByText('No groups yet. Choose how to group.')).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Ungroup all' })).toHaveProperty('disabled', true);
    expect(panel.getByRole('button', { name: 'Collapse all' })).toHaveProperty('disabled', true);
    expect(panel.getByText('Counts are loaded items, not source totals. Groups are saved with the view.')).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });

  it('says nothing is loaded and offers no choice when nothing is loaded', () => {
    const { panel } = show(loadedState([]));
    expect(panel.getAllByText('Nothing is loaded to group.')).toHaveLength(1);
    for (const radio of panel.getAllByRole('radio')) expect(radio).toHaveProperty('disabled', true);
  });

  it('applies Entity type at once with one group for each type, none collapsed, lists them largest first with "n loaded", folds past four into Other types, and expands that row', async () => {
    const state = loadedState(entities);
    const { user, panel } = show(state);
    await user.click(panel.getByRole('radio', { name: 'Entity type' }));
    expect(state.presentation.view.getState().groups).toHaveLength(6);
    expect(state.presentation.view.getState().groups.every((group) => !group.collapsed)).toBe(true);
    const rows = panel.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows).toEqual([rowText('Kind A', 2), rowText('Kind D', 2), rowText('Kind C', 1), rowText('Kind L', 1), rowText('Other types', 2)]);
    expect(panel.queryByText('Kind P')).toBeNull();
    await user.click(panel.getByRole('button', { name: 'Show the other types' }));
    expect(panel.getAllByRole('listitem').map((row) => row.textContent).slice(5)).toEqual(['Kind P1 loaded', 'Kind R1 loaded']);
  });

  it('expands and collapses a group by its chevron, collapses all, and ungroups all', async () => {
    const state = loadedState(entities.slice(0, 4));
    const { user, panel } = show(state);
    await user.click(panel.getByRole('radio', { name: 'Entity type' }));
    expect(state.presentation.view.getState().groups.some((group) => group.collapsed)).toBe(false);
    const chevron = panel.getByRole('button', { name: 'Collapse Kind A' });
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    await user.click(chevron);
    expect(state.presentation.view.getState().groups.find((group) => group.id === 'type:kind-a')?.collapsed).toBe(true);
    expect(panel.getByRole('button', { name: 'Expand Kind A' }).getAttribute('aria-expanded')).toBe('false');
    await user.click(panel.getByRole('button', { name: 'Collapse all' }));
    expect(state.presentation.view.getState().groups.every((group) => group.collapsed)).toBe(true);
    await user.click(panel.getByRole('button', { name: 'Ungroup all' }));
    expect(state.presentation.view.getState().groups).toEqual([]);
    expect(panel.getByText('No groups yet. Choose how to group.')).toBeTruthy();
  });

  it('replaces the groups when another choice is made, never adds to them', async () => {
    const state = loadedState(entities, [linkOf('L1', at(entities, 0), at(entities, 2))]);
    const { user, panel } = show(state);
    await user.click(panel.getByRole('radio', { name: 'Entity type' }));
    await user.click(panel.getByRole('radio', { name: 'Component' }));
    expect(state.presentation.view.getState().groups.map((group) => group.by)).toEqual(['component']);
    expect(panel.getByText('6 loaded items have no relationship.')).toBeTruthy();
    await user.click(panel.getByRole('radio', { name: 'Entity type' }));
    expect(state.presentation.view.getState().groups.every((group) => group.by === 'entityType')).toBe(true);
  });

  it('offers the mapped properties of the types in the view, and groups by the one chosen', async () => {
    const state = loadedState(entities);
    const { user, panel } = show(state);
    await user.click(panel.getByRole('radio', { name: 'Property' }));
    expect(panel.getAllByRole('radio', { name: /^(currency|holder|model)$/ }).map((radio) => radio.textContent)).toEqual(['currency', 'holder', 'model']);
    await user.click(panel.getByRole('radio', { name: 'currency' }));
    expect(state.presentation.view.getState().groups.map((group) => group.by)).toEqual(['property:currency', 'property:currency']);
    expect(panel.getByText('6 loaded items have no value.')).toBeTruthy();
  });

  it('does not offer a property marked pii once masking is on', async () => {
    const state = loadedState(entities);
    setMaskKeepingView(state, true);
    const { user, panel } = show(state);
    await user.click(panel.getByRole('radio', { name: 'Property' }));
    expect(panel.queryByRole('radio', { name: 'holder' })).toBeNull();
    expect(panel.getByRole('radio', { name: 'currency' })).toBeTruthy();
  });

  it('disables Property while the mapping is not known', () => {
    const { panel } = show(loadedState(entities), null);
    expect(panel.getByRole('radio', { name: 'Property' })).toHaveProperty('disabled', true);
  });

  it('closes with Escape, closes its state and gives the focus back to the tool', async () => {
    const state = loadedState(entities);
    state.presentation.setGroupOpen(true);
    const strip = document.createElement('div');
    strip.className = 'tool-strip';
    strip.innerHTML = '<button type="button" aria-label="Group loaded nodes"></button>';
    document.body.append(strip);
    const { user } = show(state);
    await user.keyboard('{Escape}');
    expect(state.presentation.view.getState().groupOpen).toBe(false);
    expect(document.activeElement).toBe(strip.querySelector('button'));
    strip.remove();
  });

  it('has a close button that closes the state and gives the focus back to the tool', async () => {
    const state = loadedState(entities);
    state.presentation.setGroupOpen(true);
    const strip = document.createElement('div');
    strip.className = 'tool-strip';
    strip.innerHTML = '<button type="button" aria-label="Group loaded nodes"></button>';
    document.body.append(strip);
    const { user, panel } = show(state);
    await user.click(panel.getByRole('button', { name: 'Close Group' }));
    expect(state.presentation.view.getState().groupOpen).toBe(false);
    expect(document.activeElement).toBe(strip.querySelector('button'));
    strip.remove();
  });

  it('puts the focus on the choice when it opens, and moves the choice with the arrow keys, applying it', async () => {
    const state = loadedState(entities, [linkOf('L1', at(entities, 0), at(entities, 2))]);
    const { user, panel } = show(state);
    expect(document.activeElement).toBe(panel.getByRole('radio', { name: 'Entity type' }));
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(panel.getByRole('radio', { name: 'Component' }).getAttribute('aria-checked')).toBe('true');
    expect(state.presentation.view.getState().groups[0]?.by).toBe('component');
  });

  it('keeps the row of a group whose members are all hidden', async () => {
    const state = loadedState(entities.slice(0, 2));
    state.hide([keyOf(at(entities, 0)), keyOf(at(entities, 1))]);
    const { user, panel } = show(state);
    await user.click(panel.getByRole('radio', { name: 'Entity type' }));
    expect(panel.getAllByRole('listitem').map((row) => row.textContent)).toEqual([rowText('Kind D', 2)]);
  });
});
