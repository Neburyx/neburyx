import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseEnd, okPaths, openPaths, pathsWorkspace, settle } from './paths-kit.js';
import { elementKey } from '../state/keys.js';
import { nodeRef } from './paths-kit.js';
import { searchOf } from '../patterns/search-kit.js';
import { typedNode } from '../workspace/filters-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const find = (): HTMLElement => screen.getByRole('button', { name: 'Find paths' });

describe('the Paths tool and its panel', () => {
  it('opens the panel from the tool strip, closes it from the strip and returns the focus to the entry', async () => {
    await pathsWorkspace();
    await openPaths();
    expect(screen.getByRole('heading', { name: 'Bounded path search' })).toBeTruthy();
    const entry = screen.getByRole('button', { name: 'Paths' });
    fireEvent.click(entry);
    await settle();
    expect(screen.queryByRole('heading', { name: 'Bounded path search' })).toBeNull();
    const reopened = await (async () => (await openPaths(), screen.getByRole('button', { name: 'Close Paths' })))();
    fireEvent.click(reopened);
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Paths' }));
  });

  it('shows the fields with their defaults, the relationship types all allowed, and the timeout of the source', async () => {
    await pathsWorkspace({ timeoutMs: 5000 });
    await openPaths();
    expect((screen.getByLabelText('Max hops') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Direction') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Either');
    expect((screen.getByLabelText('Result cap') as HTMLInputElement).value).toBe('5');
    const types = within(screen.getByRole('group', { name: 'Allowed relationships' }));
    expect((types.getByRole('checkbox', { name: 'link-a' }) as HTMLInputElement).checked).toBe(true);
    expect((types.getByRole('checkbox', { name: 'link-b' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('5 s timeout')).toBeTruthy();
  });

  it('starts the hops at the source maximum when that is lower than 3', async () => {
    await pathsWorkspace({ maxHops: 2 });
    await openPaths();
    await settle();
    expect((screen.getByLabelText('Max hops') as HTMLInputElement).value).toBe('2');
  });

  it('offers the selected entities first among the loaded ones', async () => {
    const kit = await pathsWorkspace();
    act(() => kit.state.presentation.select([elementKey(nodeRef('acc-2'))]));
    await openPaths();
    const options = within(screen.getByLabelText('From')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Choose an entity', 'acc-2', 'acc-1', 'dev-1']);
  });

  it('sends one search with the values of the fields, and lists the paths under the summary', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2'], ['acc-1', 'dev-1', 'acc-2']]) }) });
    await openPaths();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'out' } });
    await userEvent.click(within(screen.getByRole('group', { name: 'Allowed relationships' })).getByRole('checkbox', { name: 'link-b' }));
    await userEvent.click(find());
    await settle();
    expect(kit.sent.map((entry) => entry.request)).toEqual([{ sourceId: 'a', from: { entityType: 'kind-a', stableId: 'acc-1' }, to: { entityType: 'kind-a', stableId: 'acc-2' }, relTypes: ['link-a'], maxHops: 3, limit: 5, direction: 'out' }]);
    expect(screen.getByText('2 paths · 0.42 s · cap not reached')).toBeTruthy();
    const list = within(screen.getByRole('list', { name: 'Paths found' }));
    expect(list.getByRole('heading', { name: 'Path 1 · 1 hop' })).toBeTruthy();
    expect(list.getByRole('heading', { name: 'Path 2 · 2 hops' })).toBeTruthy();
    expect(list.getAllByText('acc-1 → acc-2').length).toBeGreaterThan(0);
  });

  it('says the cap was reached when the answer says so, and sends the mask of the session', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2']], { capReached: true }) }) });
    act(() => kit.state.setMask(true));
    await openPaths();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    await userEvent.click(find());
    await settle();
    expect(kit.sent[0]?.request.mask).toBe(true);
    expect(screen.getByText('1 path · 0.42 s · cap reached')).toBeTruthy();
  });

  it('disables Find paths with the reason, and sends nothing, for an empty end, the same entity twice and no relationship type', async () => {
    const kit = await pathsWorkspace();
    await openPaths();
    expect((find() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose where the paths start.')).toBeTruthy();
    chooseEnd('From', 'acc-1');
    expect(screen.getByText('Choose where the paths end.')).toBeTruthy();
    chooseEnd('To', 'acc-1');
    expect(screen.getByText('Choose two different entities.')).toBeTruthy();
    chooseEnd('To', 'acc-2');
    const types = within(screen.getByRole('group', { name: 'Allowed relationships' }));
    await userEvent.click(types.getByRole('checkbox', { name: 'link-a' }));
    await userEvent.click(types.getByRole('checkbox', { name: 'link-b' }));
    expect(screen.getByText('Choose at least one relationship type.')).toBeTruthy();
    expect((find() as HTMLButtonElement).disabled).toBe(true);
    expect(kit.sent).toEqual([]);
  });

  it('says no path was found within the hops, and shows no list, for an answer with no paths', async () => {
    await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([]) }) });
    await openPaths();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    await userEvent.click(find());
    await settle();
    expect(screen.getByText('No path found within 3 hops.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Paths found' })).toBeNull();
  });

  it('keeps the loaded graph, the fields and the previous list when a search fails, and tries again on Retry', async () => {
    let answers = 0;
    const kit = await pathsWorkspace({ find: async () => (answers++ === 0 ? { ok: true, value: okPaths([['acc-1', 'acc-2']]) } : answers === 2 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: okPaths([['acc-1', 'acc-2']]) }) });
    await openPaths();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    await userEvent.click(find());
    await settle();
    const loaded = kit.state.loadedGraph().nodes.length;
    await userEvent.click(find());
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('The search could not be completed.');
    expect(screen.getByRole('list', { name: 'Paths found' })).toBeTruthy();
    expect((screen.getByLabelText('From') as HTMLSelectElement).value).toBe(elementKey(nodeRef('acc-1')));
    expect(kit.state.loadedGraph().nodes).toHaveLength(loaded);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(kit.sent).toHaveLength(3);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('adds nothing to the loaded graph for a search, and is operable by keyboard: every field in order, Enter on Find paths, Esc closing the panel', async () => {
    const kit = await pathsWorkspace();
    const before = kit.state.loadedGraph().nodes.length;
    await openPaths();
    const user = userEvent.setup();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    const order = ['From', 'Search the source: From', 'To', 'Search the source: To', 'Max hops', 'Direction', 'Result cap'];
    screen.getByLabelText('From').focus();
    for (const label of order.slice(1)) {
      await user.tab();
      expect(document.activeElement).toBe(screen.getByLabelText(label));
    }
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'link-a' }));
    find().focus();
    await user.keyboard('{Enter}');
    await settle();
    expect(kit.sent).toHaveLength(1);
    expect(kit.state.loadedGraph().nodes).toHaveLength(before);
    fireEvent.keyDown(screen.getByLabelText('From'), { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Bounded path search' })).toBeNull();
  });
});

