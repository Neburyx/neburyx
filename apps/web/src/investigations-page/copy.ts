export const PAGE_TITLE = 'Investigations';
export const PAGE_DESCRIPTION = 'Find, open and manage your investigations and saved views.';

export const TABS_LABEL = 'Investigations and saved views';
export const TAB_INVESTIGATIONS = 'Investigations';
export const TAB_SAVED_VIEWS = 'Saved views';
export const TAB_EVIDENCE_PACKS = 'Evidence packs';
export const tabWithCount = (label: string, count: number | undefined): string => (count === undefined ? label : `${label} (${count})`);

export const COLUMN_TITLE = 'Title and referral';
export const COLUMN_ENTITY = 'Starting entity';
export const COLUMN_SOURCE = 'Source';
export const COLUMN_EDITED = 'Last edited (UTC)';
export const COLUMN_COUNTS = 'Entities / relationships';
export const COLUMN_COUNTS_LOADED = ' (loaded)';
export const COLUMN_ACTIONS = 'Actions';
export const TABLE_CAPTION = 'Your investigations, most recently edited first';
export const COUNTS_NOT_AVAILABLE = 'Counts not available';

export const LOADING = 'Loading investigations…';
export const EMPTY = 'No investigations yet. Open one from Home.';
export const GO_HOME = 'Go to Home';
export const NO_MATCH = 'No investigations match these filters.';
export const CLEAR_FILTERS = 'Clear filters';
export const COULD_NOT_READ = 'The investigations could not be read.';
export const TRY_AGAIN = 'Try again';
export const SHOW_MORE = 'Show more';
export const LOADING_MORE = 'Loading…';
export const MORE_FAILED = 'The next investigations could not be read.';
export const showing = (shown: number, matching: number): string => `Showing ${shown} of ${matching}`;

export const FILTERS_LABEL = 'Filter investigations';
export const STATUS_LABEL = 'Status';
export const SOURCE_LABEL = 'Source';
export const ALL_SOURCES = 'All sources';
export const TEXT_LABEL = 'Title or referral';
export const TEXT_PLACEHOLDER = 'Search title or referral';
export const TEXT_TOO_SHORT = 'Type at least 2 characters.';
export const ARCHIVED_HIDDEN = 'Archived investigations are hidden.';
export const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'archived', label: 'Archived' },
] as const;

export const ROW_MENU_BUTTON = (title: string): string => `Actions for ${title}`;
export const ROW_MENU_LABEL = (title: string): string => `Actions for ${title}`;
export const OPEN = 'Open';
export const rowLeft = (title: string, status: 'open' | 'closed' | 'archived'): string => `“${title}” is ${status === 'open' ? 'reopened' : status}. It is no longer in this list.`;

export const SAVED_VIEWS_LABEL = 'Your saved views, newest first';
export const VIEW_NAME = 'View name';
export const VIEW_INVESTIGATION = 'Investigation';
export const VIEW_SAVED_BY = 'Saved by';
export const VIEW_SAVED_AT = 'Saved at (UTC)';
export const NO_VIEWS = 'No named views yet. Save one from an investigation.';
export const VIEWS_FOOTNOTE = 'A named view is a saved copy of exploration state. It never changes; restoring one copies it into your own draft. An evidence pack is a signed, point-in-time record.';
export const openView = (view: string, investigation: string): string => `Open “${view}” in ${investigation}`;
export const viewNotLoaded = (status: 'closed' | 'archived'): string => `This investigation is ${status}. The view was not loaded. Reopen it to restore a view.`;
export const COULD_NOT_READ_VIEWS = 'The saved views could not be read.';

export const EVIDENCE_LOCKED = 'Evidence packs, Enterprise only';
export const EVIDENCE_PANEL = 'Evidence packs are an Enterprise capability. They are not available in this edition.';
