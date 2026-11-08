import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { elementKey } from '../state/keys.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { createMenuRegistry, stateOf, type MenuContext } from './menu-registry.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edgeRef, key, ref, result } from '../state/test-data.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';

const client = clientWith({ me: me(), sources: [source('a')] });

function load(state: ClientState, nodes: number, edges: number, params = 'seed-1'): void {
  const ids = Array.from({ length: nodes }, (_unused, index) => `n${index}`);
  const links = Array.from({ length: edges }, (_unused, index): [string, string, string] => [`e${index}`, `n${index % nodes}`, `n${(index + 1) % nodes}`]);
  state.bindSource('a');
  state.putResult(key('a', params), result('a', ids, links));
  state.setLoaded([key('a', params)], ids.map((id) => ref('a', 'type-a', id)), links.map(([id]) => edgeRef('a', id)));
}

const scope = () => within(screen.getByRole('group', { name: 'Graph scope' }));

const nodeKeys = (count: number): string[] => Array.from({ length: count }, (_unused, index) => elementKey(ref('a', 'type-a', `n${index}`)));

describe('the graph scope lines with hidden entities', () => {
  it('name the entities hidden from view after the loaded part and count them out of the shown, with a way to show them again', async () => {
    const state = createClientState();
    load(state, 10, 13);
    renderApp('/explore', client, state);
    act(() => state.hide(nodeKeys(3)));
    expect(scope().getAllByText(/./).map((line) => line.textContent)[0]).toBe('10 entities · 13 relationships · loaded · exact · 3 hidden from view · Show 3');
    expect(scope().getByText(/shown/).textContent).toBe('7 shown · more not yet retrieved');
    await userEvent.setup().click(scope().getByRole('button', { name: 'Show 3 hidden entities' }));
    expect(state.presentation.view.getState().hidden.size).toBe(0);
    expect(scope().getAllByText(/./).map((line) => line.textContent)).toEqual(['10 entities · 13 relationships · loaded · exact', '10 shown · more not yet retrieved']);
    expect(scope().queryByRole('button')).toBeNull();
  });

  it('puts the control right after the hidden part, before the relationships that are not drawn', () => {
    const state = createClientState();
    state.bindSource('a');
    state.putResult(key('a'), result('a', ['n0', 'n1'], [['e0', 'n0', 'n9']]));
    state.setLoaded([key('a')], [ref('a', 'type-a', 'n0'), ref('a', 'type-a', 'n1')], [edgeRef('a', 'e0')]);
    renderApp('/explore', client, state);
    act(() => state.hide(nodeKeys(1)));
    expect(scope().getAllByText(/./).map((line) => line.textContent)[0]).toBe('2 entities · 1 relationship · loaded · exact · 1 hidden from view · Show 1 · 1 relationship not drawn (entity not loaded)');
  });

  it('say nothing of hiding, and draw no control, when nothing is hidden, and keep the hidden count when more is loaded', () => {
    const state = createClientState();
    load(state, 4, 3);
    renderApp('/explore', client, state);
    expect(scope().queryByRole('button')).toBeNull();
    act(() => state.hide(nodeKeys(1)));
    act(() => load(state, 6, 5, 'seed-2'));
    expect(scope().getAllByText(/./).map((line) => line.textContent)[0]).toContain('1 hidden from view');
  });

  it('shows them again from the canvas menu, which reads the count and is off at zero', () => {
    const menus = createMenuRegistry();
    registerBuiltInMenuItems(menus);
    const item = menus.view.getState().get('canvas')?.find((candidate) => candidate.id === 'show-hidden');
    const state = createClientState();
    load(state, 4, 3);
    const context: MenuContext = { kind: 'canvas', key: undefined, selection: [], state, canvas: undefined };
    if (item === undefined || item.run === undefined || typeof item.label !== 'function') throw new Error('no such item');
    expect([item.label(context), stateOf(item, context)]).toEqual(['Show hidden entities (0)', 'disabled']);
    state.hide(nodeKeys(2));
    expect([item.label(context), stateOf(item, context)]).toEqual(['Show hidden entities (2)', 'enabled']);
    item.run(context);
    expect(state.presentation.view.getState().hidden.size).toBe(0);
  });
});

