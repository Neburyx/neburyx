import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RightClick } from '../canvas/scene.js';
import { placeholderNode } from '../draft/unmapped.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { loadGraph, show } from './context-menu-kit.js';

afterEach(cleanup);

const isOff = (element: HTMLElement): boolean => (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';

describe('the menu of an item the mapping no longer covers', () => {
  it('names it as unmapped with no stored ID, turns every Expand item off, and keeps Pin and Hide on', () => {
    const state = createClientState();
    const gone = { ...placeholderNode('a', { t: 'type-a', id: 'SECRET-ID' }) };
    loadGraph(state, [gone], []);
    const view = show(state);
    view.rightClick({ target: { kind: 'node', key: elementKey(gone.ref) }, x: 50, y: 60 } satisfies RightClick);
    const menu = screen.getByRole('menu', { name: 'Unmapped item' });
    expect(menu.textContent).not.toContain('SECRET-ID');
    for (const name of ['Expand neighbors', 'Expand by neighbor type', 'Expand by type']) expect(isOff(within(menu).getByRole('menuitem', { name: new RegExp(name) }))).toBe(true);
    expect(isOff(within(menu).getByRole('menuitem', { name: /Pin position/ }))).toBe(false);
    expect(isOff(within(menu).getByRole('menuitem', { name: /Hide from view/ }))).toBe(false);
  });
});
