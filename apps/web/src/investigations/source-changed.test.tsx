import type { Investigation, InvestigationResponse } from '@neburyx/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../api/client.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { createToolRegistry } from '../workspace/tool-registry.js';
import { registerBuiltInTools } from '../workspace/built-in-tools.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { registerInvestigationMenu } from '../lifecycle/register-menu.js';
import { me, renderApp, source, stubFactory } from '../test-utils.js';
import { describeWalked } from '../canvas/walk.js';
import { SEARCH_PANEL_COPY } from '../search/copy.js';
import { INVESTIGATION_A, investigationOf } from './test-data.js';

const ENTITY_TYPE = 'kind-a';
const REPOINTED_TEXT = 'This source now points to a different database.';
const REMOVED_TEXT = 'The source this investigation used is no longer configured.';

const SOURCE_READ_PATH = /^\/v1\/(graph|entities|search|edges|source-links)\//;

function layoutRead(investigation: Investigation): InvestigationResponse {
  const ids = ['A-1', 'A-2', 'A-3'];
  const nodes = ids.map((id) => ({ t: ENTITY_TYPE, id }));
  return {
    investigation,
    draft: {
      version: 4,
      layout: {
        schemaVersion: 1,
        layout: 'force',
        viewport: { zoom: 1.5, x: 10, y: 20 },
        nodes: [
          { t: ENTITY_TYPE, id: 'A-1', x: 100, y: 120, pinned: true, hidden: false, groupId: null },
          { t: ENTITY_TYPE, id: 'A-2', x: 240, y: 80, pinned: false, hidden: false, groupId: null },
          { t: ENTITY_TYPE, id: 'A-3', pinned: false, hidden: true, groupId: null },
        ],
        edges: [],
        groups: [],
      },
      queryContext: { schemaVersion: 1, loaded: { nodes, edges: [{ t: 'LINKS', from: { t: ENTITY_TYPE, id: 'A-1' }, to: { t: ENTITY_TYPE, id: 'A-2' }, id: 'E-1' }] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } },
      notes: null,
      basedOnViewId: null,
    },
    save: { state: 'saved', savedAt: '2026-11-05T10:00:00.000Z' },
  };
}

interface Rig {
  readonly client: ApiClient;
  readonly requests: { readonly method: string; readonly path: string }[];
}

/** The real client over a fetch that records every request and answers only what the page needs to show the investigation. */
function rigFor(investigation: Investigation, answers: Record<string, unknown> = {}, profileGone = false): Rig {
  const requests: { method: string; path: string }[] = [];
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const client = createApiClient((input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, path });
    if (method === 'GET' && path === '/v1/me') return Promise.resolve(json(me()));
    if (method === 'GET' && path === '/v1/sources') return Promise.resolve(json({ items: [source('source-a')], nextCursor: null }));
    if (method === 'GET' && path === '/v1/sources/source-a/profile') return Promise.resolve(profileGone ? json({ error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } }, 404) : json(testProfile('source-a')));
    if (method === 'GET' && path === `/v1/investigations/${investigation.id}`) return Promise.resolve(json(layoutRead(investigation)));
    const answer = answers[`${method} ${path}`];
    if (answer !== undefined) return Promise.resolve(json(answer));
    return Promise.resolve(json({ error: { code: 'INTERNAL_ERROR', message: 'unexpected', retryable: false, traceId: 'tr-1' } }, 500));
  });
  return { client, requests };
}

const changed = (sourceState: 'repointed' | 'removed') => investigationOf(INVESTIGATION_A, 'source-a', ENTITY_TYPE, 'A-1', { sourceState });

async function opened(sourceState: 'repointed' | 'removed', answers: Record<string, unknown> = {}) {
  const rig = rigFor(changed(sourceState), answers, sourceState === 'removed');
  const state = createClientState();
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  registerInvestigationMenu(slots, rig.client);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  const view = renderApp(`/explore/${INVESTIGATION_A}`, rig.client, state, slots, undefined, undefined, tools);
  await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
  return { ...rig, state, view };
}

