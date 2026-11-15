import type { SummaryFailureKind } from '@neburyx/contracts';

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
  noSupport: 'Nothing supportable to summarize',
  noSupportBody: 'No sentences had valid citations. No draft is available to copy.',
  noData: 'No data was submitted',
  summarize: 'Summarize',
  entity: 'Entity',
  relationship: 'Relationship',
  sentence: 'Sentence',
  firstCallText: 'text of the first call',
  titleTooLarge: 'View too large',
  titleTimeLimit: 'Took too long',
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
