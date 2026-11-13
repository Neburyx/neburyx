import type { Count } from '@neburyx/contracts';
export const EXPAND_HEADING = 'Expand by neighbor type';
export const NO_STABLE_ID = 'This item cannot be expanded: no stable ID.';
export const NO_RELATIONSHIPS = 'No relationships are mapped for this entity type.';
export const NO_RELATIONSHIPS_FOUND = 'No relationships found for this item.';
export const NO_LONGER_IN_SOURCE = 'This item is no longer in the source.';
export const COUNTS_ARE_OF_RELATIONSHIP_ENDS = 'Counts are of relationship ends.';
export const SEPARATE_READS = 'Pages come from separate reads, and the source may have changed between them.';
export const DUPLICATE_IDS = 'Duplicate relationship IDs in the source.';
export const LOADING_NEIGHBORS = 'Loading neighbors';
export const INVERT_SELECTION = 'Invert selection';
export const SELECT_ALL = 'Select all';
export const CLEAR = 'Clear';
export const RETRY = 'Retry';
export const START_OVER = 'Start over for this type';

export const pageNote = (pageSize: number | undefined): string => `Counts show their quality. Loads the first ${pageSize === undefined ? 'page' : pageSize} per type.`;
export const expandLabel = (count: number, pageSize: number | undefined): string => `Expand ${count} ${count === 1 ? 'type' : 'types'}${pageSize === undefined ? '' : ` (up to ${pageSize} each)`}`;
export const loadMoreLabel = (pageSize: number | undefined): string => `Load ${pageSize === undefined ? 'more' : `${pageSize} more`}`;
export const loadedText = (count: number): string => `${count.toLocaleString('en-US')} loaded`;
export const PAGED_NOTE = 'More can be loaded page by page.';
/** What the notes line says when the filters narrowed an expansion: how many of the node's neighbor types were asked, and of its relationship types when those were narrowed. */
export const narrowedExpansionText = (asked: number, neighborTotal: number, relationships: { readonly asked: number; readonly total: number } | undefined): string =>
  `Expanded with filters: ${asked} of ${neighborTotal} neighbor types${relationships === undefined ? '' : `, ${relationships.asked} of ${relationships.total} relationship types`}.`;

/** What the notes line says when the filters narrowed what the action bar expanded for several entities. */
export const NARROWED_BY_FILTERS = 'Expanded with filters.';

/** What the notes line says when the filters leave nothing to expand for a node; the Expand relationships panel opens beside it. */
export const FILTERS_LEAVE_NOTHING = 'Filters leave no relationship to expand for this entity. Choose types here.';

/** What the notes line says after an expansion of several entities of which some were left no relationship by the filters. */
export const skippedByFiltersText = (count: number): string => `${count} skipped: filters leave them nothing.`;