describe('the graph scope lines', () => {
  it('read the loaded counts with "loaded · exact" and no number for what is not yet retrieved', () => {
    const state = createClientState();
    load(state, 10, 13);
    renderApp('/explore', client, state);
    expect(scope().getAllByText(/./).map((line) => line.textContent)).toEqual(['10 entities · 13 relationships · loaded · exact', '10 shown · more not yet retrieved']);
  });

  it('read zero counts, still exact, when nothing is loaded, and still no number for the rest', () => {
    renderApp('/explore', client, createClientState());
    expect(scope().getAllByText(/./).map((line) => line.textContent)).toEqual(['0 entities · 0 relationships · loaded · exact', '0 shown · more not yet retrieved']);
  });

  it('use the singular for one entity and one relationship', () => {
    const state = createClientState();
    load(state, 2, 1);
    renderApp('/explore', client, state);
    act(() => load(state, 1, 0, 'seed-2'));
    expect(scope().getByText(/loaded/).textContent).toBe('1 entity · 0 relationships · loaded · exact');
  });

  it('carry a thousands separator from 1,000', () => {
    const state = createClientState();
    load(state, 1200, 3);
    renderApp('/explore', client, state);
    expect(scope().getByText(/loaded/).textContent).toBe('1,200 entities · 3 relationships · loaded · exact');
    expect(scope().getByText(/shown/).textContent).toBe('1,200 shown · more not yet retrieved');
  });

  it('update when the loaded graph is replaced, without a reload', () => {
    const state = createClientState();
    load(state, 10, 13);
    renderApp('/explore', client, state);
    act(() => load(state, 4, 2, 'seed-2'));
    expect(scope().getByText(/loaded/).textContent).toBe('4 entities · 2 relationships · loaded · exact');
    expect(scope().getByText(/shown/).textContent).toBe('4 shown · more not yet retrieved');
  });

  it('show no line about relationships that are not drawn when every relationship has both its entities', () => {
    const state = createClientState();
    load(state, 10, 13);
    renderApp('/explore', client, state);
    expect(scope().queryByText(/not drawn/)).toBeNull();
  });

  it('say on the loaded line, after "exact", that one relationship is not drawn because its entity is not loaded', () => {
    const state = createClientState();
    state.bindSource('a');
    state.putResult(key('a'), result('a', ['n1', 'n2'], [['e1', 'n1', 'n2'], ['e2', 'n1', 'n9']]));
    state.setLoaded([key('a')], [ref('a', 'type-a', 'n1'), ref('a', 'type-a', 'n2')], [edgeRef('a', 'e1'), edgeRef('a', 'e2')]);
    renderApp('/explore', client, state);
    expect(scope().getAllByText(/./).map((line) => line.textContent)).toEqual(['2 entities · 2 relationships · loaded · exact · 1 relationship not drawn (entity not loaded)', '2 shown · more not yet retrieved']);
  });

  it('count several relationships that are not drawn, exactly, and drop the line again when the graph is replaced', () => {
    const state = createClientState();
    state.bindSource('a');
    state.putResult(key('a'), result('a', ['n1'], [['e1', 'n1', 'n8'], ['e2', 'n9', 'n1'], ['e3', 'n8', 'n9']]));
    state.setLoaded([key('a')], [ref('a', 'type-a', 'n1')], [edgeRef('a', 'e1'), edgeRef('a', 'e2'), edgeRef('a', 'e3')]);
    renderApp('/explore', client, state);
    expect(scope().getByText(/not drawn/).textContent).toBe('1 entity · 3 relationships · loaded · exact · 3 relationships not drawn (entity not loaded)');
    act(() => load(state, 3, 2, 'seed-2'));
    expect(scope().queryByText(/not drawn/)).toBeNull();
  });
});
