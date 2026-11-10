export const CLOSED_PILL = 'Closed · read-only';
export const ARCHIVED_PILL = 'Archived · read-only';
export const CHANGES_NOT_SAVED_SUFFIX = ' · changes not saved';

export const CLOSED_CHIP = 'Closed';
export const CLOSED_HEADLINE = 'This investigation is closed and read-only.';
export const CLOSED_TEXT = 'Reopen it to make changes. Its named views and notes are kept.';
export const ARCHIVED_CHIP = 'Archived';
export const ARCHIVED_HEADLINE = 'This investigation is archived and read-only.';
export const ARCHIVED_TEXT = 'Archived investigations are hidden from the list by default.';
export const REOPEN = 'Reopen';

export const SOURCE_CHANGED_PILL = 'Read-only';
export const REPOINTED_CHIP = 'Source re-pointed';
export const REPOINTED_HEADLINE = 'This source now points to a different database.';
export const REPOINTED_TEXT = 'An operator must confirm the rebind. This investigation is read-only and runs no source reads.';
export const REMOVED_CHIP = 'Source removed';
export const REMOVED_HEADLINE = 'The source this investigation used is no longer configured.';
export const REMOVED_TEXT = 'You can still see the saved layout. No source reads run.';
export const REMOVED_DELETE_SENTENCE = 'You can delete the investigation.';
export const RENAME_DISABLED_SOURCE = 'Not available while the source has changed.';

export const STANDING_BANNER_ID = 'investigation-read-only';
export const FAILURE_BANNER_ID = 'investigation-lifecycle-failure';
export const FAILURE_CHIP = 'Not changed';
export const FAILURE_TEXT = 'Nothing was changed.';
export const UNKNOWN_OUTCOME_TEXT = 'The change may not have been made. Reload to see.';
export const NETWORK_FAILURE = 'The request could not be sent. Try again.';
export const SCHEMA_FAILURE = 'The answer could not be read. Try again.';
export const RELOAD = 'Reload';

export const MENU_BUTTON_LABEL = 'Investigation menu';
export const MENU_LABEL = 'Investigation actions';
export const RENAME = 'Rename';
export const CLOSE = 'Close';
export const ARCHIVE = 'Archive';
export const RENAME_DISABLED = 'Reopen to rename.';

export const RENAME_TITLE = 'Rename investigation';
export const NAME_LABEL = 'Name';
export const NAME_HINT = "Don't type customer names; others may see this text.";
export const CANCEL = 'Cancel';
export const TITLE_EMPTY = 'Enter a name.';
export const TITLE_TOO_LONG = 'Use 200 characters or fewer.';
export const TITLE_INVALID = 'Remove the characters that cannot be stored.';
export const RENAMING = 'Renaming…';

export const DELETE = 'Delete';
export const DELETE_TITLE = 'Delete this investigation?';
export const DELETE_TEXT = 'It leaves your lists now and can be restored from the Deleted list until its purge date. After that it is deleted for good, with its named views and notes.';
export const DELETE_INVESTIGATION = 'Delete investigation';
export const DELETING = 'Deleting…';
export const investigationDeleted = (until: string): string => `Investigation deleted. Restorable until ${until} UTC.`;
