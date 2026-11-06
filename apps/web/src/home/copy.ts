export const HOME_COPY = {
  title: 'Investigations',
  description: 'Resume recent work, or start from a search.',
  recentTitle: 'Recent',
  loading: 'Loading recent investigations…',
  empty: 'No recent investigations.',
  tryAgain: 'Try again',
  couldNotRead: 'Recent investigations could not be read.',
} as const;

export const RECENT_LIMIT = 5;

export const MORE_THAN_SHOWN = `Showing the ${RECENT_LIMIT} most recent.`;

export const RECENT_NOTE = 'An investigation opens with its starting entity. Entities added later are kept until the page is reloaded.';
export const CASE_REFERENCE_LABEL = 'Case reference';
export const CREATED = 'Created';
export const UNSAVED = 'Unsaved';
export const SOURCE_NO_LONGER_AVAILABLE = 'Source no longer available as it was';
export const savedBadge = (clock: string): string => `Saved · ${clock} UTC`;
export const sourceStateNote = (state: string, reason: string | null): string => `${state === 'unknown' ? 'Source state unknown' : `Source ${state}`}${reason === null ? '' : ` · ${reason}`}`;

export const SEARCH_PLACEHOLDER = 'Search an entity or ID';

export const OPEN_LINK_ACTION = 'Open a deep link';

export const HEALTH_COPY = {
  title: 'Source health',
  viewSources: 'View sources →',
} as const;
