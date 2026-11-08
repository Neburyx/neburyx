import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTION, DEFAULT_LAYOUT, LAYOUTS, layoutLabel } from './layout-choice.js';
import { createPresentationStore } from './presentation-state.js';

const store = () => createPresentationStore({ isNode: () => true, isElement: () => true });

describe('the layout choice', () => {
  it('starts as Force, top to bottom, with physics off, and names the four layouts', () => {
    const state = store().view.getState();
    expect([state.layout, state.layoutDirection, state.physics]).toEqual([DEFAULT_LAYOUT, DEFAULT_DIRECTION, false]);
    expect(LAYOUTS.map((layout) => layout.label)).toEqual(['Force', 'Hierarchical', 'Radial', 'Grid']);
    expect(layoutLabel('grid')).toBe('Grid');
  });

  it('goes with the snapshot and comes back with it, and a restore does not move an entity or ask for the view', () => {
    const presentation = store();
    presentation.setPositions(new Map([['n0', { x: 3, y: 4 }]]));
    presentation.setLayout('radial');
    presentation.setLayoutDirection('right');
    presentation.setPhysics(true);
    const snapshot = presentation.snapshot();
    presentation.reset();
    expect([presentation.view.getState().layout, presentation.view.getState().physics]).toEqual(['force', false]);
    presentation.restore(snapshot);
    const state = presentation.view.getState();
    expect([state.layout, state.layoutDirection, state.physics]).toEqual(['radial', 'right', true]);
    expect(state.positions.get('n0')).toEqual({ x: 3, y: 4 });
    expect(state.viewChange).toBeUndefined();
  });

  it('asks for a fit with the positions of a layout run, and not with the positions placed on their own', () => {
    const presentation = store();
    presentation.setPositions(new Map([['n0', { x: 0, y: 0 }]]));
    expect(presentation.view.getState().viewChange).toBeUndefined();
    presentation.applyLayout(new Map([['n0', { x: 9, y: 9 }]]));
    expect(presentation.view.getState().viewChange).toEqual({ show: 'fit' });
    expect(presentation.view.getState().positions.get('n0')).toEqual({ x: 9, y: 9 });
  });
});
