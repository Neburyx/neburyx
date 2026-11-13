import { PATTERN_LIMITS, type PATTERN_UNAVAILABLE_CODES } from '@neburyx/contracts';
import type { ApiFailure } from '../../api/client.js';
import { nameTakenSentence, patternLimitSentence, personalConditionSentence } from '../failure-words.js';

export const TABS = ['mine', 'shared', 'built-in'] as const;
export type Tab = (typeof TABS)[number];

export const SAVED_COPY = {
  tabs: 'Patterns',
  mine: 'My patterns',
  shared: 'Shared on this source',
  builtIn: 'Built-in',
  footnote: 'Shared patterns can be run or copied. Only their owner can change or delete them.',
  searchLabel: 'Search patterns',
  noBuiltIn: 'This source has no built-in patterns.',
  noneInSection: 'No pattern in this section matches the search.',
  searchLoadedOnly: 'The search covers the patterns loaded so far.',
  privateBadge: 'Private',
  sharedBadge: 'Shared',
  sharedBy: (owner: string): string => `shared by ${owner}`,
  ownedBy: (owner: string): string => `Owned by ${owner}. Only the owner can:`,
  ownerOnly: 'owner only',
  loading: 'Loading saved patterns…',
  emptyMine: 'Start from a built-in pattern, or create your own. Saved patterns appear here.',
  newPattern: 'New pattern',
  seeBuiltIn: 'See built-in',
  emptyShared: 'Nobody has shared a pattern on this source.',
  loadMore: 'Load more',
  cursorReset: 'The list changed while you were reading it, so it was read again from the start.',
  notRun: 'Not run yet',
  builtInKind: 'Built in this panel',
  onlyMe: 'Only me',
  everyone: 'Everyone on this source',
  unavailable: 'Pattern out of date',
  changePattern: 'Change pattern',
  copyAndChange: 'Copy and change',
  copyAndChangeNote: 'A pattern shared by someone else can be copied first.',
  outOfDateLine: 'Change the pattern to fix it.',
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
  nameRule: `1 to ${PATTERN_LIMITS.nameLength} characters. Names are unique among your patterns on this source.`,
  onlyMeLine: 'Private. It appears under My patterns.',
  everyoneLine: 'Others can run and copy it. They cannot change or delete it.',
  saveButton: 'Save',
  saveDialog: 'Save pattern',
  saveText: 'Saves the pattern and its parameters, never query text. Running it applies your own access and limits.',
  askEachTime: 'Ask for the starting entity each time',
  keepsEntity: 'The pattern keeps the starting entity it holds.',
  askEachTimeForced: 'No starting entity is chosen, so the pattern will ask for one each time.',
  visibility: 'Who can use it',
  saved: 'Pattern saved.',
  savedNotShared: 'Pattern saved, but not shared.',
  renamed: 'Pattern renamed.',
  copied: 'Pattern copied.',
  sharedDone: 'Pattern shared with everyone on this source.',
  unsharedDone: 'Pattern is private again.',
  deleted: 'Pattern deleted.',
  shareConfirm: 'Everyone on this source will be able to run and copy this pattern. They cannot change or delete it.',
  shareTitle: 'Share this pattern?',
  deleteConfirmPrivate: 'This pattern is private to you. It is removed from My patterns and cannot be recovered.',
  deleteConfirmShared: 'This pattern is shared with everyone on this source. Deleting it removes it for all of them, and it cannot be recovered. Patterns they copied are not affected.',
  deletePattern: 'Delete pattern',
  deleteEveryone: 'Delete for everyone',
  changeSharedLine: 'Others on this source run this pattern. Save for everyone?',
  saveAsCopy: 'Save as a copy',
  saveForEveryone: 'Save for everyone',
  changedMeanwhile: 'This pattern was changed by someone else after you opened it. Your edits are kept. You can save them as a copy.',
  copySaved: 'Saved as a copy.',
  copyFailed: 'The copy could not be saved.',
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
  changeUnplaced: 'This part of the pattern cannot be shown because the mapping no longer has it.',
  changeLine: 'Changing a saved pattern. Save changes keeps it where it is; Save as new makes another.',
} as const;

export const deleteTitle = (name: string): string => `Delete “${name}”?`;
export const changeSharedTitle = (name: string): string => `Save changes to “${name}”?`;

export const nameLimitText = `Enter a name of 1 to ${PATTERN_LIMITS.nameLength} characters.`;

/** The reasons a saved pattern cannot run, in words: one for each code, never the code, and no name or value from the definition. */
export const UNAVAILABLE_TEXT: Readonly<Record<(typeof PATTERN_UNAVAILABLE_CODES)[number], string>> = {
  'unknown-entity-type': 'This pattern uses a type the mapping no longer has.',
  'unknown-relationship-type': 'This pattern uses a relationship type the mapping no longer has.',
  'relationship-does-not-join': 'A relationship type this pattern uses no longer joins the types of its step.',
  'unknown-property': 'This pattern uses a property the mapping no longer allows.',
  'not-filterable': 'This pattern filters on a property the mapping no longer lets it filter on.',
  'bad-definition': 'This pattern is no longer one the product accepts.',
  'anchor-changed': 'The starting entity of this pattern is of a type it no longer starts at.',
  'preset-removed': 'The built-in pattern this was saved from is no longer in the mapping.',
  'template-changed': 'The template this pattern was saved from changed.',
  'params-invalid': 'The saved parameters of this pattern are no longer valid.',
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
      if (reason === 'pattern-limit') return patternLimitSentence;
      if (reason === 'pattern-personal-condition') return personalConditionSentence;
      return 'The server did not accept this pattern.';
    case 'CONFLICT':
      return reason === 'pattern-name-taken' ? nameTakenSentence : SAVED_COPY.changedByOther;
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

/** Whether a refusal says the name is used by another of the person's patterns on the source: the dialog stays open and nothing is read again. */
export const isNameTaken = (failure: ApiFailure): boolean => failure.code === 'CONFLICT' && 'details' in failure && failure.details !== undefined && failure.details['reason'] === 'pattern-name-taken';
