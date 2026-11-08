import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { elementKey } from '../state/keys.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edgeRef, key, ref, result } from '../state/test-data.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';

const client = clientWith({ me: me(), sources: [source('a')] });

function load(state: ClientState, nodes: number, edges: number): void {
  const ids = Array.from({ length: nodes }, (_unused, index) => `n${index}`);
  const links = Array.from({ length: edges }, (_unused, index): [string, string, string] => [`e${index}`, `n${index % nodes}`, `n${(index + 1) % nodes}`]);
  state.bindSource('a');
  state.putResult(key('a'), result('a', ids, links));
  state.setLoaded([key('a')], ids.map((id) => ref('a', 'type-a', id)), links.map(([id]) => edgeRef('a', id)));
}

const scope = () => within(screen.getByRole('group', { name: 'Graph scope' }));
const lines = () => scope().getAllByText(/./).map((line) => line.textContent);
const nodeKey = (index: number): string => elementKey(ref('a', 'type-a', `n${index}`));

describe('the graph scope lines with focus on', () => {
  it('name the entities outside focus after the loaded part, count them out of the shown, and keep the loaded figures', () => {
    const state = createClientState();
    load(state, 10, 13);
    renderApp('/explore', client, state);
    act(() => state.focusOn(nodeKey(0)));
    expect(lines()[0]).toBe('10 entities · 13 relationships · loaded · exact · 7 outside focus · Leave focus');
    expect(scope().getByText(/shown/).textContent).toBe('3 shown · more not yet retrieved');
  });

  it('leave focus from the button, put the keyboard focus on the canvas, and read as before', async () => {
    const state = createClientState();
    load(state, 10, 13);
    renderApp('/explore', client, state);
    act(() => state.focusOn(nodeKey(0)));
    await userEvent.setup().click(scope().getByRole('button', { name: 'Leave focus' }));
    expect(state.presentation.view.getState().neighborhoodFocus).toBeUndefined();
    expect(lines()).toEqual(['10 entities · 13 relationships · loaded · exact', '10 shown · more not yet retrieved']);
    expect(scope().queryByRole('button')).toBeNull();
    expect(document.activeElement?.getAttribute('data-key-scope')).toBe('canvas');
  });

  it('say nothing of focus, and draw no control, when focus is off', () => {
    const state = createClientState();
    load(state, 4, 3);
    renderApp('/explore', client, state);
    expect(scope().queryByRole('button')).toBeNull();
    expect(lines()[0]).not.toContain('outside focus');
  });

  it('keep the part and the way out at zero entities outside focus', () => {
    const state = createClientState();
    load(state, 2, 1);
    renderApp('/explore', client, state);
    act(() => state.focusOn(nodeKey(0)));
    expect(lines()[0]).toBe('2 entities · 1 relationship · loaded · exact · 0 outside focus · Leave focus');
    expect(scope().getByRole('button', { name: 'Leave focus' })).toBeDefined();
  });

  it('show both parts when entities are hidden too, count a hidden entity outside focus only as hidden, and the shown as loaded less the union', () => {
    const state = createClientState();
    load(state, 10, 13);
    renderApp('/explore', client, state);
    act(() => state.focusOn(nodeKey(0)));
    act(() => state.hide([nodeKey(5), nodeKey(1)]));
    expect(lines()[0]).toBe('10 entities · 13 relationships · loaded · exact · 2 hidden from view · Show 2 · 6 outside focus · Leave focus');
    expect(scope().getByText(/shown/).textContent).toBe('2 shown · more not yet retrieved');
  });

  it('end with the focused entity gone from the loaded entities', () => {
    const state = createClientState();
    load(state, 4, 3);
    renderApp('/explore', client, state);
    act(() => state.focusOn(nodeKey(0)));
    act(() => state.setLoaded([key('a')], [ref('a', 'type-a', 'n1'), ref('a', 'type-a', 'n2')], []));
    expect(scope().queryByRole('button')).toBeNull();
    expect(lines()[0]).toBe('2 entities · 0 relationships · loaded · exact');
  });
});