export const NO_NEIGHBOR_TYPES = 'This item has no mapped neighbor types to expand.';
export const expandingText = (count: number): string => `Expanding ${count} ${count === 1 ? 'item' : 'items'}`;
export const failedBeforeText = (count: number): string => `${count} selected ${count === 1 ? 'node' : 'nodes'} failed to expand before this one.`;
export const cannotExpandText = (count: number): string => `${count} ${count === 1 ? 'item cannot' : 'items cannot'} be expanded: no stable ID.`;
export const PANEL_TITLE = 'Expand relationships';
export const EXPAND_BY_NEIGHBOR_TYPE = 'Expand by neighbor type';
export const EXPAND_BY_TYPE = 'Expand by type';
export const CLOSE_PANEL = 'Close Expand relationships';
export const RELATIONSHIP_TYPE_LABEL = 'Relationship type';
export const ALL_SOURCED_TYPES = 'All sourced types';
export const selectedInFiltersLabel = (count: number): string => `Selected in Filters (${count})`;
export const hiddenByFiltersNote = (count: number): string => `${count} loaded ${count === 1 ? 'entity is' : 'entities are'} hidden by filters.`;
export const SHOW_THESE_TYPES = 'Show these types';
export const NEIGHBOR_TYPES_LABEL = 'Neighbor types';
export const RANK_BY_LABEL = 'Rank by';
export const MOST_RECENT = 'Most recent';
export const RANK_NOTE_TIME = 'Ordered by the observed time, newest first.';
export const RANK_NOTE_MIXED = 'Relationships with no observed time come after the dated ones.';
export const RANK_NOTE_NONE = 'These relationships have no observed time, so they are not ordered by time.';
export const RANK_ORDER_LABEL = 'Order';
export const RANK_DESCENDING = 'Highest first';
export const RANK_ASCENDING = 'Lowest first';
export const rankOptionLabel = (on: 'neighbor' | 'relationship', property: string, neighborName: string): string => (on === 'neighbor' ? `${neighborName}: ${property}` : `Relationship: ${property}`);
export const RANK_NOTE_PROPERTY = 'Ordered by this property. Relationships with no comparable value come last.';
export const FILTERS_LABEL = 'Filters';
export const FILTERS_NONE_OFFERED = 'No property of these types can be filtered. The mapping declares which can.';
export const ADD_FILTER = 'Add filter';
export const CLEAR_FILTERS = 'Clear filters';
export const REMOVE_FILTER = 'Remove filter';
export const FILTER_PROPERTY_LABEL = 'Property';
export const FILTER_OPERATOR_LABEL = 'Operator';
export const FILTER_KIND_LABEL = 'Kind of value';
export const FILTER_VALUE_LABEL = 'Value';
export const FILTER_VALUES_LABEL = 'Values, separated by commas';
export const FILTER_FROM_LABEL = 'From';
export const FILTER_TO_LABEL = 'To';
export const FILTER_OPERATORS: Readonly<Record<'eq' | 'in' | 'between', string>> = { eq: 'is', in: 'is one of', between: 'is between' };
export const filterPropertyOption = (on: 'neighbor' | 'relationship', property: string, neighborName: string): string => (on === 'neighbor' ? `${neighborName}: ${property}` : `Relationship: ${property}`);
export const FILTERS_NOTE = 'Only matching relationships are loaded. A value of another kind than the one you enter does not match.';
export const PERSONAL_DATA_NOT_OFFERED = 'Personal-data properties are not offered while masking is on.';
export const FILTERS_CLEARED_BY_MASK = 'Masking changed, so the filters and the rank on personal data were taken off.';
export const FILTER_ROW_UNAVAILABLE = 'This property is not available for the types now chosen.';
export const NOTHING_MATCHES = 'Nothing matches these filters.';
export const matchingLine = (name: string, matching: string, total: string | undefined): string => `${name}: matching ${matching}${total === undefined ? '' : ` of ${total}`}`;
export const FILTERS_NEED_VALUES = 'Fill in or remove each filter before loading.';
export const PAGE_SIZE_LABEL = 'Page size per type';
export const CHOOSE_A_TYPE = 'Choose at least one neighbor type';
export const PANEL_FOOTNOTE = 'Soft limit · aggregates beyond · bounded pages only.';
export const NO_COUNT_FOR_COMBINATION = 'no count for this combination';
export const loadPerTypeLabel = (pageSize: number): string => `Load ${pageSize} per type`;
export const pageSizeRange = (ceiling: number): string => `Enter a whole number from 1 to ${ceiling}.`;
export const ceilingLoweredText = (ceiling: number): string => `This source allows pages of at most ${ceiling}; the page size is now ${ceiling}.`;
export const leftOutText = (names: readonly string[], relationshipType: string): string => `Left out, because ${relationshipType} does not join ${names.length === 1 ? 'it' : 'them'}: ${names.join(', ')}.`;
export const summaryText = (names: readonly string[], ticked: number, listed: number): string => `${names.length === 0 ? 'None' : names.join(', ')} (${ticked} of ${listed})`;
export const TOTAL_NO_COUNT = 'total: no count';
export const SUPERNODE = 'SUPERNODE';
export const LEFT_OUT_NOTE = 'Relationships the source returned that could not be shown are left out.';
export const loadMoreOverAllLabel = (pageSize: number | undefined): string => `${loadMoreLabel(pageSize)}, over all sourced types`;

