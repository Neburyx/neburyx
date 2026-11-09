import type { Count, DisabledType, EvidenceRecord, ExactMatch, SearchFailureGroup, SearchPagedGroup } from '@neburyx/contracts';
import { elementKey } from '../state/keys.js';

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
  openInGraph: 'Open in graph',
  emptyTitle: 'No matching entities',
  emptyHint: 'Check the ID or try another indexed property.',
  openFailed: 'The entity could not be opened.',
} as const;

export const captionOf = (source: string): string => `Searches only configured, indexed properties in ${source}.`;
export const unknownSourceText = (sourceId: string): string => `The source “${sourceId}” is not configured.`;
export const REFERENCED_ID = 'Referenced ID';
export const referencesLine = (text: string, properties: readonly string[]): string => (properties.length === 0 ? REFERENCED_ID : `References ${text} in ${properties.join(', ')}`);
/** The line of an exact hit: the `search` properties that hold the typed text; none when the server could not name one. */
export const matchesLine = (text: string, properties: readonly string[] | undefined): string | undefined => (properties === undefined || properties.length === 0 ? undefined : `Matches ${text} in ${properties.join(', ')}`);
/** The properties of each exact hit by its key, the first entry kept when a later page brings the hit again. */
export function matchedByKey(entries: readonly ExactMatch[]): ReadonlyMap<string, readonly string[]> {
  const byKey = new Map<string, readonly string[]>();
  for (const entry of entries) {
    const key = elementKey(entry.ref);
    if (!byKey.has(key)) byKey.set(key, entry.matchedProperties);
  }
  return byKey;
}
export const showingResultsFor = (text: string): string => `Showing results for “${text}”.`;

export const TOO_LONG = 'Use at most 200 characters.';
export const NOTHING_SEARCHABLE_MASKED = 'Nothing can be searched while personal data is masked. Turn masking off to search personal data.';
export const NO_SEARCH_PROPERTIES = 'No property of this source is configured for search.';
export const NO_RELATED_PROPERTIES = 'No property of this source is configured for related records.';
export const NO_EVIDENCE_PROPERTIES = 'No relationship of this source is configured for evidence records.';
/** What a record whose value is neither text nor a number says, with the property that holds it: never an empty value. */
export const UNREADABLE_VALUE = 'Value cannot be shown';
export const evidenceRecordText = (record: EvidenceRecord): string => ('unreadable' in record ? `${record.property}: ${UNREADABLE_VALUE}` : record.sourceRecordId);
export const evidenceRecordsText = (records: readonly EvidenceRecord[]): string => `${records.length} ${records.length === 1 ? 'record' : 'records'}: ${records.map(evidenceRecordText).join(', ')}`;
/** What an aggregate's members are: relationships with no stable ID, each listed by its element ID, which is never a reference. */
export const AGGREGATE_NOTE = 'No stable ID: each relationship is listed by its element ID and cannot be opened or copied as an ID';
export const membersText = (count: Count): string | undefined => {
  if (count.value === undefined) return undefined;
  if (count.quality === 'exact') return `${count.value} ${count.value === 1 ? 'relationship' : 'relationships'}`;
  return count.quality === 'lowerBound' ? `≥ ${count.value} relationships · lower bound` : undefined;
};
export const memberText = (elementId: string): string => `Element ID ${elementId}`;
export const observedText = (observedAt: string): string => `observed ${observedAt}`;
export const evidenceRuleText = (ruleId: string, ruleVersion: number): string => `Rule ${ruleId} v${ruleVersion} uses this relationship type`;
export const EXACT_MASKED = 'Exact matches cannot be searched while personal data is masked. Turn masking off to search personal data.';
export const RELATED_MASKED = 'Related records cannot be searched while personal data is masked. Turn masking off to search personal data.';
const PAGE_GROUP_NAMES = { exact: 'Exact matches', related: 'Related records', evidence: 'Evidence records', startsWith: 'Matches that start with the text', facets: 'Facet counts', context: 'Relationship context' } as const;
const PAGE_GROUP_NOT_READ = { exact: 'exact matches not read', related: 'related records not read', evidence: 'evidence records not read', startsWith: 'matches that start with the text not read', facets: 'facet counts not read', context: 'relationship context not read' } as const;
export const groupNotReadSummary = (group: SearchFailureGroup): string => PAGE_GROUP_NOT_READ[group];
export function groupFailedText(group: SearchFailureGroup, code: string, timeoutMs: number | undefined): string {
  const name = PAGE_GROUP_NAMES[group];
  if (group === 'context') return code === 'QUERY_TIMEOUT' ? (timeoutMs === undefined ? `${name} not read: the source did not answer in time.` : `${name} not read: the source did not answer within ${secondsOf(timeoutMs)} s.`) : `${name} not read (${code}).`;
  if (code === 'QUERY_TIMEOUT') return timeoutMs === undefined ? `${name} were not read: the source did not answer in time.` : `${name} were not read: the source did not answer within ${secondsOf(timeoutMs)} s.`;
  return `${name} were not read (${code}).`;
}
export const RETRY = 'Retry';

