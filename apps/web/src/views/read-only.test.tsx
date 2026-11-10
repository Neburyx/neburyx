import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../api/client.js';
import { createClientState } from '../state/client-state.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { INVESTIGATION_ID, namedView, rig, viewsServer } from './view-fixtures.js';
import { restoreNamedView } from './restore-view.js';
import { saveNamedView } from './save-view.js';
import { createViewList } from './view-list.js';

afterEach(cleanup);

function refusal<T>(status: 'closed' | 'archived' = 'closed'): ApiResult<T> {
  return { ok: false, failure: { code: 'CONFLICT', message: 'This investigation is closed or archived. Reopen it to make changes.', retryable: false, traceId: 't', details: { reason: 'investigation-read-only', status } } };
}

function shown(readOnly: boolean, overrides: Partial<ApiClient> = {}) {
  const server = viewsServer([namedView(2), namedView(1)]);
  const base = clientWith({ me: me(), sources: [source('demo')] });
  const parts = rig({ base, listViews: server.listViews, renameView: server.renameView, overrides });
  const record = parts.state.investigation.getState().record;
  if (record !== null && readOnly) parts.state.describeInvestigation({ ...record, status: 'closed', readOnly: true });
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  renderApp(`/explore/${INVESTIGATION_ID}`, parts.client, parts.state, slots);
  return parts;
}

describe('a closed or archived investigation in the header and the Views panel', () => {
  it('dims Save, and lists the views with Restore into draft and Rename dimmed', async () => {
    const user = userEvent.setup();
    shown(true);
    expect((await screen.findByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: /^Views/ }));
    const panel = within(await screen.findByRole('dialog', { name: /^Views/ }));
    expect(await panel.findByRole('heading', { name: 'Views · 2' })).toBeTruthy();
    for (const button of [...panel.getAllByRole('button', { name: /^Restore / }), ...panel.getAllByRole('button', { name: /^Rename / })]) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('says why in one line of the panel, tied to every disabled action, and the actions are not live: not focusable by Tab, and a click does nothing', async () => {
    const user = userEvent.setup();
    shown(true);
    await user.click(await screen.findByRole('button', { name: /^Views/ }));
    const panel = within(await screen.findByRole('dialog', { name: /^Views/ }));
    await panel.findByRole('heading', { name: 'Views · 2' });
    const reason = panel.getByText('Reopen to restore or rename views.');
    expect(reason.id).not.toBe('');
    const actions = [...panel.getAllByRole('button', { name: /^Restore / }), ...panel.getAllByRole('button', { name: /^Rename / })];
    expect(actions).toHaveLength(4);
    for (const action of actions) {
      expect(action.getAttribute('aria-describedby')).toBe(reason.id);
      expect((action as HTMLButtonElement).disabled).toBe(true);
    }
    for (let press = 0; press < 6; press += 1) {
      await user.tab();
      expect(actions).not.toContain(document.activeElement);
    }
    await user.click(actions[0] as HTMLElement);
    expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull();
    await user.click(actions[1] as HTMLElement);
    expect(panel.queryByRole('textbox')).toBeNull();
  });

  it('shows no reason line, and no aria-describedby on the actions, for an open investigation', async () => {
    const user = userEvent.setup();
    shown(false);
    await user.click(await screen.findByRole('button', { name: /^Views/ }));
    const panel = within(await screen.findByRole('dialog', { name: /^Views/ }));
    await panel.findByRole('heading', { name: 'Views · 2' });
    expect(panel.queryByText('Reopen to restore or rename views.')).toBeNull();
    expect(panel.getByRole('button', { name: 'Rename View 2' }).getAttribute('aria-describedby')).toBeNull();
  });

  it('draws the reason line in the muted text colour, as the hint of the investigation menu is', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/views.css'), 'utf8');
    expect(css).toMatch(/\.views-note,[^{]*\{[^}]*color: var\(--color-text-muted\);/s);
  });

  it('keeps Save and the row actions working for an open investigation', async () => {
    const user = userEvent.setup();
    shown(false);
    expect((await screen.findByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: /^Views/ }));
    const panel = within(await screen.findByRole('dialog', { name: /^Views/ }));
    await panel.findByRole('heading', { name: 'Views · 2' });
    expect((panel.getByRole('button', { name: 'Rename View 2' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('an open rename row when the investigation is closed in another tab', () => {
  it('leaves no enabled Save name once the rename is refused as read-only', async () => {
    const user = userEvent.setup();
    shown(false, { renameView: async () => refusal() });
    await user.click(await screen.findByRole('button', { name: /^Views/ }));
    const panel = within(await screen.findByRole('dialog', { name: /^Views/ }));
    await user.click(await panel.findByRole('button', { name: 'Rename View 2' }));
    await user.type(panel.getByRole('textbox', { name: /^Name of/ }), '!');
    await user.click(panel.getByRole('button', { name: 'Save name' }));
    await screen.findByText("Couldn't rename the view. Try again.");
    expect((panel.getByRole('button', { name: 'Save name' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('a refusal because the investigation was closed in another tab', () => {
  it('stops the Save control after a refused save, and leaves the draft as it was', async () => {
    const { state, client } = rig({ saveView: () => refusal() });
    expect(await saveNamedView(client, state, { name: 'Suspicious linked accounts', notes: null })).toEqual({ kind: 'failed' });
    expect(state.investigation.getState().record).toMatchObject({ status: 'closed', readOnly: true });
  });

  it('stops the controls after a refused restore', async () => {
    const { state, client } = rig({ overrides: { restoreView: async () => refusal('archived') } });
    expect(await restoreNamedView(client, state, namedView(1).id)).toEqual({ kind: 'failed' });
    expect(state.investigation.getState().record).toMatchObject({ status: 'archived', readOnly: true });
  });

  it('stops the controls after a refused rename', async () => {
    const server = viewsServer([namedView(1)]);
    const { state, client } = rig({ listViews: server.listViews, renameView: async () => refusal() });
    const list = createViewList(client, state);
    await list.load();
    expect(await list.rename(namedView(1).id, 'Renamed')).toBe('failed');
    expect(state.investigation.getState().record).toMatchObject({ readOnly: true });
    expect(createClientState().investigation.getState().record).toBeNull();
  });
});
