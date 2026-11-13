import { ASK_MESSAGE_MAX_LENGTH, type Count } from '@neburyx/contracts';
import { countText } from '../search/count-label.js';

export const ASK_COPY = {
  title: 'Ask',
  placeholder: 'Ask about this investigation…',
  fieldLabel: 'Your question',
  hint: "Don't type customer names; others may see this text.",
  preview: 'Preview',
  send: 'Send',
  editQuestion: 'Edit question',
  close: 'Close Ask',
  receivesTitle: 'What the model will receive',
  receivesNote: 'Names and IDs are replaced with placeholders. Your typed text is never sent, only these words.',
  changedNote: 'The preview changed. Check the new text before sending.',
  pickEntity: 'Pick an entity',
  removeWord: 'Remove the word',
  useValue: 'Use as a search value',
  cancel: 'Cancel',
  retry: 'Try again',
  noInvestigation: 'There is nothing to ask about yet. Open an investigation first.',
  empty: 'Type a question first.',
  tooLong: `The question is longer than ${ASK_MESSAGE_MAX_LENGTH} characters.`,
  asking: 'Checking the question…',
  searching: 'Searching…',
  sending: 'Sending…',
  sentPlan: 'Sent. The plan is ready.',
  maySent: 'The last question may have been sent.',
  awaiting: 'Awaiting clarification · no plan run',
  doYouMean: 'Do you mean',
  picksRefused: 'Your choice no longer fits the text. Pick again.',
  pickLimit: 'Ten choices is the most. Remove a word or edit the question.',
  pickerSearch: 'Search for the word',
  pickerSearchButton: 'Search',
  pickerEmpty: 'Nothing was found for this word in this source.',
  pickerNoReference: 'Found, but it has no reference, so it cannot be chosen.',
  unavailable: 'Ask is not available right now.',
} as const;

export const notSentText = (words: number): string => (words === 1 ? 'Not sent · 1 word needs attention' : `Not sent · ${words} words need attention`);

export const blockedTitle = (word: string): string => `“${word}” can't be sent to the model`;

export const BLOCKED_MANY = "These words can't be sent to the model";

export const pickerTitle = (word: string): string => `Choose an entity for “${word}”`;

/** The count of fitting entities beside the chips, in the search's own count words: nothing when the chips show them all or the count is not exact or a lower bound. */
export const moreChoicesText = (shown: number, count: Count): string | undefined => {
  const text = countText(count);
  if (text === undefined || count.value === undefined || count.value <= shown) return undefined;
  return `${shown} shown of ${text}`;
};
