import { ASK_MESSAGE_MAX_LENGTH, type AskRefusalFamily, type Count } from '@neburyx/contracts';
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
  patternsTitle: 'Your saved patterns, listed for the model',
  patternsNote: 'Only their structure goes, and a name only when every word of it is allowed. Nothing from the data goes.',
  patternsCut: 'More saved patterns exist than are listed here.',
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
  refused: 'Not answered · refused',
  refusalTitle: 'This question was not answered',
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

/** What the investigator can do instead, by the kind of refusal; the server's sentence says why, this says what, and the names of the tools are the client's. */
export const PATHS_LINE = 'Open Paths to see how two entities are connected.';

export const REFUSAL_LINES: Readonly<Record<AskRefusalFamily, string>> = {
  path: 'Expand each entity and follow its relationships.',
  'property-selection': 'Filters narrows the loaded items by type, not by a value. Search also matches the values of indexed properties.',
  'similar-records': 'Expand an entity and compare the entities around it.',
  'ranking-or-aggregate': 'There is no alternative for this in this release.',
  'attribute-combination': 'Expand an entity and look at its properties and its neighbours side by side.',
  'indirect-attribute': 'Expand the entity and open the one it is linked to.',
  'unnamed-relation': 'Expand an entity and look at the relationships it has.',
  judgement: 'Look at what connects the entities and at the evidence of each relationship.',
  'personal-data': 'If you have a stable ID, search for it.',
  'loaded-view': 'There is no alternative for this in this release.',
  other: 'Search by stable ID, narrow with Filters, or expand an entity.',
  'plan-not-usable': 'Search by stable ID, narrow with Filters, or expand an entity.',
  'model-refused': 'Search by stable ID, narrow with Filters, or expand an entity.',
};
