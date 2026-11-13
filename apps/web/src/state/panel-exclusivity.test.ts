import { describe, expect, it } from 'vitest';
import { createClientState } from './client-state.js';

const open = (state: ReturnType<typeof createClientState>) => {
  const { patternsOpen, filtersOpen, searchOpen } = state.presentation.view.getState();
  return { patternsOpen, filtersOpen, searchOpen };
};

describe('the panels that share the left side of the canvas', () => {
  it('open one at a time: opening Patterns closes Filters and Search', () => {
    const state = createClientState();
    state.presentation.setFiltersOpen(true);
    state.presentation.setPatternsOpen(true);
    expect(open(state)).toEqual({ patternsOpen: true, filtersOpen: false, searchOpen: false });
    state.presentation.setSearchOpen(true);
    state.presentation.setPatternsOpen(true);
    expect(open(state)).toEqual({ patternsOpen: true, filtersOpen: false, searchOpen: false });
  });

  it('close Patterns when Filters or Search opens, by the setter or by the search key', () => {
    const state = createClientState();
    state.presentation.setPatternsOpen(true);
    state.presentation.setFiltersOpen(true);
    expect(open(state)).toEqual({ patternsOpen: false, filtersOpen: true, searchOpen: false });
    state.presentation.setPatternsOpen(true);
    state.presentation.setSearchOpen(true);
    expect(open(state)).toEqual({ patternsOpen: false, filtersOpen: false, searchOpen: true });
    state.presentation.setPatternsOpen(true);
    state.presentation.requestSearch();
    expect(open(state)).toEqual({ patternsOpen: false, filtersOpen: false, searchOpen: true });
  });

  it('keep Patterns open when another source is bound', () => {
    const state = createClientState();
    state.presentation.setPatternsOpen(true);
    state.bindSource('b');
    expect(open(state).patternsOpen).toBe(true);
  });
});
