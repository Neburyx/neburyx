import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { failure, INVESTIGATION_ID, namedView, rig, viewsServer } from './view-fixtures.js';

afterEach(cleanup);

function shown(server: ReturnType<typeof viewsServer>, overrides: Parameters<typeof rig>[0] = {}) {
  const base = clientWith({ me: me(), sources: [source('demo', { alias: 'fincrime' })] });
  const parts = rig({ base, listViews: server.listViews, renameView: server.renameView, ...overrides });
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  renderApp(`/explore/${INVESTIGATION_ID}`, parts.client, parts.state, slots);
  return parts;
}

const control = async () => screen.findByRole('button', { name: /^Views/ });
const panel = () => screen.getByRole('dialog', { name: /^Views/ });
const three = () => viewsServer([namedView(3, { name: 'Shared device ring', savedBy: { name: 'Maya Chen' } }), namedView(2, { name: 'Before expanding the IP address' }), namedView(1, { name: 'First pass', savedBy: { name: 'Avery Quinn' } })]);

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await control());
  await screen.findByRole('heading', { name: /^Views · / });
  return panel();
}

describe('the Views panel', () => {
  it('opens under Views with the exact count, the draft time, a row for each view and the footnote', async () => {
    const user = userEvent.setup();
    shown(three());
    const view = within(await open(user));
    expect(view.getByRole('heading', { name: 'Views · 3' })).toBeTruthy();
    expect(view.getByText('Your draft autosaved at 09:42 UTC. Named views never change.')).toBeTruthy();
    expect(view.getAllByRole('listitem')).toHaveLength(3);
    expect(view.getByText('Shared device ring')).toBeTruthy();
    expect(view.getByText('Saved by Maya Chen · 30 Oct 2026 09:03 UTC')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Rename Shared device ring' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Restore Shared device ring into draft' })).toBeTruthy();
    expect(view.getByText('Restoring copies a view into your draft. Only you see your draft.')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says there are no named views yet, with the count of zero', async () => {
    const user = userEvent.setup();
    shown(viewsServer([]));
    const view = within(await open(user));
    expect(view.getByRole('heading', { name: 'Views · 0' })).toBeTruthy();
    expect(view.getByRole('status').textContent).toBe('No named views yet.');
    expect(view.queryByRole('list')).toBeNull();
  });

  it('shows the failure of the list with Retry, leaves the workspace as it was, and reads again on Retry', async () => {
    const user = userEvent.setup();
    const server = three();
    let answers = 0;
    shown(server, { listViews: async (...args) => (answers++ === 0 ? failure('INTERNAL_ERROR') : server.listViews(...args)) });
    await user.click(await control());
    const view = within(panel());
    expect((await view.findByRole('status')).textContent).toBe("Couldn't load the views.");
    expect(screen.getByRole('heading', { level: 1, name: 'Suspicious linked accounts' })).toBeTruthy();
    await user.click(view.getByRole('button', { name: 'Retry' }));
    expect(await view.findByRole('heading', { name: 'Views · 3' })).toBeTruthy();
  });

  it('shows Show more while there is a next page, loads it until the last, lists each view once and keeps the count', async () => {
    const user = userEvent.setup();
    shown(viewsServer(Array.from({ length: 5 }, (_, n) => namedView(5 - n)), 2));
    const view = within(await open(user));
    expect(view.getAllByRole('listitem')).toHaveLength(2);
    await user.click(view.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(view.getAllByRole('listitem')).toHaveLength(4));
    await user.click(view.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(view.getAllByRole('listitem')).toHaveLength(5));
    expect(view.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(view.getByRole('heading', { name: 'Views · 5' })).toBeTruthy();
    expect(view.getAllByRole('listitem').map((item) => item.querySelector('.views-name')?.textContent)).toEqual(['View 5', 'View 4', 'View 3', 'View 2', 'View 1']);
  });

  it('turns a row into an input with the hint, saves the new name without a reload, and shows it in the row', async () => {
    const user = userEvent.setup();
    const server = three();
    shown(server);
    const view = within(await open(user));
    await user.click(view.getByRole('button', { name: 'Rename First pass' }));
    const input = view.getByRole('textbox', { name: 'Name of First pass' });
    expect((input as HTMLInputElement).value).toBe('First pass');
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described.join(' ')).toContain("Don't type customer names; others may see this text.");
    await user.clear(input);
    await user.type(input, 'Second pass');
    await user.click(view.getByRole('button', { name: 'Save name' }));
    expect(await view.findByText('Second pass')).toBeTruthy();
    expect(view.queryByRole('textbox')).toBeNull();
    expect(server.renamed).toEqual([{ viewId: namedView(1).id, version: 1, name: 'Second pass' }]);
  });

  it('saves the name on Enter in the input', async () => {
    const user = userEvent.setup();
    const server = three();
    shown(server);
    const view = within(await open(user));
    await user.click(view.getByRole('button', { name: 'Rename First pass' }));
    await user.type(view.getByRole('textbox', { name: 'Name of First pass' }), '!{Enter}');
    expect(await view.findByText('First pass!')).toBeTruthy();
  });

  it('changes nothing on Cancel and on Esc in the input, and Esc there leaves the panel open', async () => {
    const user = userEvent.setup();
    const server = three();
    shown(server);
    const view = within(await open(user));
    await user.click(view.getByRole('button', { name: 'Rename First pass' }));
    await user.type(view.getByRole('textbox', { name: 'Name of First pass' }), 'xx');
    await user.click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.getByText('First pass')).toBeTruthy();
    await user.click(view.getByRole('button', { name: 'Rename First pass' }));
    await user.keyboard('xx{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(view.queryByRole('textbox')).toBeNull();
    expect(server.renamed).toEqual([]);
  });

  it('disables Save name for an empty name and for a name over 120 characters, and ties the message to the input', async () => {
    const user = userEvent.setup();
    shown(three());
    const view = within(await open(user));
    await user.click(view.getByRole('button', { name: 'Rename First pass' }));
    const input = view.getByRole('textbox', { name: 'Name of First pass' });
    await user.clear(input);
    expect((view.getByRole('button', { name: 'Save name' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(input);
    await user.paste('n'.repeat(121));
    expect((view.getByRole('button', { name: 'Save name' }) as HTMLButtonElement).disabled).toBe(true);
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described.join(' ')).toContain('A view name is at most 120 characters.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps the input and says the rename failed, in the row’s status line tied to the input, when the rename fails', async () => {
    const user = userEvent.setup();
    shown(three(), { renameView: async () => failure('INTERNAL_ERROR') });
    const view = within(await open(user));
    await user.click(view.getByRole('button', { name: 'Rename First pass' }));
    await user.type(view.getByRole('textbox', { name: 'Name of First pass' }), '!');
    await user.click(view.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(view.getByText("Couldn't rename the view. Try again.")).toBeTruthy());
    const input = view.getByRole('textbox', { name: 'Name of First pass' });
    const error = view.getByText("Couldn't rename the view. Try again.");
    expect(error.getAttribute('role')).toBe('status');
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
    expect((view.getByRole('button', { name: 'Save name' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says the view was renamed elsewhere and shows the list as it is now when the version is stale', async () => {
    const user = userEvent.setup();
    const server = three();
    shown(server);
    const view = within(await open(user));
    await user.click(view.getByRole('button', { name: 'Rename First pass' }));
    server.views[2] = { ...namedView(1, { name: 'Elsewhere', savedBy: { name: 'Avery Quinn' } }), version: 2 };
    await user.type(view.getByRole('textbox', { name: 'Name of First pass' }), '!');
    await user.click(view.getByRole('button', { name: 'Save name' }));
    expect(await view.findByText('This view was renamed elsewhere. The list is updated.')).toBeTruthy();
    expect(view.getByText('Elsewhere')).toBeTruthy();
    expect(view.queryByRole('textbox')).toBeNull();
  });

  it('opens with Enter on Views, takes the focus into the panel, closes on Esc and gives the focus back to Views', async () => {
    const user = userEvent.setup();
    shown(three());
    const button = await control();
    button.focus();
    await user.keyboard('{Enter}');
    const opened = await screen.findByRole('dialog', { name: /^Views/ });
    expect(opened.contains(document.activeElement)).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('walks the buttons of the rows in order with Tab', async () => {
    const user = userEvent.setup();
    shown(three());
    await open(user);
    const names: string[] = [];
    (panel() as HTMLElement).focus();
    for (let press = 0; press < 4; press += 1) {
      await user.tab();
      names.push(document.activeElement?.getAttribute('aria-label') ?? '');
    }
    expect(names).toEqual(['Restore Shared device ring into draft', 'Rename Shared device ring', 'Restore Before expanding the IP address into draft', 'Rename Before expanding the IP address']);
  });

  it('closes on a press outside the panel', async () => {
    const user = userEvent.setup();
    shown(three());
    await open(user);
    await user.click(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
