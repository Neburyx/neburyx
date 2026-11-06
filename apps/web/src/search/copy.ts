export const SEARCH_COPY = {
  title: 'Search results',
  description: 'Your graph stays unchanged.',
  searchLabel: 'Search text',
  searchButton: 'Search',
  sourceLabel: 'Source',
  searching: 'Searching…',
  tooShort: 'Type something to search.',
  noSource: 'No source is configured.',
  loadingSources: 'Loading sources…',
  couldNotReadSources: 'The sources could not be read.',
  couldNotReadProfile: 'The source could not be read.',
  tryAgain: 'Try again',
  groupTitle: 'Exact ID match',
  openInGraph: 'Open in graph',
  emptyTitle: 'No matching entities',
  emptyHint: 'Check the ID or try another indexed property.',
  disabledType: 'Search is disabled for this type',
  openFailed: 'The entity could not be opened.',
} as const;

export const captionOf = (source: string): string => `Searches only configured, indexed properties in ${source}.`;
export const unknownSourceText = (sourceId: string): string => `The source “${sourceId}” is not configured.`;
export const showingResultsFor = (text: string): string => `Showing results for “${text}”.`;

export const TOO_LONG = 'Use at most 200 characters.';
export const NOTHING_SEARCHABLE_MASKED = 'Nothing can be searched while personal data is masked.';
export const NO_SEARCH_PROPERTIES = 'No property of this source is configured for search.';
export const RETRY = 'Retry';
export const GRAPH_UNCHANGED = 'Your graph was not changed.';

/** The seconds a source allows a read, without a trailing zero: 5000 ms is "5", 2500 ms is "2.5". */
const secondsOf = (milliseconds: number): string => String(Number((milliseconds / 1000).toFixed(2)));

export const timedOutText = (timeoutMs: number | undefined): string => (timeoutMs === undefined ? 'Search timed out' : `Search timed out after ${secondsOf(timeoutMs)} s`);
