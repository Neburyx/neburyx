import { createStore, readable, type ReadableStore } from '../state/store.js';

/**
 * Where the tour is. `step` is 0-based. `opening` is the moment after "Next" on the first step while the demo case opens;
 * `waiting` is an install with no demo case, where the tour holds at the second step until an investigation opens.
 */
export type TourState =
  | { readonly mode: 'off' }
  | { readonly mode: 'step'; readonly step: number }
  | { readonly mode: 'opening' }
  | { readonly mode: 'waiting' };

const OFF: TourState = { mode: 'off' };

const store = createStore<TourState>(OFF);

/** One tour per page. A small module store, so the Help menu can start it without any other part of the app knowing it. */
export const tourState: ReadableStore<TourState> = readable(store);

export function startTour(): void {
  store.setState({ mode: 'step', step: 0 });
}

export function showStep(step: number): void {
  store.setState({ mode: 'step', step });
}

export function openingDemo(): void {
  store.setState({ mode: 'opening' });
}

export function waitForInvestigation(): void {
  store.setState({ mode: 'waiting' });
}

export function endTour(): void {
  store.setState(OFF);
}