/**
 * The relationship context line of a related record: "<TYPE> <title of the exact match>" for a relationship that leaves the record and "<TYPE> from <title>" for one that enters it, with the
 * type as the source stores it and the title the exact match has in the answer.
 */
export const relationshipContextLine = (relationshipType: string, direction: 'out' | 'in', title: string): string => (direction === 'out' ? `${relationshipType} ${title}` : `${relationshipType} from ${title}`);

/** The line for a type whose pairs the relationship context read left out because its stable-ID index is not online. */
export const contextNotReadLine = (typeName: string): string => `Relationship context not read for ${typeName}`;

const INDEX_GAP_TEXT: Readonly<Record<DisabledType['reason'], string>> = { 'index-unavailable': 'no online index', 'index-building': 'index is building', 'index-failed': 'index failed' };
const NOT_SEARCHED = 'Not searched';
const RELATED_NOT_SEARCHED = 'Not searched for related records';
const NO_PROPERTY_SEARCHED = 'none of its properties';

const propertyGapText = (property: string, reason: DisabledType['reason']): string => `${property}: ${INDEX_GAP_TEXT[reason]}`;

/**
 * One line for each property that was not searched, "Not searched: <type> · <property>: <why>", and one line for a type none of whose properties was searched, naming each property with its reason.
 * `group` says which group the properties belong to.
 */
export function notSearchedLines(entries: readonly DisabledType[], typeName: (entityType: string) => string, group: 'exact' | 'related'): readonly { readonly key: string; readonly text: string }[] {
  const prefix = group === 'exact' ? NOT_SEARCHED : RELATED_NOT_SEARCHED;
  const wholeTypes = [...new Set(entries.filter((entry) => !entry.typeSearched).map((entry) => entry.entityType))];
  const whole = wholeTypes.map((entityType) => {
    const gaps = entries.filter((entry) => entry.entityType === entityType).map((entry) => propertyGapText(entry.property, entry.reason));
    return { key: entityType, text: `${prefix}: ${typeName(entityType)}, ${NO_PROPERTY_SEARCHED} · ${gaps.join(' · ')}` };
  });
  const partial = entries.filter((entry) => entry.typeSearched).map((entry) => ({ key: `${entry.entityType}:${entry.property}`, text: `${prefix}: ${typeName(entry.entityType)} · ${propertyGapText(entry.property, entry.reason)}` }));
  return [...whole, ...partial];
}

/** An evidence property that was not searched: "Not searched: <relationship> (<from> → <to>) · <property>: <why>". */
export const evidenceNotSearchedText = (relationship: string, property: string, reason: DisabledType['reason']): string => `${NOT_SEARCHED}: ${relationship} · ${propertyGapText(property, reason)}`;

/** What a hit with no usable stable ID says: it is listed, and nothing can be done with it. */
export const UNREFERENCED_TEXT = 'No usable stable ID: this item cannot be opened or added';
/** The accessible name of such a hit: its title and type, and why it cannot be opened or added. */
export const unreferencedLabel = (title: string, type: string): string => `${title}, ${type}: ${UNREFERENCED_TEXT}`;

export const MORE_COPY = {
  showMore: 'Show more',
  loadingMore: 'Loading more…',
  invalidated: 'This page of results is no longer valid. Search again to see the rest.',
  searchAgain: 'Search again',
} as const;
/** The accessible name of Show more under a group: what it reads more of. */
export const showMoreLabel = (group: SearchPagedGroup): string => `${MORE_COPY.showMore}: ${PAGE_GROUP_NAMES[group]}`;
/** The line that says the next page of a group could not be read: the group's hits stay. */
export function moreFailedText(group: SearchPagedGroup, code: string, timeoutMs: number | undefined): string {
  const name = PAGE_GROUP_NAMES[group];
  if (code === 'QUERY_TIMEOUT') return timeoutMs === undefined ? `More ${name.toLowerCase()} were not read: the source did not answer in time.` : `More ${name.toLowerCase()} were not read: the source did not answer within ${secondsOf(timeoutMs)} s.`;
  return `More ${name.toLowerCase()} were not read (${code}).`;
}

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

/** What is said when a find or an add switched an entity type on that a filter had switched off. */
export const shownByFiltersText = (typeName: string): string => `${typeName} shown again by the filters`;

const GROUP_NAMES = { exact: 'exact ID matches', related: 'related records', evidence: 'evidence records', startsWith: 'matches that start with the text', facets: 'facet counts', context: 'relationship context' } as const;

export const groupNotRead = (group: keyof typeof GROUP_NAMES): string => `${GROUP_NAMES[group]} not read`;

/** The line that stands in place of a group whose read failed: what failed, and that its records were not read. */
export function groupFailureText(group: keyof typeof GROUP_NAMES, code: string, timeoutMs: number | undefined): string {
  const why = code === 'QUERY_TIMEOUT' ? `timed out${timeoutMs === undefined ? '' : ` after ${secondsOf(timeoutMs)} s`}` : code;
  return `The ${GROUP_NAMES[group]} could not be read (${why}), so those records were not read.`;
}

export const ENTITY_NOT_FOUND = 'That entity is not in the source.';
export const ENTITY_NOT_LOADED = 'The entity could not be loaded.';
