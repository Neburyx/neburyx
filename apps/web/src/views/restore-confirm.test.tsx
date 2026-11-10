import type { RestoreViewResponse } from '@neburyx/contracts';
import { act, cleanup, screen, waitFor, within, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClientProvider } from '../api/client-context.js';
import { ClientStateProvider } from '../state/context.js';
import { RestoreConfirm } from './restore-confirm.js';
import type { ApiClient } from '../api/client.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { result } from '../state/test-data.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { failure, INVESTIGATION_ID, namedView, rig, viewsServer } from './view-fixtures.js';

afterEach(cleanup);

const NO_FILTERS = { entityTypes: [], relTypes: [], time: null, properties: [] };
const entry = (id: string) => ({ t: 'type-a', id, pinned: false, hidden: false, groupId: null });
const SAVED_AT = '2026-10-30T09:42:00.000Z';
const drafted = (version: number): RestoreViewResponse['draft'] => ({
  version,
  notes: 'restored',
  basedOnViewId: namedView(3).id,
  layout: { schemaVersion: 1, layout: 'force', nodes: [entry('A'), entry('B')], edges: [], groups: [] },
  queryContext: { schemaVersion: 1, loaded: { nodes: [{ t: 'type-a', id: 'A' }, { t: 'type-a', id: 'B' }], edges: [] }, expansions: [], filters: NO_FILTERS },
});


const SERVED_INVESTIGATION = { id: INVESTIGATION_ID, sourceId: 'demo', title: 'Suspicious linked accounts', caseRef: null, status: 'open' as const, startingEntity: { entityType: 'type-a', stableId: 'A' }, sourceState: 'available' as const, createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 3 };

/** The answer of the investigation read once the view is restored: the draft the server holds now, equal to the view. */
function restoredRead(version: number): ReturnType<NonNullable<ApiClient['getInvestigation']>> {
  return Promise.resolve({ ok: true as const, value: { investigation: SERVED_INVESTIGATION, draft: drafted(version), save: { state: 'saved' as const, savedAt: SAVED_AT } } });
}

function shown(overrides: Partial<ApiClient> = {}) {
  const server = viewsServer([namedView(3, { name: 'Shared device ring' }), namedView(2), namedView(1)]);
  const restored: number[] = [];
  const base = clientWith({ me: me(), sources: [source('demo', { alias: 'fincrime' })] });
  const known = result('demo', ['A', 'B']);
  const parts = rig({
    base,
    listViews: server.listViews,
    renameView: server.renameView,
    overrides: {
      restoreView: async (_id, _viewId, version) => (restored.push(version), { ok: true, value: { draft: drafted(version + 1), save: { state: 'saved', savedAt: SAVED_AT } } }),
      getInvestigation: async () => restoredRead(restored.length > 0 ? 2 : 1),
      readRefs: async (request) => ({ ok: true, value: { nodes: known.nodes.filter((node) => request.entities.some((entity) => entity.stableId === node.ref.stableId)), edges: [], missing: { entities: [], edges: [] } } }),
      ...overrides,
    },
  });
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  renderApp(`/explore/${INVESTIGATION_ID}`, parts.client, parts.state, slots);
  return { ...parts, restored };
}

const confirmDialog = () => screen.getByRole('dialog', { name: 'Replace your draft?' });

async function chooseRestore(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Views/ }));
  await screen.findByRole('heading', { name: /^Views · / });
  await user.click(screen.getByRole('button', { name: 'Restore Shared device ring into draft' }));
  return within(await screen.findByRole('dialog', { name: 'Replace your draft?' }));
}