export const COLLAPSE = 'Collapse';
/** Shown beside the card's Collapse when it is off. */
export const COLLAPSE_LOADING = 'Collapse is off while this node is loading.';
export const COLLAPSE_NOTHING = 'Nothing was loaded from this node.';

export const STARTING_ENTITY_HINT = 'Select the entity and press E, or right-click it, to load its neighbors';

export const WINDOW_LABEL = 'Time window';
export const WINDOW_ALL_TIME = 'All time';
export const WINDOW_OTHER = 'Other number of days';
export const WINDOW_DAYS_LABEL = 'Days';
export const windowDaysLabel = (days: number): string => (days === 1 ? 'Last day' : `Last ${days} days`);
/** The window as the controls and the result lines say it. */
export const windowText = (window: 'all' | { readonly days: number }): string => (window === 'all' ? WINDOW_ALL_TIME : windowDaysLabel(window.days));
export const WINDOW_UTC = 'UTC';
export const WINDOW_NOTE_ALL = 'Everything is loaded, whenever it was observed.';
export const WINDOW_NOTE_DAYS = 'Only relationships observed in this period are loaded, by the time of each relationship type.';
export const WINDOW_NOTE_NONE = 'None of the relationship types here has a date, so the window does not apply.';
export const windowDatesText = (from: string, to: string): string => {
  const format = (instant: number): string => new Date(instant).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const last = Date.parse(to) - 1;
  return `${format(Date.parse(from))} to ${format(last)} ${WINDOW_UTC}`;
};

/** What a count for a window is a count of, beside its quality: never the entity's total. */
export const windowCountLine = (window: { readonly days: number }, notAppliedTo: readonly string[], countText: string): string =>
  notAppliedTo.length === 0 ? `In the ${windowDaysLabel(window.days).toLowerCase()}: ${countText}` : `In the ${windowDaysLabel(window.days).toLowerCase()} for dated relationships, all time for ${notAppliedTo.join(', ')}: ${countText}`;
export const windowEverythingLoaded = (window: { readonly days: number }): string => `Everything in the ${windowDaysLabel(window.days).toLowerCase()} is loaded. Choose a longer window or All time for more.`;
export const windowNotFilteredText = (types: readonly string[]): string => `Not filtered by date: ${types.join(', ')}.`;
export const WINDOW_SHOW_ALL_TIME = 'Show all time';
/** Said when a window leaves nothing: the window named, by type when the line names the type. */
export const windowEmptyText = (window: { readonly days: number }, typeName?: string): string =>
  typeName === undefined ? `No relationships in the ${windowDaysLabel(window.days).toLowerCase()}.` : `${typeName}: no relationships in the ${windowDaysLabel(window.days).toLowerCase()}.`;
/** The all-time degree beside an empty window, with its own quality; nothing for a count that has no number. */
export function windowAllTimeText(count: Count | undefined): string | undefined {
  if (count === undefined || count.value === undefined) return undefined;
  const noun = count.value === 1 ? 'relationship' : 'relationships';
  const number = count.value.toLocaleString('en-GB');
  switch (count.quality) {
    case 'exact':
      return `${number} ${noun} in all time (exact).`;
    case 'estimated':
      return `~ ${number} (estimated) ${noun} in all time.`;
    case 'lowerBound':
      return `≥ ${number} · lower bound ${noun} in all time.`;
    case 'unknown':
      return undefined;
    default: {
      const unreachable: never = count.quality;
      return unreachable;
    }
  }
}
export const WINDOW_UNDATED_RULE = 'Relationships with no date are not included.';
export const windowUndatedText = (count: number | undefined): string => (count === undefined ? WINDOW_UNDATED_RULE : `${count.toLocaleString('en-GB')} ${count === 1 ? 'relationship' : 'relationships'} with no date ${count === 1 ? 'is' : 'are'} not included.`);
export const WINDOW_NOT_COUNTED = 'The relationships in the window could not be counted.';
export const NOT_LOADED_ALL_TIME = 'all time';
