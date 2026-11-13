import { PATTERN_LIMITS, type PATTERN_UNAVAILABLE_CODES } from '@neburyx/contracts';
import type { ApiFailure } from '../../api/client.js';

export const TABS = ['mine', 'shared', 'built-in'] as const;
export type Tab = (typeof TABS)[number];

export const SAVED_COPY = {
  tabs: 'Patterns',
  mine: 'My patterns',
  shared: 'Shared on this source',
  builtIn: 'Built-in',
  footnote: 'A saved pattern stores the pattern and its parameters, never query text. Running it applies your own access and limits.',
  loading: 'Loading saved patterns…',
  emptyMine: 'You have no saved patterns. Choose New pattern to build one.',
  emptyShared: 'Nobody has shared a pattern on this source.',
  retry: 'Retry',
  loadMore: 'Load more',
  cursorReset: 'The list changed while you were reading it, so it was read again from the start.',
  notRun: 'Not run yet',
  builtInKind: 'Built in this panel',
  onlyMe: 'Only me',
  everyone: 'Everyone on this source',
  unavailable: 'Unavailable',
  run: 'Run',
  menu: 'More',
  rename: 'Rename',
  copy: 'Copy',
  delete: 'Delete',
  share: 'Share',
  unshare: 'Unshare',
  change: 'Change',
  cancel: 'Cancel',
  name: 'Name',
  newName: 'New name',
  saveButton: 'Save pattern',
  saveDialog: 'Save pattern',
  saveText: 'Saves the pattern and its parameters, never query text. Running it applies your own access and limits.',
  askEachTime: 'Ask for the starting entity each time',
  keepsEntity: 'The pattern keeps the starting entity it holds.',
  askEachTimeForced: 'No starting entity is chosen, so the pattern will ask for one each time.',
  visibility: 'Visibility',
  saved: 'Pattern saved.',
  savedNotShared: 'Pattern saved, but not shared.',
  renamed: 'Pattern renamed.',
  copied: 'Pattern copied.',
  sharedDone: 'Pattern shared with everyone on this source.',
  unsharedDone: 'Pattern is private again.',
  deleted: 'Pattern deleted.',
  shareConfirm: 'Everyone on this source will be able to run and copy this pattern. They cannot change or delete it.',
  shareTitle: 'Share this pattern?',
  deleteTitle: 'Delete this pattern?',
  deleteConfirmPrivate: 'The pattern is deleted and cannot be run again.',
  deleteConfirmShared: 'Everyone on this source loses this pattern.',
  renameTitle: 'Rename pattern',
  saving: 'Saving…',
  working: 'Working…',
  runFirst: 'Choose the starting entity to run this pattern.',
  saveBlockedNeedValid: 'Build a valid pattern to save it.',
  changedByOther: 'The pattern changed since you read the list, so the list was read again. Nothing was overwritten.',
  gone: 'The pattern is not there any more, so the list was read again.',
  notAllowed: 'Only the person who made a shared pattern can do that, so the list was read again.',
  summary: 'The path of the pattern',
  changeTitle: 'Change pattern',
  saveChanges: 'Save changes',
  saveAsNew: 'Save as new',
  changeUnplaced: 'This part of the pattern cannot be shown because the mapping no longer has it.',
  changeLine: 'Changing a saved pattern. Save changes keeps it where it is; Save as new makes another.',
} as const;

export const nameLimitText = `Enter a name of 1 to ${PATTERN_LIMITS.nameLength} characters.`;

/** The reasons a saved pattern cannot run, in words: one for each code, never the code, and no name or value from the definition. */
export const UNAVAILABLE_TEXT: Readonly<Record<(typeof PATTERN_UNAVAILABLE_CODES)[number], string>> = {
  'unknown-entity-type': 'A type it uses is no longer in the mapping.',
  'unknown-relationship-type': 'A relationship type it uses is no longer in the mapping.',
  'relationship-does-not-join': 'A relationship type no longer joins the types of one of its steps.',
  'unknown-property': 'A property it uses is no longer in the mapping.',
  'not-filterable': 'A property it filters on can no longer be filtered.',
  'bad-definition': 'Its definition is no longer one the product accepts.',
  'anchor-changed': 'Its starting entity is of a type the pattern no longer starts at.',
  'preset-removed': 'The built-in pattern it was saved from is no longer in the mapping.',
  'template-changed': 'The template it was saved from changed.',
  'params-invalid': 'Its saved parameters are no longer valid.',
};

export const stepWhere = (path: readonly (string | number)[] | undefined): string => {
  const at = path?.[0] === 'steps' && typeof path[1] === 'number' ? path[1] + 1 : undefined;
  return at === undefined ? '' : ` (step ${at})`;
};

/** A refusal of a saved-pattern route, in a sentence; the codes and reasons are the server's. */
export function refusalText(failure: ApiFailure): string {
  const reason = 'details' in failure && failure.details !== undefined && typeof failure.details['reason'] === 'string' ? failure.details['reason'] : undefined;
  switch (failure.code) {
    case 'INVALID_REQUEST':
      if (reason === 'pattern-limit') return `This source already holds ${PATTERN_LIMITS.patternsPerSource} saved patterns. Delete one first.`;
      if (reason === 'pattern-personal-condition') return 'A condition of this pattern uses a property the mapping marks as personal data, so it cannot be saved, shared or copied.';
      return 'The server did not accept this pattern.';
    case 'CONFLICT':
      return SAVED_COPY.changedByOther;
    case 'NOT_FOUND':
      return SAVED_COPY.gone;
    case 'ACCESS_DENIED':
      return SAVED_COPY.notAllowed;
    case 'AUDIT_UNAVAILABLE':
      return 'The change could not be recorded, so nothing was changed. Try again later.';
    case 'RATE_LIMITED':
      return 'Too many requests. Try again in a moment.';
    default:
      return 'The request could not be made. Try again.';
  }
}
