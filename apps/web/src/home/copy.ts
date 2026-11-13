export const HOME_COPY = {
  title: 'Investigations',
  description: 'Resume recent work, or start from a search.',
  viewAll: 'View all',
  recentTitle: 'Recent',
  loading: 'Loading recent investigations…',
  tryAgain: 'Try again',
  couldNotRead: 'Recent investigations could not be read.',
} as const;

export const RECENT_LIMIT = 5;

export const MORE_THAN_SHOWN = `Showing the ${RECENT_LIMIT} most recent.`;

export const CASE_REFERENCE_LABEL = 'Case reference';
export const LAST_EDITED = 'Last edited';
export const UNSAVED = 'Unsaved';
export const savedBadge = (clock: string): string => `Saved · ${clock} UTC`;
export const sourceStateNote = (state: string, reason: string | null): string => `${state === 'unknown' ? 'Source state unknown' : `Source ${state}`}${reason === null ? '' : ` · ${reason}`}`;

export const SEARCH_PLACEHOLDER = 'Search an entity or ID';

export const OPEN_LINK_ACTION = 'Open a deep link';
export const OPEN_DEMO_CASE_ACTION = 'Open the demo case';

export const HEALTH_COPY = {
  title: 'Source health',
  viewSources: 'View sources →',
} as const;

export const LIBRARY_COPY = {
  label: 'Library',
  investigations: 'Investigations',
  savedViews: 'Saved views',
  patterns: 'Patterns',
  approvedPatterns: 'Approved, no query language',
  loading: 'Loading…',
  notRead: 'Not read',
  acrossSources: (count: number): string => `Across ${count} ${count === 1 ? 'source' : 'sources'}`,
  lastEdited: (clock: string): string => `Last edited ${clock} UTC`,
} as const;

export const PATTERN_CARD_COPY = {
  title: 'Start from a pattern',
  run: 'Run →',
  runLabel: (name: string): string => `Run ${name}`,
  noPatterns: 'This source has no patterns.',
  loading: 'Loading patterns…',
  chooseSource: 'Choose a source to see its patterns.',
  sourceLabel: 'Patterns for',
  sourcePlaceholder: 'Choose a source',
  notConfigured: (sourceId: string): string => `${sourceId} is not configured, so its patterns cannot be listed.`,
  couldNotRead: (source: string): string => `The patterns of ${source} could not be read.`,
  tryAgain: 'Try again',
} as const;