describe('a re-pointed source opens read-only on its saved layout', () => {
  it('shows the workspace with the pill "Read-only" and the banner of frame 60, verbatim', async () => {
    await opened('repointed');
    expect(screen.getAllByRole('status').some((element) => element.textContent === 'Read-only')).toBe(true);
    const region = within(screen.getByRole('region', { name: 'Request status' }));
    expect(region.getByText('Source re-pointed')).toBeTruthy();
    expect(region.getByText(REPOINTED_TEXT)).toBeTruthy();
    expect(region.getByText('An operator must confirm the rebind. This investigation is read-only and runs no source reads.')).toBeTruthy();
    expect(region.queryByRole('button')).toBeNull();
  });

  it('says in the scope lines what is true: the saved layout was not read, and no remainder is named', async () => {
    await opened('repointed');
    const group = screen.getByRole('group', { name: 'Graph scope' });
    expect(group.textContent).toContain('3 entities · 1 relationship · saved layout, not read');
    expect(within(group).getByText('2 shown')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/loaded · exact|not yet retrieved/);
  });

  it('disables Save and gives the reason, for a changed source first', async () => {
    const { state } = await opened('repointed');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('Not available while the source has changed.');
    expect(save.getAttribute('aria-describedby')).not.toBeNull();
    expect(document.getElementById(save.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Not available while the source has changed.');
    act(() => state.describeInvestigation({ title: 'T', caseRef: null, status: 'closed', readOnly: true, version: 2, save: { kind: 'unsaved' }, sourceState: 'available' }));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).title).toBe('Reopen to save.');
    act(() => state.describeInvestigation({ title: 'T', caseRef: null, status: 'open', readOnly: false, version: 3, save: { kind: 'unsaved' }, sourceState: 'available' }));
    const open = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    expect(open.title).toBe('');
    expect(open.getAttribute('aria-describedby')).toBeNull();
  });

  it('draws every saved item as a placeholder at its saved place, pin and hidden flag, and never shows a stored ID', async () => {
    const { state } = await opened('repointed');
    const nodes = state.loadedGraph().nodes;
    expect(nodes).toHaveLength(3);
    expect(nodes.every((node) => node.qualityFlags.includes('saved-layout-not-read'))).toBe(true);
    const keyOf = (id: string) => elementKey({ sourceId: 'source-a', entityType: ENTITY_TYPE, stableId: id });
    const view = state.presentation.view.getState();
    expect(view.positions.get(keyOf('A-1'))).toEqual({ x: 100, y: 120 });
    expect(view.positions.get(keyOf('A-2'))).toEqual({ x: 240, y: 80 });
    expect([...view.pins]).toEqual([keyOf('A-1')]);
    expect([...view.hidden]).toEqual([keyOf('A-3')]);
    expect(state.loadedGraph().edges).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/A-[23]|E-1/);
  });

  it('draws each placeholder under the type name the profile gives with "Saved layout · not read", and says the same to a screen reader', async () => {
    const renderer = stubFactory();
    const rig = rigFor(changed('repointed'));
    const state = createClientState();
    const slots = createSlotRegistry();
    registerBuiltInSlots(slots);
    renderApp(`/explore/${INVESTIGATION_A}`, rig.client, state, slots, renderer.create);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    const typeName = testProfile('source-a').entityTypes.find((entry) => entry.type === ENTITY_TYPE)?.displayName;
    await waitFor(() => expect(renderer.made[0]?.scenes.at(-1)?.entities.map((entity) => entity.look.line1)).toEqual([typeName, typeName]));
    expect(renderer.made[0]?.scenes.at(-1)?.entities.map((entity) => entity.look.line2)).toEqual(['Saved layout · not read', 'Saved layout · not read']);
    const [first] = state.loadedGraph().nodes;
    if (first === undefined) throw new Error('no placeholder');
    expect(describeWalked(state.loadedGraph(), testProfile('source-a'), new Set(), elementKey(first.ref))).toBe(`${typeName}, Saved layout · not read`);
  });

  it('keeps the search panel shut for Mod+K and sends no search when the Add box is used anyway', async () => {
    const { requests, state } = await opened('repointed');
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('{Meta>}k{/Meta}');
    expect(state.presentation.view.getState().searchOpen).toBe(false);
    act(() => state.presentation.setSearchOpen(true));
    await user.click(await screen.findByRole('tab', { name: SEARCH_PANEL_COPY.addLabel }));
    const box = await screen.findByLabelText(SEARCH_PANEL_COPY.addBoxLabel);
    await user.type(box, 'a long enough search text');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(requests.filter((request) => /\/v1\/search\//.test(request.path))).toEqual([]);
  });

  it('sends no request to a route that reads the source, and no write, whatever the person does', async () => {
    const { requests, state, view } = await opened('repointed');
    const user = userEvent.setup();
    for (const button of within(screen.getByRole('group', { name: 'Tools' })).getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      await user.click(button);
    }
    const [first] = state.loadedGraph().nodes;
    if (first === undefined) throw new Error('no placeholder');
    act(() => state.presentation.select([elementKey(first.ref)]));
    for (const binding of view.keyBindings.view.getState()) {
      for (const keys of binding.keys) {
        const parts = keys.split('+');
        const key = parts.pop() ?? '';
        const modifiers = parts.map((part) => (part === 'mod' ? 'Control' : part === 'shift' ? 'Shift' : part === 'alt' ? 'Alt' : part));
        await user.keyboard(`${modifiers.map((modifier) => `{${modifier}>}`).join('')}{${key.length === 1 ? key : key.replace(/^./, (letter) => letter.toUpperCase())}}${modifiers.reverse().map((modifier) => `{/${modifier}}`).join('')}`).catch(() => undefined);
      }
    }
    await act(async () => view.router.navigate(`/explore/${INVESTIGATION_A}`));
    expect(requests.filter((request) => SOURCE_READ_PATH.test(request.path))).toEqual([]);
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('dims the tool strip and the investigation menu keeps Close, Archive and Delete, with Rename dimmed', async () => {
    await opened('repointed');
    const user = userEvent.setup();
    for (const button of within(screen.getByRole('group', { name: 'Tools' })).getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Investigation menu' }));
    const menu = screen.getByRole('menu', { name: 'Investigation actions' });
    expect(within(menu).getByRole('menuitem', { name: /Rename/ }).getAttribute('aria-disabled')).toBe('true');
    for (const name of ['Close', 'Archive', 'Delete']) expect(within(menu).getByRole('menuitem', { name }).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('sends no draft write when items are moved, pinned or hidden, and shows no refusal banner', async () => {
    const { requests, state } = await opened('repointed');
    const [first, second] = state.loadedGraph().nodes;
    if (first === undefined || second === undefined) throw new Error('no placeholders');
    act(() => {
      state.presentation.setPositions(new Map([[elementKey(first.ref), { x: 1, y: 2 }]]));
      state.presentation.pin([elementKey(second.ref)]);
      state.hide([elementKey(first.ref)]);
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 3500)));
    expect(requests.filter((request) => request.method === 'PUT')).toEqual([]);
    expect(screen.queryByText(/not saved|Changes not saved/i)).toBeNull();
    expect(screen.getByText(REPOINTED_TEXT)).toBeTruthy();
  }, 10000);
});

describe('the banner of a changed source', () => {
  it('shows again after a request banner that replaced it is dismissed, one banner at a time', async () => {
    const { view } = await opened('repointed');
    act(() => view.banner.show({ id: 'request', tone: 'warning', chip: 'Busy', headline: 'A request failed', text: 'Try again.', actions: [], dismissible: true }));
    expect(screen.getByText('A request failed')).toBeTruthy();
    expect(screen.queryByText(REPOINTED_TEXT)).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByText(REPOINTED_TEXT)).toBeTruthy();
  });

  it('is announced once, politely, and moves no focus', async () => {
    const { view } = await opened('repointed');
    const live = [...document.querySelectorAll('[aria-live="polite"]')].map((element) => element.textContent).join(' ');
    expect(live).toContain('Source re-pointed. This source now points to a different database.');
    expect(view.banner.view.getState().banner?.moveFocus).toBeUndefined();
  });

  it('is the cause shown first when the investigation is also closed, and the closed banner returns once the source is as it was', async () => {
    const { state } = await opened('repointed');
    act(() => state.describeInvestigation({ title: 'T', caseRef: null, status: 'closed', readOnly: true, version: 2, save: { kind: 'unsaved' }, sourceState: 'repointed' }));
    expect(screen.getByText(REPOINTED_TEXT)).toBeTruthy();
    expect(screen.queryByText('This investigation is closed and read-only.')).toBeNull();
    act(() => state.describeInvestigation({ title: 'T', caseRef: null, status: 'closed', readOnly: true, version: 2, save: { kind: 'unsaved' }, sourceState: 'available' }));
    expect(screen.getByText('This investigation is closed and read-only.')).toBeTruthy();
  });
});

describe('a removed source opens read-only on its saved layout, with Delete', () => {
  it('shows the banner of frame 61 verbatim with Delete, the pill "Read-only" and the placeholders', async () => {
    const { state } = await opened('removed');
    expect(screen.getAllByRole('status').some((element) => element.textContent === 'Read-only')).toBe(true);
    const region = within(screen.getByRole('region', { name: 'Request status' }));
    expect(region.getByText('Source removed')).toBeTruthy();
    expect(region.getByText(REMOVED_TEXT)).toBeTruthy();
    expect(region.getByText('You can still see the saved layout. No source reads run. You can delete the investigation.')).toBeTruthy();
    expect(region.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(state.loadedGraph().nodes).toHaveLength(3);
  });

  it('asks for no profile of the removed source and shows no failure for it', async () => {
    const { requests } = await opened('removed');
    expect(requests.map((request) => request.path)).not.toContain('/v1/sources/source-a/profile');
    expect(document.body.textContent).not.toContain('NOT_FOUND');
    expect(screen.queryByRole('group', { name: 'Notices' })).toBeNull();
  });

  it('sends no request to a route that reads the source', async () => {
    const { requests } = await opened('removed');
    expect(requests.filter((request) => SOURCE_READ_PATH.test(request.path))).toEqual([]);
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('asks before deleting with focus on Cancel, returns focus to Delete on Cancel or Escape, and deletes through the confirm', async () => {
    const answers = { [`DELETE /v1/investigations/${INVESTIGATION_A}`]: { id: INVESTIGATION_A, version: 2, deletedAt: '2026-11-10T10:00:00.000Z', purgeAfter: '2026-12-10T10:00:00.000Z' } };
    const { requests, view } = await opened('removed', answers);
    const user = userEvent.setup();
    const region = () => within(screen.getByRole('region', { name: 'Request status' }));
    await user.click(region().getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(region().getByRole('button', { name: 'Delete' }));
    await user.click(region().getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(region().getByRole('button', { name: 'Delete' }));
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
    await user.click(region().getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete investigation' }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/investigations'));
    expect(await screen.findByText('Investigation deleted. Restorable until 10 Dec 2026 10:00 UTC.')).toBeTruthy();
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
  });

  it('shows a failed Delete as a failure in the confirm and leaves the investigation as it was', async () => {
    const { requests, state } = await opened('removed');
    const user = userEvent.setup();
    await user.click(within(screen.getByRole('region', { name: 'Request status' })).getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete investigation' }));
    await within(await screen.findByRole('dialog')).findByText(/INTERNAL_ERROR|could not|failed/i);
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect(state.investigation.getState().id).toBe(INVESTIGATION_A);
    expect(state.loadedGraph().nodes).toHaveLength(3);
  });

  it('offers neither Delete nor the sentence that mentions it when the person may not delete', async () => {
    const { state } = await opened('removed');
    act(() => state.describeInvestigation({ ...(state.investigation.getState().record ?? { title: 'T', caseRef: null, status: 'open' as const, readOnly: true, version: 1, save: { kind: 'unsaved' as const } }), canDelete: false }));
    const region = within(screen.getByRole('region', { name: 'Request status' }));
    expect(region.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(region.getByText('You can still see the saved layout. No source reads run.')).toBeTruthy();
    expect(region.queryByText(/delete the investigation/)).toBeNull();
  });
});