describe('the confirm of a restore', () => {
  it('says the draft is replaced and the view is not, and offers Cancel and Restore into draft', async () => {
    const user = userEvent.setup();
    const { restored } = shown();
    const confirm = await chooseRestore(user);
    expect(confirm.getByText('Restoring “Shared device ring” replaces everything in your draft: layout, filters, hidden items, groups and notes. Your current draft is not kept.')).toBeTruthy();
    expect(confirm.getByText(/Named views are not changed\./)).toBeTruthy();
    expect(confirm.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(confirm.getByRole('button', { name: 'Restore into draft' })).toBeTruthy();
    expect(restored).toEqual([]);
  });

  it('changes nothing and sends nothing on Cancel and on Esc, and gives the focus back to Views', async () => {
    const user = userEvent.setup();
    const { restored, state } = shown();
    const before = state.loadedGraph().nodes.length;
    const confirm = await chooseRestore(user);
    await user.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Views/ }));
    await chooseRestore(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull();
    expect(restored).toEqual([]);
    expect(state.loadedGraph().nodes).toHaveLength(before);
  });

  it('takes the focus into the confirm and confirms with Enter on Restore into draft', async () => {
    const user = userEvent.setup();
    const { restored, state } = shown();
    await chooseRestore(user);
    expect(confirmDialog().contains(document.activeElement)).toBe(true);
    const button = within(confirmDialog()).getByRole('button', { name: 'Restore into draft' });
    button.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull());
    expect(restored).toHaveLength(1);
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A', 'B']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Views/ }));
    expect(within(screen.getByRole('banner', { name: 'Investigation' })).getByText('Saved 09:42 UTC')).toBeTruthy();
  });

  it('closes when another investigation is shown, so it can never restore into the wrong one', async () => {
    const user = userEvent.setup();
    const { state, restored } = shown();
    await chooseRestore(user);
    const other = result('demo', ['Z']);
    const otherKey = { sourceId: 'demo', principalId: 'principal-1', policyVersion: 'none', filterHash: 'none', params: 'open:other', mask: false };
    act(() => {
      state.show({ id: '0192f000-0000-7000-8000-0000000000a9', sourceId: 'demo', record: { title: 'Other', caseRef: null, status: 'open', readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [otherKey], nodeRefs: other.nodes.map((node) => node.ref), edgeRefs: [] }, [{ key: otherKey, result: other }]);
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull());
    expect(restored).toEqual([]);
  });

  it('disables both buttons while the restore is in flight, and sends one request', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent: number[] = [];
    const { state } = shown({
      restoreView: async (_id, _viewId, version) => {
        sent.push(version);
        await gate;
        return { ok: true, value: { draft: drafted(version + 1), save: { state: 'saved', savedAt: SAVED_AT } } };
      },
    });
    const confirm = await chooseRestore(user);
    await user.click(confirm.getByRole('button', { name: 'Restore into draft' }));
    await waitFor(() => expect((confirm.getByRole('button', { name: 'Restore into draft' }) as HTMLButtonElement).disabled).toBe(true));
    expect((confirm.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(confirm.getByRole('status').textContent).toBe('Restoring…');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).not.toBeNull();
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull());
    expect(sent).toHaveLength(1);
    expect(state.loadedGraph().nodes).toHaveLength(2);
  });

  it('says the draft is unchanged, in the confirm’s status region, when the restore fails, and lets the person try again or cancel', async () => {
    const user = userEvent.setup();
    const { state } = shown({ restoreView: async () => failure('INTERNAL_ERROR') });
    const confirm = await chooseRestore(user);
    await user.click(confirm.getByRole('button', { name: 'Restore into draft' }));
    await waitFor(() => expect(confirm.getByRole('status').textContent).toBe("Couldn't restore the view. Your draft is unchanged."));
    expect((confirm.getByRole('button', { name: 'Restore into draft' }) as HTMLButtonElement).disabled).toBe(false);
    expect(state.loadedGraph().nodes).toHaveLength(1);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull();
  });

  it('closes and shows the changed-in-another-tab banner when the draft version is stale', async () => {
    const user = userEvent.setup();
    const parts = shown({ restoreView: async () => failure('CONFLICTED_VIEW_VERSION') });
    const confirm = await chooseRestore(user);
    await user.click(confirm.getByRole('button', { name: 'Restore into draft' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull());
    expect(draftSyncOf(parts.state, parts.client).status.getState()).toEqual({ kind: 'conflict' });
    expect((await screen.findAllByText('This investigation changed in another tab.')).length).toBeGreaterThan(0);
  });

  it('says some items are no longer available when the view names items that cannot be read again', async () => {
    const user = userEvent.setup();
    shown({ readRefs: async (request) => ({ ok: true, value: { nodes: [], edges: [], missing: { entities: request.entities.filter((entity) => entity.stableId === 'B'), edges: [] } } }) });
    const confirm = await chooseRestore(user);
    await user.click(confirm.getByRole('button', { name: 'Restore into draft' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull());
    expect(await screen.findByText('Some items are no longer available.')).toBeTruthy();
  });

  it('keeps the confirm open with Try again and Reload when the restored graph cannot be read, and closes when the retry reads it', async () => {
    const user = userEvent.setup();
    let failing = true;
    const known = result('demo', ['A', 'B']);
    const { state } = shown({
      readRefs: async (request) => (failing ? failure('QUERY_TIMEOUT') : { ok: true, value: { nodes: known.nodes.filter((node) => request.entities.some((entity) => entity.stableId === node.ref.stableId)), edges: [], missing: { entities: [], edges: [] } } }),
    });
    const confirm = await chooseRestore(user);
    await user.click(confirm.getByRole('button', { name: 'Restore into draft' }));
    await waitFor(() => expect(confirm.getByRole('status').textContent).toContain('its graph could not be read'));
    expect(confirm.getByRole('button', { name: 'Reload' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).not.toBeNull();
    expect(state.loadedGraph().nodes).toHaveLength(1);
    failing = false;
    await user.click(confirm.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull());
    expect(state.loadedGraph().nodes).toHaveLength(2);
  });

  it('restores in a build that mounts, unmounts and mounts the confirm again', async () => {
    const user = userEvent.setup();
    const known = result('demo', ['A', 'B']);
    const restored: number[] = [];
    const parts = rig({
      overrides: {
        getInvestigation: async () => restoredRead(2),
        restoreView: async (_id, _viewId, version) => (restored.push(version), { ok: true, value: { draft: drafted(version + 1), save: { state: 'saved', savedAt: SAVED_AT } } }),
        readRefs: async (request) => ({ ok: true, value: { nodes: known.nodes.filter((node) => request.entities.some((entity) => entity.stableId === node.ref.stableId)), edges: [], missing: { entities: [], edges: [] } } }),
      },
    });
    render(
      <StrictMode>
        <ApiClientProvider client={parts.client}>
          <ClientStateProvider state={parts.state}>
            <RestoreConfirm view={namedView(3)} onClose={() => undefined} />
          </ClientStateProvider>
        </ApiClientProvider>
      </StrictMode>,
    );
    await user.click(screen.getByRole('button', { name: 'Restore into draft' }));
    await waitFor(() => expect(parts.state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A', 'B']));
    expect(restored).toHaveLength(1);
    expect(parts.state.investigation.getState().id).toBe(INVESTIGATION_ID);
  });
});

