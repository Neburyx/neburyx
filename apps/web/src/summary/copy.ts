import { NOT_STORABLE_REASONS, type SummaryFailureKind } from '@neburyx/contracts';

type NotStorableReason = (typeof NOT_STORABLE_REASONS)[number];

export const SUMMARY_COPY = {
  title: 'AI case summary',
  close: 'Close',
  drafted: 'AI-drafted',
  notSaved: 'Not saved',
  notAFinding: 'This is not a finding.',
  edited: 'Edited',
  previous: 'Previous draft',
  intro: 'Summarize drafts short, neutral sentences about the elements shown, each citing the elements it rests on.',
  generating: 'Preparing a cited draft',
  graphUnchanged: 'Graph unchanged',
  rule: 'Sentences without a valid citation are removed.',
  coverageTitle: 'Server-authored coverage',
  steps: ['Read through the gate', 'Size checked', 'Drafting', 'Checking citations'],
  cancel: 'Cancel',
  regenerate: 'Regenerate',
  discard: 'Discard',
  askAbout: 'Ask about this summary',
  askNew: 'New',
  askNote: 'Opens the Assistant with this summary as context, for you and this investigation only.',
  tryAgain: 'Try again',
  returnToGraph: 'Return to graph',
  sentences: 'Draft',
  disclosure: 'What the model sees',
  disclosureNote: 'The text sent in the first call, as shown on screen.',
  unavailable: 'The case summary is not available right now.',
  sourceChanged: 'The source changed, so summaries are paused.',
  clearedInvestigation: 'This is another investigation, so the earlier draft is cleared.',
  clearedMasking: 'Masking changed, so the draft is cleared. Summarize again to see it.',
  outsideView: 'Outside the current view',
  gone: 'No longer on the graph',
  select: 'Select on graph',
  timeLimit: 'The draft took longer than the limit.',
  cancelled: 'No draft is shown.',
  noSupport: 'Nothing supportable to summarize',
  noSupportBody: 'No sentences had valid citations. No draft is available to copy.',
  noData: 'No data was submitted',
  summarize: 'Summarize',
  copyToNotes: 'Copy to notes',
  copying: 'Copying…',
  editedNoCopy: "Edited text can't be stored as AI notes.",
  notCopied: 'Not copied',
  alreadyCopied: 'These sentences were copied to notes before.',
  generateAgain: 'Generate the summary again',
  copyFailed: 'The draft could not be saved first, so nothing was copied.',
  copyConflict: 'This view changed somewhere else. Resolve that first, then copy again.',
  notesTitle: 'AI notes',
  notesRebuilt: 'Rebuilt from your own access each time this view opens.',
  notesNone: 'No AI notes are saved with this view.',
  notesLoading: 'Reading the AI notes…',
  notesFailed: 'The AI notes could not be read.',
  notesRefused: 'The AI notes cannot be shown to you.',
  notesSkipped: 'An AI note of this view was not read.',
  notesFull: 'The AI notes of this view cannot take this summary.',
  entity: 'Entity',
  relationship: 'Relationship',
  sentence: 'Sentence',
  firstCallText: 'text of the first call',
  titleTooLarge: 'View too large',
  titleTimeLimit: 'Took too long',
  titleCancelled: 'Cancelled',
  titleFailed: 'The draft could not be produced',
  titleUnavailable: 'Not available',
  titleSourceChanged: 'Source changed',
  titleCleared: 'Draft cleared',
} as const;

export const removedText = (count: number): string => `${sentencesText(count)} removed: ${count === 1 ? 'it' : 'they'} could not be cited`;

export const tooLargeFigure = (elements: number, cap: number): string => `${elements.toLocaleString('en-US')} > ${cap.toLocaleString('en-US')} elements`;

export const TOO_LARGE_ELEMENTS_TEXT = `Narrow the current view before drafting. ${SUMMARY_COPY.noData}, including any partial selection.`;

export const TOO_LARGE_TEXT = `The text of this view is over the size allowed. Narrow the current view before drafting. ${SUMMARY_COPY.noData}.`;

export const sentencesText = (count: number): string => `${count} ${count === 1 ? 'sentence' : 'sentences'}`;

export const copiedText = (copied: number): string => `${copied} ${copied === 1 ? 'sentence' : 'sentences'} copied to notes.`;

/** What each group of reason says of the sentences it holds, written to be true of each sentence in the group (a number or a date, a count that is not known, or a name or a value that cannot be tied to exactly one element or property the sentence cites). */
const NOT_STORED_BECAUSE: Readonly<Record<NotStorableReason | 'other', (count: number) => string>> = {
  number: (count) => `${count} ${count === 1 ? 'involves a number, a date or a count that can\'t be tied to exactly one element it cites' : 'involve a number, a date or a count that can\'t be tied to exactly one element they cite'}`,
  value: (count) => `${count} ${count === 1 ? 'involves a name or a value that can\'t be tied to exactly one element or property it cites' : 'involve a name or a value that can\'t be tied to exactly one element or property they cite'}`,
  word: (count) => `${count} ${count === 1 ? 'uses a word' : 'use words'} outside the fixed list that can be stored`,
  other: (count) => `${count} can't be stored`,
};

/** The sentences of a draft that cannot be stored, grouped by the reason the server gave, in a fixed order. */
export function notStoredReasons(sentences: readonly { readonly storable: boolean; readonly notStorable?: NotStorableReason | undefined }[]): string {
  const counts = new Map<NotStorableReason | 'other', number>();
  for (const sentence of sentences) if (!sentence.storable) counts.set(sentence.notStorable ?? 'other', (counts.get(sentence.notStorable ?? 'other') ?? 0) + 1);
  return [...NOT_STORABLE_REASONS, 'other' as const].flatMap((reason) => (counts.has(reason) ? NOT_STORED_BECAUSE[reason](counts.get(reason) ?? 0) : [])).join('; ');
}

export const notCopiedText = (notCopied: number, total: number, reasons: string): string => `${notCopied} of ${total} ${total === 1 ? 'sentence' : 'sentences'} weren't copied: ${reasons}.`;

export const noneStoredText = (reasons: string): string => `None of these sentences can be stored as AI notes: ${reasons}.`;

export const callsText = (calls: number): string => `${calls} ${calls === 1 ? 'call' : 'calls'} made`;

export const FAILURE_KIND_TEXT: Readonly<Record<SummaryFailureKind, string>> = {
  format: 'The draft could not be put in a usable form.',
  timeout: 'The model took too long to answer.',
  unreachable: 'The model could not be reached.',
  'rate-limited': 'The model is busy. Try again in a moment.',
  refused: 'The model declined to draft this view.',
  truncated: 'The draft was cut off before it was complete.',
  rejected: 'The model service rejected the request.',
  'provider-error': 'The model service reported an error.',
  'bad-reply': 'The model’s reply could not be read.',
};
