import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TemplateListResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../api/client.js';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { CONNECTED, failure, listOf, PRESETS, SHARED_ADDRESSES } from '../patterns/patterns-kit.js';
import { createClientState } from '../state/client-state.js';
import { renderApp, source } from '../test-utils.js';

afterEach(() => cleanup());

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:05:00.000Z' }), node: nodeOf('source-a', 'kind-a', 'A-1') };

type Answer = (sourceId: string) => ApiResult<TemplateListResponse> | Promise<ApiResult<TemplateListResponse>>;

function home(sources: readonly string[], answer: Answer, extra: Partial<ApiClient> = {}) {
  const asked: string[] = [];
  const parts = knowing([A], {
    getSources: async () => ({ ok: true, value: { items: sources.map((id) => source(id)), nextCursor: null } }),
    listTemplates: async (sourceId) => (asked.push(sourceId), answer(sourceId)),
    ...extra,
  });
  return { ...parts, asked };
}

const card = () => screen.queryByRole('region', { name: 'Start from a pattern' });
const runButtons = () => within(card() as HTMLElement).queryAllByRole('button', { name: /^Run / });

describe('Home: the Start from a pattern card', () => {
  it('lists the presets of the only source in the order of the list, each with Run →, and sends the source ID alone', async () => {
    const parts = home(['source-a'], () => ({ ok: true, value: listOf() }));
    renderApp('/', parts.client);
    await screen.findByRole('button', { name: 'Run Shared devices' });
    expect(runButtons().map((button) => button.getAttribute('aria-label'))).toEqual(PRESETS.map((preset) => `Run ${preset.name}`));
    expect(within(card() as HTMLElement).getAllByRole('listitem').map((item) => item.textContent)).toEqual(PRESETS.map((preset) => `${preset.name}Run →`));
    expect(parts.asked).toEqual(['source-a']);
    expect(card()?.querySelector('input, textarea')).toBeNull();
  });

  it('shows the empty line and no Run control for a source with no preset', async () => {
    renderApp('/', home(['source-a'], () => ({ ok: true, value: listOf([]) })).client);
    expect(await within(await screen.findByRole('region', { name: 'Start from a pattern' })).findByText('This source has no patterns.')).toBeTruthy();
    expect(runButtons()).toEqual([]);
  });

  it('says it is loading while the list is read, with no preset and no empty line', async () => {
    renderApp('/', home(['source-a'], () => new Promise(() => undefined)).client);
    expect((await within(await screen.findByRole('region', { name: 'Start from a pattern' })).findByRole('status')).textContent).toBe('Loading patterns…');
    expect(runButtons()).toEqual([]);
    expect(within(card() as HTMLElement).queryByText('This source has no patterns.')).toBeNull();
  });

  it('asks for a source when there are several and none is bound, reads nothing until one is chosen, then lists its presets and replaces them when another is chosen', async () => {
    const parts = home(['source-a', 'source-b'], (id) => ({ ok: true, value: listOf(id === 'source-a' ? PRESETS : [SHARED_ADDRESSES, CONNECTED]) }));
    renderApp('/', parts.client);
    const chooser = await screen.findByRole('combobox', { name: 'Patterns for' });
    expect((chooser as HTMLSelectElement).value).toBe('');
    expect([...(chooser as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['Choose a source', 'Source source-a', 'Source source-b']);
    expect(runButtons()).toEqual([]);
    expect(parts.asked).toEqual([]);
    const user = userEvent.setup();
    await user.selectOptions(chooser, 'source-a');
    await screen.findByRole('button', { name: 'Run Shared devices' });
    expect(runButtons()).toHaveLength(3);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Patterns for' }), 'source-b');
    await waitFor(() => expect(runButtons().map((button) => button.getAttribute('aria-label'))).toEqual(['Run Shared addresses', 'Run Connected accounts']));
    expect(parts.asked).toEqual(['source-a', 'source-b']);
  });

  it('uses the source bound to the investigation when there are several, with no chooser', async () => {
    const state = createClientState();
    state.bindSource('source-b');
    state.setLoaded([], [{ sourceId: 'source-b', entityType: 'kind-a', stableId: 'item-b' }], []);
    const parts = home(['source-a', 'source-b'], () => ({ ok: true, value: listOf() }));
    renderApp('/', parts.client, state);
    await screen.findByRole('button', { name: 'Run Shared devices' });
    expect(parts.asked).toEqual(['source-b']);
    expect(screen.queryByRole('combobox', { name: 'Patterns for' })).toBeNull();
  });

  it('says the bound source is not configured, lists nothing and offers no Run', async () => {
    const state = createClientState();
    state.bindSource('gone');
    state.setLoaded([], [{ sourceId: 'gone', entityType: 'kind-a', stableId: 'item-g' }], []);
    const parts = home(['source-a'], () => ({ ok: true, value: listOf() }));
    renderApp('/', parts.client, state);
    expect(await screen.findByText('gone is not configured, so its patterns cannot be listed.')).toBeTruthy();
    expect(runButtons()).toEqual([]);
    expect(parts.asked).toEqual([]);
  });

  it('names the source in a failure, offers Try again when it can be retried, reads again once, and leaves the rest of Home', async () => {
    let attempts = 0;
    const parts = home(['source-a'], () => {
      attempts += 1;
      return attempts === 1 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: listOf() };
    });
    renderApp('/', parts.client);
    const alert = await within(await screen.findByRole('region', { name: 'Start from a pattern' })).findByRole('alert');
    expect(alert.textContent).toContain('The patterns of Source source-a could not be read.');
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeTruthy();
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Run Shared devices' });
    expect(attempts).toBe(2);
  });

  it('offers no Try again for a failure that cannot be retried', async () => {
    renderApp('/', home(['source-a'], () => ({ ok: false, failure: { ...failure('SOURCE_UNAVAILABLE', { reason: 'unreachable' }), retryable: false } })).client);
    const alert = await within(await screen.findByRole('region', { name: 'Start from a pattern' })).findByRole('alert');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('is not shown when no source is configured', async () => {
    const parts = home([], () => ({ ok: true, value: listOf() }));
    renderApp('/', parts.client);
    await waitFor(() => expect(parts.calls.listInvestigations.length).toBeGreaterThan(0));
    expect(card()).toBeNull();
    expect(parts.asked).toEqual([]);
  });

  it('is not shown when the sources could not be read', async () => {
    const parts = home(['source-a'], () => ({ ok: true, value: listOf() }), { getSources: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    renderApp('/', parts.client);
    await waitFor(() => expect(parts.calls.listInvestigations.length).toBeGreaterThan(0));
    expect(card()).toBeNull();
    expect(parts.asked).toEqual([]);
  });
});
