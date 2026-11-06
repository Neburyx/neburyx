import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { node } from '../state/test-data.js';
import { createClientState } from '../state/client-state.js';
import { builtInKeyBindings, renderApp, stubFactory } from '../test-utils.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { createToolRegistry } from '../workspace/tool-registry.js';
import { registerBuiltInTools } from '../workspace/built-in-tools.js';
import { answerOf, hit, searchKit, searchAt } from './search-test-kit.js';

const kit = () => searchKit(['demo'], async () => ({ ok: true, value: answerOf('demo', [hit('demo', 'AC-1')]) }));
const press = (target: Element | Document, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
};
const searchKey = (target: Element | Document = document.body, init: KeyboardEventInit = {}) => press(target, 'k', { metaKey: true, ...init });
async function box(): Promise<HTMLInputElement> {
  const found = await screen.findByRole('searchbox', { name: 'Search text' });
  if (!(found instanceof HTMLInputElement)) throw new Error('the search box is not an input');
  return found;
}

function workspace(state = createClientState()) {
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  return renderApp('/explore', kit().client, state, slots, stubFactory().create, undefined, tools);
}

describe('⌘K from every page', () => {
  it.each(['/', '/investigations', '/sources'])('opens the search page from %s with the box focused', async (path) => {
    const view = renderApp(path, kit().client);
    await screen.findByRole('main');
    expect(searchKey().defaultPrevented).toBe(true);
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/search'));
    expect(await box()).toBe(document.activeElement);
  });

  it('focuses the box and selects its text on the search page, without a new entry in the history', async () => {
    const view = renderApp(searchAt('demo', 'AC-1'), kit().client);
    const input = await box();
    await screen.findByText('Title AC-1');
    within(screen.getByRole('main')).getByRole('button', { name: 'Search' }).focus();
    const before = view.router.state.location;
    searchKey();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('AC-1'.length);
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe(before.pathname + before.search);
    expect(view.router.state.historyAction).toBe('REPLACE');
  });

  it('opens the search page from the workspace and leaves the open investigation as it was, and going back returns to it', async () => {
    const state = createClientState();
    loadGraph(state, [node('a', 'n1')], []);
    const shown = state.investigation.getState();
    const view = workspace(state);
    await screen.findByRole('application', { name: 'Graph canvas' });
    searchKey();
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/search'));
    expect(state.investigation.getState()).toBe(shown);
    await act(() => view.router.navigate(-1));
    expect(view.router.state.location.pathname).toBe('/explore');
    expect(state.investigation.getState()).toBe(shown);
    expect(state.loadedGraph().nodes).toHaveLength(1);
  });
});

describe('where ⌘K works and where it does not', () => {
  it('is left to the browser while the focus is in a text field, which keeps its text', async () => {
    const view = renderApp('/sources', kit().client);
    await screen.findByRole('main');
    const field = document.createElement('input');
    field.value = 'half a thought';
    document.body.append(field);
    field.focus();
    expect(searchKey(field).defaultPrevented).toBe(false);
    expect(view.router.state.location.pathname).toBe('/sources');
    expect(field.value).toBe('half a thought');
    field.remove();
  });

  it('is left to the browser in the open search box, which keeps its text, and opens no second page', async () => {
    const view = renderApp(searchAt('demo', 'AC-1'), kit().client);
    const input = await box();
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard('x');
    expect(searchKey(input).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('AC-1x');
    expect(view.router.state.location.pathname).toBe('/search');
  });

  it('does nothing in a menu or a dialog that holds the focus, and the key is left to the browser', async () => {
    const state = createClientState();
    loadGraph(state, [node('a', 'n1')], []);
    const view = workspace(state);
    await screen.findByRole('application', { name: 'Graph canvas' });
    press(document.body, '/', { metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(searchKey(dialog).defaultPrevented).toBe(false);
    expect(view.router.state.location.pathname).toBe('/explore');
  });

  it('does not run again for a key that is held down, so the page opens once', async () => {
    const view = renderApp('/sources', kit().client);
    await screen.findByRole('main');
    searchKey(document.body, { repeat: true });
    expect(view.router.state.location.pathname).toBe('/sources');
  });

  it('leaves every other binding where it was: they stay inactive in a text field and outside their scope', async () => {
    const state = createClientState();
    loadGraph(state, [node('a', 'n1')], []);
    workspace(state);
    await screen.findByRole('application', { name: 'Graph canvas' });
    const before = state.presentation.view.getState().tool;
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    expect(press(field, 'h').defaultPrevented).toBe(false);
    expect(state.presentation.view.getState().tool).toBe(before);
    field.remove();
  });
});

describe('the registered key', () => {
  it('is one binding, "Search" in the tools group, shown as ⌘K on a Mac and Ctrl+K elsewhere, and the sheet lists that and no other', async () => {
    const keys = builtInKeyBindings('other');
    const state = createClientState();
    const slots = createSlotRegistry();
    registerBuiltInSlots(slots);
    const tools = createToolRegistry();
    registerBuiltInTools(tools);
    renderApp('/explore', kit().client, state, slots, stubFactory().create, undefined, tools, undefined, undefined, keys);
    await screen.findByRole('application', { name: 'Graph canvas' });
    const search = keys.view.getState().filter((binding) => binding.id === 'search');
    expect(search).toHaveLength(1);
    expect(search[0]).toMatchObject({ label: 'Search', group: 'tools', keys: ['mod+k'], shown: ['Ctrl+K'] });
    press(document.body, '/', { ctrlKey: true });
    const rows = [...(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).querySelectorAll('.sheet-row')].filter((row) => row.querySelector('.sheet-label')?.textContent === 'Search');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector('.sheet-key')?.textContent).toBe('Ctrl+K');
  });

  it('works from the registry whose key the sheet lists: pressing the listed key opens the page', async () => {
    const view = renderApp('/investigations', kit().client);
    await screen.findByRole('main');
    const [binding] = view.keyBindings.view.getState().filter((candidate) => candidate.id === 'search');
    expect(binding?.shown).toEqual(['⌘K']);
    searchKey();
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/search'));
  });
});

describe('the page shell and the keys of the workspace', () => {
  it('runs only the keys of the app scope on a page: the tool and selection keys do nothing there, and the Search key opens the page', async () => {
    const state = createClientState();
    const view = renderApp('/', kit().client, state);
    await screen.findByRole('main');
    const tool = state.presentation.view.getState().tool;
    for (const key of ['v', 'h', 'b']) expect(press(document.body, key).defaultPrevented).toBe(false);
    expect(press(document.body, 'a', { metaKey: true }).defaultPrevented).toBe(false);
    expect(state.presentation.view.getState().tool).toBe(tool);
    searchKey();
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/search'));
  });

  it('runs the Search key from the page shell through the one registry, with no second keydown listener on the document', async () => {
    const spy = vi.spyOn(document, 'addEventListener');
    try {
      renderApp('/sources', kit().client);
      await screen.findByRole('main');
      expect(spy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