describe('searching the source for an end', () => {
  it('searches over every entity type after the pause, with the mask of the session, offers the hits with their type, and chooses one without adding it to the graph', async () => {
    const hit = typedNode('far-1', 'kind-c');
    const kit = await pathsWorkspace({ search: () => searchOf([hit]) });
    act(() => kit.state.setMask(true));
    const before = kit.state.loadedGraph().nodes.length;
    await openPaths();
    fireEvent.change(screen.getByLabelText('Search the source: From'), { target: { value: 'far' } });
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 300))));
    await settle();
    expect(kit.searches).toEqual([{ sourceId: 'a', text: 'far', mask: true }]);
    expect(within(screen.getByLabelText('From')).getByRole('option', { name: 'far-1 (kind-c)' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: elementKey(hit.ref) } });
    chooseEnd('To', 'acc-2');
    await userEvent.click(find());
    await settle();
    expect(kit.sent[0]?.request.from).toEqual({ entityType: 'kind-c', stableId: 'far-1' });
    expect(kit.state.loadedGraph().nodes).toHaveLength(before);
  });

  it('keeps the chosen entity when the text is cleared, and shows only the answer to the newest text', async () => {
    const hit = typedNode('far-1', 'kind-c');
    let release: (() => void) | undefined;
    const kit = await pathsWorkspace({
      search: (request) => (request.text === 'f' ? new Promise((resolve) => (release = () => resolve(searchOf([typedNode('old-1', 'kind-c')])))) : searchOf([hit])),
    });
    await openPaths();
    fireEvent.change(screen.getByLabelText('Search the source: From'), { target: { value: 'f' } });
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 300))));
    fireEvent.change(screen.getByLabelText('Search the source: From'), { target: { value: 'far' } });
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 300))));
    await settle();
    release?.();
    await settle();
    const options = within(screen.getByLabelText('From')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toContain('far-1 (kind-c)');
    expect(options.some((text) => text?.startsWith('old-1'))).toBe(false);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: elementKey(hit.ref) } });
    fireEvent.change(screen.getByLabelText('Search the source: From'), { target: { value: '' } });
    await settle();
    expect((screen.getByLabelText('From') as HTMLSelectElement).value).toBe(elementKey(hit.ref));
    expect(kit.searches.length).toBe(2);
  });

  it('keeps the fields and says the search failed when the search of the source fails', async () => {
    await pathsWorkspace({ search: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    await openPaths();
    chooseEnd('To', 'acc-2');
    fireEvent.change(screen.getByLabelText('Search the source: From'), { target: { value: 'far' } });
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 300))));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('The search could not be completed.');
    expect((screen.getByLabelText('To') as HTMLSelectElement).value).toBe(elementKey(nodeRef('acc-2')));
  });
});
