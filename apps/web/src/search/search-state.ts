/** What a search keeps in the history entry's state, never in the address: the typed text can be a personal value. */
export function searchTextOf(state: unknown): string {
  return typeof state === 'object' && state !== null && 'q' in state && typeof state.q === 'string' ? state.q : '';
}
