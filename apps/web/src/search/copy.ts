import type { Count } from '@neburyx/contracts';

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
export const secondsOf = (milliseconds: number): string => String(Number((milliseconds / 1000).toFixed(2)));

export const timedOutText = (timeoutMs: number | undefined): string => (timeoutMs === undefined ? 'Search timed out' : `Search timed out after ${secondsOf(timeoutMs)} s`);

export const SEARCH_PANEL_COPY = {
  title: 'Search',
  close: 'Close Search',
  tabsLabel: 'Search',
  onCanvasLabel: 'On canvas',
  onCanvasBoxLabel: 'Find on canvas',
  onCanvasHint: 'Type part of a title, type or ID.',
  onCanvasNone: 'No loaded item matches.',
  addLabel: 'Add from source',
  addBoxLabel: 'Find in the source',
  noInvestigation: 'Open an investigation to search its source.',
} as const;

export const onCanvasTabText = (entities: number): string => `${SEARCH_PANEL_COPY.onCanvasLabel} · ${entities}`;
export const selectedNote = (title: string): string => `Selected ${title}.`;

export const ADD_COPY = {
  searching: 'Searching…',
  footnote: 'Adding loads one entity. Its neighbors stay unloaded until you expand it.',
  add: 'Add',
  adding: 'Adding…',
  onCanvas: 'On canvas',
  noIndexAvailable: 'No index is available for these types.',
  exactGroup: 'Exact ID matches',
  startsWithGroup: 'Starts with the text',
} as const;

/** The count of the exact group as the tab says it: "1 exact ID match", or "≥ 25 exact ID matches · lower bound"; nothing for a quality the group never has. */
export function exactIdText(count: Count): string | undefined {
  if (count.value === undefined) return undefined;
  const noun = count.value === 1 ? 'match' : 'matches';
  if (count.quality === 'exact') return `${count.value} exact ID ${noun}`;
  return count.quality === 'lowerBound' ? `≥ ${count.value} exact ID matches · lower bound` : undefined;
}

/** The count of the startsWith group: "2 start with the text", or "≥ 10 start with the text · lower bound". It is never added to the exact count. */
export function startsWithText(count: Count): string | undefined {
  if (count.value === undefined) return undefined;
  if (count.quality === 'exact') return `${count.value} start with the text`;
  return count.quality === 'lowerBound' ? `≥ ${count.value} start with the text · lower bound` : undefined;
}

export const addedNote = (title: string): string => `Added ${title}.`;

const GROUP_NAMES = { exact: 'exact ID matches', startsWith: 'matches that start with the text' } as const;

export const groupNotRead = (group: keyof typeof GROUP_NAMES): string => `${GROUP_NAMES[group]} not read`;

/** The line that stands in place of a group whose read failed: what failed, and that its records were not read. */
export function groupFailureText(group: keyof typeof GROUP_NAMES, code: string, timeoutMs: number | undefined): string {
  const why = code === 'QUERY_TIMEOUT' ? `timed out${timeoutMs === undefined ? '' : ` after ${secondsOf(timeoutMs)} s`}` : code;
  return `The ${GROUP_NAMES[group]} could not be read (${why}), so those records were not read.`;
}

export const ENTITY_NOT_FOUND = 'That entity is not in the source.';
export const ENTITY_NOT_LOADED = 'The entity could not be loaded.';
