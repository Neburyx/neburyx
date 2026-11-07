import type { Count, SearchFailureGroup } from '@neburyx/contracts';

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
  relatedTitle: 'Related records · Referenced ID',
  relatedNote: 'Related records reference the ID; they are not extra exact matches.',
  evidenceTitle: 'Evidence records · Supporting relationships',
  viewEvidence: 'View evidence',
  evidenceDisabled: 'Evidence records are disabled for this relationship',
  evidenceNoStableId: 'Evidence records are not searched for this relationship because it has no stable ID',
  openInGraph: 'Open in graph',
  emptyTitle: 'No matching entities',
  emptyHint: 'Check the ID or try another indexed property.',
  disabledType: 'Search is disabled for this type',
  relatedDisabledType: 'Related records are disabled for this type',
  openFailed: 'The entity could not be opened.',
} as const;

export const captionOf = (source: string): string => `Searches only configured, indexed properties in ${source}.`;
export const unknownSourceText = (sourceId: string): string => `The source “${sourceId}” is not configured.`;
export const REFERENCED_ID = 'Referenced ID';
export const referencesLine = (text: string, properties: readonly string[]): string => (properties.length === 0 ? REFERENCED_ID : `References ${text} in ${properties.join(', ')}`);
export const showingResultsFor = (text: string): string => `Showing results for “${text}”.`;

export const TOO_LONG = 'Use at most 200 characters.';
export const NOTHING_SEARCHABLE_MASKED = 'Nothing can be searched while personal data is masked.';
export const NO_SEARCH_PROPERTIES = 'No property of this source is configured for search.';
export const NO_RELATED_PROPERTIES = 'No property of this source is configured for related records.';
export const NO_EVIDENCE_PROPERTIES = 'No relationship of this source is configured for evidence records.';
export const evidenceRecordsText = (recordIds: readonly string[]): string => `${recordIds.length} ${recordIds.length === 1 ? 'record' : 'records'}: ${recordIds.join(', ')}`;
export const evidenceRuleText = (ruleId: string, ruleVersion: number): string => `Used by rule ${ruleId} v${ruleVersion}`;
export const EXACT_MASKED = 'Exact matches cannot be searched while personal data is masked.';
export const RELATED_MASKED = 'Related records cannot be searched while personal data is masked.';
const PAGE_GROUP_NAMES = { exact: 'Exact matches', related: 'Related records', evidence: 'Evidence records', startsWith: 'Matches that start with the text', facets: 'Facet counts' } as const;
const PAGE_GROUP_NOT_READ = { exact: 'exact matches not read', related: 'related records not read', evidence: 'evidence records not read', startsWith: 'matches that start with the text not read', facets: 'facet counts not read' } as const;
export const groupNotReadSummary = (group: SearchFailureGroup): string => PAGE_GROUP_NOT_READ[group];
export function groupFailedText(group: SearchFailureGroup, code: string, timeoutMs: number | undefined): string {
  const name = PAGE_GROUP_NAMES[group];
  if (code === 'QUERY_TIMEOUT') return timeoutMs === undefined ? `${name} were not read: the source did not answer in time.` : `${name} were not read: the source did not answer within ${secondsOf(timeoutMs)} s.`;
  return `${name} were not read (${code}).`;
}
export const RETRY = 'Retry';

export const FILTERS_COPY = {
  title: 'Filters',
  entityType: 'Entity type',
  matchMode: 'Match mode',
  reset: 'Reset',
  countsNotRead: 'Counts not read',
  unavailable: 'Filters unavailable: counts not read',
  noResultTitle: 'No result for this selection',
  noResultHint: 'Reset the filters to see the matches of the other entries.',
  unshown: 'Matches were found in the source but none could be shown.',
  nothingForTypes: 'Nothing to search for the selected types.',
} as const;
export const MATCH_MODE_LABELS = { exact: 'Exact ID', related: 'Referenced ID', evidence: 'Evidence record' } as const;
export const hiddenBySelection = (group: 'exact' | 'related' | 'evidence'): string => `${PAGE_GROUP_NAMES[group]} are hidden by the selection.`;
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

const GROUP_NAMES = { exact: 'exact ID matches', related: 'related records', evidence: 'evidence records', startsWith: 'matches that start with the text', facets: 'facet counts' } as const;

export const groupNotRead = (group: keyof typeof GROUP_NAMES): string => `${GROUP_NAMES[group]} not read`;

/** The line that stands in place of a group whose read failed: what failed, and that its records were not read. */
export function groupFailureText(group: keyof typeof GROUP_NAMES, code: string, timeoutMs: number | undefined): string {
  const why = code === 'QUERY_TIMEOUT' ? `timed out${timeoutMs === undefined ? '' : ` after ${secondsOf(timeoutMs)} s`}` : code;
  return `The ${GROUP_NAMES[group]} could not be read (${why}), so those records were not read.`;
}

export const ENTITY_NOT_FOUND = 'That entity is not in the source.';
export const ENTITY_NOT_LOADED = 'The entity could not be loaded.';
